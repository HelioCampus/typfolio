/**
 * Shared live PDF mode (used by both routes): continuously captures frames, compiles them on a pool of
 * `@typfolio/workers` compiler workers and paints the PDF with pdf.js, so the
 * PDF preview animates while the main thread stays free for layout and pointer input.
 *
 * Scheduling:
 * - The pool is `createWorkerClient({ workerCount })`. The session runs one
 *   "lane" per worker; a lane is a demand-driven loop: acquire the newest frame
 *   -> tag it with a sequence number -> compile -> offer the PDF to the
 *   presenter -> repeat. A frame is captured exactly when a pool slot frees up,
 *   so there is never more work in flight than workers (no queue, no flooding).
 * - Compiles finish out of order. The presenter is latest-wins: it keeps one
 *   pending PDF, renders one at a time, and drops any PDF older than the newest
 *   one already shown or being painted. A stale frame is never shown after a
 *   newer one.
 * - Stale work is skipped, not aborted: aborting an active job terminates its
 *   worker (hard cancellation of synchronous WASM) and costs a WASM
 *   re-instantiation, so the abort signal is reserved for shutdown.
 *
 * This module is loaded lazily (dynamic import) so pdf.js and the worker
 * client stay out of the route chunk until the toggle is switched on.
 */
import { createWorkerClient, type PdfWorkerClient } from '@typfolio/workers';
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfDocument } from '@typfolio/core';
import { loadWasm } from '../assets.ts';

export interface LiveStats {
  readonly poolSize: number;
  /** Median ms to produce + serialise a frame in JS (pretext widths, centering, JSON). */
  readonly layoutMs: number;
  /** Median ms for the worker round trip: Typst compile plus message transfer. */
  readonly compileMs: number;
  /** Median ms for pdf.js to parse the PDF and paint it to the canvas. */
  readonly renderMs: number;
  /** PDFs actually painted per second over the last second. */
  readonly fps: number;
  /** Compiles finished per second over the last second (painted or dropped). */
  readonly compileFps: number;
  /** PDFs compiled but never shown because a newer one won. */
  readonly dropped: number;
  readonly frames: number;
  /** Time to start every pool worker and finish its first compile. */
  readonly warmupMs: number;
}

/** What a route hands the pipeline per captured frame. */
export interface Captured<T> {
  readonly frame: T;
  /** Time the route spent producing this frame's layout, in ms (shown as "pretext layout"). */
  readonly layoutMs: number;
}

export interface LiveSessionOptions<T> {
  readonly fonts: readonly string[];
  readonly canvas: HTMLCanvasElement;
  /** Pixels per PDF point to rasterise at (device pixel ratio). */
  readonly scale: number;
  readonly poolSize: number;
  /** Iterations of a pure Typst script loop per frame: a synthetic compile load for benchmarking. */
  readonly burn: number;
  /** Builds the document to compile for a frame; `burn` is the synthetic load knob. */
  readonly buildDocument: (frame: T, burn: number) => PdfDocument;
  /** Resolves with the next frame to capture, or `undefined` once `signal` aborts. */
  readonly acquireFrame: (signal: AbortSignal) => Promise<Captured<T> | undefined>;
  readonly onStats: (stats: LiveStats) => void;
  readonly onError: (error: unknown) => void;
}

/** The most recently presented frame: the exact bytes Typst produced. Only the latest is retained. */
export interface LatestFrame {
  readonly bytes: Uint8Array;
  readonly pages: number;
  /** `performance.now()` when its compile finished. */
  readonly compiledAt: number;
  readonly seq: number;
}

export interface LiveSession {
  start(): void;
  /** The frame currently displayed (or, with painting off, the newest one presented). */
  latest(): LatestFrame | undefined;
  /** Turns pdf.js painting on/off (off while another view, e.g. the native viewer, is showing). */
  setPaint(enabled: boolean): void;
  /** Changes the pdf.js raster scale (pixels per PDF point) from the next painted frame on. */
  setScale(scale: number): void;
  /** Stops capturing, aborts in-flight compiles, and frees the pool. */
  dispose(): Promise<void>;
}

const WINDOW = 60;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface Compiled {
  readonly seq: number;
  readonly bytes: Uint8Array;
  readonly compiledAt: number;
}

