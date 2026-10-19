// Manual browser smoke test: runs both capture adapters for real (including the
// html2canvas default rasterizer) and compiles the captured assets into a PDF.
import { createCompiler, defineTemplate } from '@typfolio/core';
import type { PdfResult } from '@typfolio/core';
import { captureAssets, captureProps, type CaptureMarker } from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';
import fontUrl from '../../fixtures/fonts/LibertinusSerif-Regular.otf?url';

// The captured references are the template's data: `schemaPath` mounts it at /input.json, where the Typst reads it.
const captureReport = defineTemplate({
  files: {
    'main.typ': `
#let input = json("/input.json")
#set text(font: "Libertinus Serif", lang: "en")
#set document(title: "Capture smoke")
= Capture smoke
#for figure in input.figures.values() {
  image(figure.path, alt: figure.altText, width: 60%)
}
`,
  },
  schemaPath: 'input.json',
});

const pixelRatio = 2;
const output = document.querySelector<HTMLElement>('#result')!;
const captured = document.querySelector<HTMLElement>('#captured')!;

function mark(selector: string, marker: CaptureMarker) {
  const element = document.querySelector<HTMLElement>(selector)!;
  for (const [name, value] of Object.entries(captureProps(marker))) element.setAttribute(name, value);
  return element;
}

async function inspectPng(bytes: Uint8Array) {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4 * 97) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
  return { width: bitmap.width, height: bitmap.height, distinctSampledColors: colors.size };
}

function show(bytes: Uint8Array, type: string, label: string) {
  const image = new Image();
  image.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  image.alt = label;
  image.height = 120;
  captured.append(image);
}

try {
  mark('#chart', { id: 'chart', kind: 'svg', altText: 'Three bars rising from left to right.' });
  const card = mark('#card', { id: 'summary-card', kind: 'png', altText: '72% of students met the goal.' });

  const result = await captureAssets(document.querySelector<HTMLElement>('#report')!, {
    adapters: { svg: svgCapture(), png: domPngCapture({ pixelRatio, backgroundColor: null }) },
    require: ['chart', 'summary-card'],
  });

  const svg = new TextDecoder().decode(result.assets['captures/chart.svg']);
  const pngBytes = result.assets['captures/summary-card.png'];
  const png = await inspectPng(pngBytes);
  const cardBounds = card.getBoundingClientRect();
  show(result.assets['captures/chart.svg'], 'image/svg+xml', 'Captured SVG');
  show(pngBytes, 'image/png', 'Captured PNG');

  const checks: Record<string, boolean> = {
    pngSignature: [...pngBytes.subarray(0, 4)].join(' ') === '137 80 78 71',
    pngMatchesElementSize: Math.abs(png.width - cardBounds.width * pixelRatio) <= 2 &&
      Math.abs(png.height - cardBounds.height * pixelRatio) <= 2,
    pngIsNotBlank: png.distinctSampledColors > 8,
    svgIsStandalone: svg.startsWith('<svg') && svg.includes('xmlns="http://www.w3.org/2000/svg"'),
    svgInlinesComputedFill: svg.includes('rgb(47, 111, 79)'),
  };

  const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  const compiler = await createCompiler({ wasm: wasmUrl, fonts: [font] });
  let pdf: PdfResult;
  try {
    pdf = await compiler.compile(captureReport({ figures: result.references }), {
      assets: result.assets,
      pdf: { standards: ['ua-1'] },
    });
  } finally { await compiler.dispose(); }
  checks.pdfCompiledWithBothImages = new TextDecoder().decode(pdf.bytes.subarray(0, 5)) === '%PDF-';

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([pdf.bytes as BlobPart], { type: 'application/pdf' }));
  link.textContent = `Open compiled PDF (${pdf.bytes.length} bytes)`;
  link.target = '_blank';
  captured.append(link);

  output.textContent = JSON.stringify({
    checks,
    png: { bytes: pngBytes.length, ...png, element: { width: cardBounds.width, height: cardBounds.height } },
    svgBytes: svg.length,
    references: result.references,
    pdf: { bytes: pdf.bytes.length, diagnostics: pdf.diagnostics },
  }, null, 2);
  output.dataset.status = Object.values(checks).every(Boolean) ? 'passed' : 'failed';
} catch (caught) {
  const error = caught as { stack?: string; cause?: { stack?: string } };
  output.textContent = `${error.stack ?? error}${error.cause ? `\ncause: ${error.cause.stack ?? error.cause}` : ''}`;
  output.dataset.status = 'failed';
}