export async function createLiveSession<T>(options: LiveSessionOptions<T>): Promise<LiveSession> {
  const warmupStartedAt = performance.now();
  const wasm = await loadWasm();
  // One shared pdf.js worker: without it every getDocument() spawns (and parses) a new 1.2 MB worker.
  const pdfWorker = new pdfjs.PDFWorker({
    // The shipped typings declare `port` as null although a Worker is accepted.
    port: new Worker(pdfjsWorkerUrl, { type: 'module' }) as unknown as null,
  });
  const client: PdfWorkerClient = createWorkerClient({
    compiler: { wasm, fonts: options.fonts },
    workerCount: options.poolSize,
    // One lane per worker, so a job never waits in the queue.
    queueLimit: options.poolSize,
    timeoutMs: 10_000,
  });

  const abort = new AbortController();
  try {
    // Workers start lazily: one concurrent warm-up compile per worker instantiates every WASM module.
    const warmFrame = await options.acquireFrame(abort.signal);
    if (warmFrame !== undefined) {
      const warmDocument = () => options.buildDocument(warmFrame.frame, options.burn);
      await Promise.all(Array.from({ length: options.poolSize }, () => client.compile(warmDocument(), { validate: false })));
    }
  } catch (error) {
    pdfWorker.destroy();
    await client.dispose();
    throw error;
  }
  const warmupMs = performance.now() - warmupStartedAt;

  // Double buffering: pdf.js paints into a detached canvas that is blitted
  // to the visible one in a single drawImage, so the preview never flickers.
  const back = document.createElement('canvas');
  const front = options.canvas;
  const frontContext = front.getContext('2d');
  if (frontContext === null) throw new Error('2D canvas context is not available');

  let scale = options.scale;
  let paintEnabled = true;
  let shown: LatestFrame | undefined;
  let running = false;
  let stopped = false;
  let lanes: Promise<void>[] = [];

  const fail = (error: unknown): void => {
    if (!running) return;
    running = false;
    abort.abort('live PDF pipeline failed');
    options.onError(error);
  };

  const layout: number[] = [];
  const compile: number[] = [];
  const render: number[] = [];
  const presented: number[] = [];
  const compiled: number[] = [];
  let frames = 0;
  let dropped = 0;
  let lastReport = 0;
  const push = (list: number[], value: number): void => {
    list.push(value);
    if (list.length > WINDOW) list.shift();
  };
  const trim = (list: number[], now: number): void => {
    while (list.length > 0 && now - list[0]! > 1000) list.shift();
  };
  const rate = (list: number[], now: number): number =>
    list.length > 1 ? ((list.length - 1) * 1000) / Math.max(1, now - list[0]!) : 0;

  const report = (now: number): void => {
    if (now - lastReport < 200) return;
    lastReport = now;
    trim(presented, now);
    trim(compiled, now);
    options.onStats({
      poolSize: options.poolSize,
      layoutMs: median(layout),
      compileMs: median(compile),
      renderMs: median(render),
      fps: rate(presented, now),
      compileFps: rate(compiled, now),
      dropped,
      frames,
      warmupMs,
    });
  };

  /** Returns the page count. pdf.js takes ownership of the data it is given, so it gets a copy. */
  const paint = async (bytes: Uint8Array): Promise<number> => {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      worker: pdfWorker,
      // Glyph outlines instead of per-document FontFace registration: much cheaper per frame.
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale });
      if (back.width !== Math.ceil(viewport.width)) back.width = Math.ceil(viewport.width);
      if (back.height !== Math.ceil(viewport.height)) back.height = Math.ceil(viewport.height);
      await page.render({ canvas: back, viewport }).promise;
      if (front.width !== back.width) front.width = back.width;
      if (front.height !== back.height) front.height = back.height;
      frontContext.drawImage(back, 0, 0);
      page.cleanup();
      return document.numPages;
    } finally {
      await task.destroy();
    }
  };

  // --- latest-wins presenter: one pending PDF, one paint at a time ---
  let newestSeq = -1; // newest sequence number shown or currently being painted
  let pending: Compiled | undefined;
  let presenting = false;

  const present = async (): Promise<void> => {
    presenting = true;
    try {
      while (pending !== undefined && running) {
        const item = pending;
        pending = undefined;
        if (item.seq < newestSeq) {
          dropped++;
          continue;
        }
        newestSeq = item.seq;
        const startedAt = performance.now();
        // Only the latest frame's bytes are ever retained (downloads, native viewer).
        shown = { bytes: item.bytes, pages: shown?.pages ?? 1, compiledAt: item.compiledAt, seq: item.seq };
        if (paintEnabled) {
          const pages = await paint(item.bytes);
          shown = { ...shown, pages };
        }
        const doneAt = performance.now();
        push(render, doneAt - startedAt);
        presented.push(doneAt);
        frames++;
        report(doneAt);
      }
    } finally {
      presenting = false;
    }
  };

  const offer = (item: Compiled): void => {
    if (item.seq < newestSeq) {
      dropped++; // finished out of order: a newer frame is already on screen
      return;
    }
    if (pending !== undefined) {
      if (pending.seq > item.seq) {
        dropped++;
        return;
      }
      dropped++; // the pending PDF was superseded before it was painted
    }
    pending = item;
    if (!presenting) void present().catch(fail);
  };

  let nextSeq = 0;
  const lane = async (): Promise<void> => {
    while (running) {
      const captured = await options.acquireFrame(abort.signal);
      if (captured === undefined || !running) return;
      const seq = nextSeq++;

      const captureStartedAt = performance.now();
      const document = options.buildDocument(captured.frame, options.burn);
      push(layout, captured.layoutMs + (performance.now() - captureStartedAt));

      const compileStartedAt = performance.now();
      let bytes: Uint8Array;
      try {
        bytes = (await client.compile(document, { signal: abort.signal, validate: false })).bytes;
      } catch (error) {
        if (!running) return;
        throw error;
      }
      const doneAt = performance.now();
      push(compile, doneAt - compileStartedAt);
      compiled.push(doneAt);
      offer({ seq, bytes, compiledAt: doneAt });
    }
  };

  return {
    latest: () => shown,
    setPaint(enabled) {
      paintEnabled = enabled;
    },
    setScale(next) {
      scale = next;
    },
    start() {
      if (running || stopped) return;
      running = true;
      lanes = Array.from({ length: options.poolSize }, () => lane().catch(fail));
    },
    async dispose() {
      if (stopped) return;
      stopped = true;
      running = false;
      abort.abort('live PDF mode stopped');
      // A lane parked on a hidden tab's rAF would never settle; do not wait for it forever.
      await Promise.race([Promise.allSettled(lanes), new Promise(resolve => setTimeout(resolve, 500))]);
      await client.dispose();
      pdfWorker.destroy();
    },
  };
}
