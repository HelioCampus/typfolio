# pretext × Typfolio: hybrid layout

Two [pretext](https://github.com/chenglou/pretext) demos reproduced as Typst-rendered PDFs. This is a verification fixture and a showcase, not a Typfolio package.

    npm run dev:pretext        # http://127.0.0.1:4190

| Route | Demo | What the PDF contains |
|---|---|---|
| `/` | Variable typographic ASCII | One page (or an 8-page flipbook) of proportional ASCII art, glyph by glyph |
| `/editorial` | The editorial engine | Headline, drop cap, three-column body flowing around five orbs, pull quotes |

## The hybrid pipeline

```
 browser                                              WASM (same thread)
 ┌───────────────────────────────┐   JSON input   ┌─────────────────────────┐
 │ pretext: measure + line-break │ ─────────────▶ │ Typst: place() + draw   │ ─▶ PDF bytes
 │ (canvas, Libertinus Serif)    │  positioned    │ (no line breaking, no   │
 │ obstacles, columns, rows      │  lines, glyphs │  centering, no flow)    │
 └───────────────────────────────┘  orbs, colours └─────────────────────────┘
        live DOM frame  ◀── same layout object ──▶  captured JSON
```

- **Layout is JavaScript.** pretext decides where every line breaks, how wide it is and where it sits. `src/editorial/engine.ts` and `src/ascii/engine.ts` are pure: they return plain data.
- **Rendering is Typst.** Each template (`asciiTemplate` in `src/ascii/capture.ts`, `editorialTemplate` in `src/editorial/capture.ts`) is a loop of absolutely positioned `place(top + left, dx:, dy:, ...)` calls. Typst never breaks a line or centres a row.
- **One layout object feeds both sides.** The live DOM renderer and the JSON capture read the same frame, so the PDF is exactly the frozen live panel. "Capture" freezes the animation on the frame it serialised.
- Both templates are inline strings in `template.files`; the compiler has no remote package imports.

## Live PDF mode

Both routes have a **Live PDF mode** switch that makes the PDF preview itself animate. The machinery is shared (`src/live/`):

```
 route (rAF + pointer input)          src/live/session.ts                         browser
 ┌────────────────────────┐   frame   ┌────────────────────────────────┐   ┌──────────────────────┐
 │ pretext layout of the  │ ────────▶ │ one lane per pool worker:      │   │ pdf.js worker        │
 │ newest animated frame  │  (slot    │ acquire frame → seq → compile  │──▶│ latest-wins presenter│─▶ <canvas>
 │ (DOM keeps animating)  │   free)   │ on @typfolio/workers pool      │   │ (drops stale frames) │
 └────────────────────────┘           └────────────────────────────────┘   └──────────────────────┘
```

- **Workers, not the main thread.** Frames compile on `createWorkerClient({ workerCount })`, so the live DOM never janks. The pool size (1-4) is a control.
- **Demand-driven.** A lane captures the newest frame only when its pool slot is free (capture → compile → hand over → capture again). There is no rAF-driven flooding and never more compiles in flight than workers. Frames produced while all slots are busy are simply never submitted.
- **Latest wins, in order.** Every captured frame gets a sequence number. Compiles finish out of order; the presenter keeps one pending PDF, paints one at a time, and drops any PDF older than the newest one already shown or being painted (the *dropped* counter).
- **pdf.js to a canvas**, double-buffered (paint offscreen, one `drawImage`), instead of re-instantiating an `<iframe>` viewer per frame. One shared pdf.js worker; `disableFontFace` so each frame's fonts are glyph outlines rather than new `FontFace`s.
- **Stale work is skipped, not aborted.** Aborting an active job terminates its worker (hard cancellation of synchronous WASM) and a fresh worker re-instantiates the WASM, so the abort signal is used only at shutdown.
- **Controls and stats.** Pool size, *Extra load* (a pure Typst script loop added to every frame so pool scaling is visible when a frame compiles in milliseconds), and *Uncapped* (advance the simulation whenever a slot frees instead of once per display frame). Stats: pretext layout ms, Typst compile ms (worker round trip), pdf.js render ms, painted fps, compile throughput, dropped frames, pool warm-up.
- **Dragging inside the PDF.** On the editorial route you can drag (and click to pause) the orbs directly on the live PDF canvas, and the text reflows around them as you move. On the ASCII route the pointer over the canvas acts as a particle attractor. This interaction layer is ordinary page-level pointer handling over the pdf.js canvas (pointer capture, coordinates mapped from canvas CSS size to stage units, hit-testing against the *current* engine state): the PDF itself is static for each frame and is simply re-typeset about 20-60 times per second. Exported PDF files are not interactive. The rasterisation scale drops to 0.6x while an orb is held, for a higher interactive frame rate. The DOM-stage drag keeps working as before.

### Three ways to view the same bytes

The live panel's **View** switch shows the PDF Typst just produced in three ways. They are the same bytes:

| Mode | What it is | Live? | Drag on the PDF |
|---|---|---|---|
| **Fast** | The bare pdf.js canvas | every frame | yes |
| **Viewer** | The same live canvas inside viewer chrome we draw ourselves: toolbar (document name, `page / pages`, zoom), gray backdrop, the page as a shadowed sheet | every frame | yes |
| **Native** | Chrome's built-in PDF viewer in an `<iframe>` on an object URL | snapshot: **Refresh** button, or an opt-in 2 s auto-refresh | no |

- Viewer zoom is a CSS resize of the live canvas; when zoom settles (400 ms) the canvas is re-rasterised at the new size, so the live loop never restarts.
- Native cannot follow frames: re-pointing Chrome's viewer re-instantiates it per frame (flicker, lost zoom/scroll), and the viewer owns pointer input, so dragging is unavailable there. While Native is shown, pdf.js painting pauses and the compile pipeline keeps running.
- The non-live result of "Capture frame" / "Flipbook" has the same switch (Viewer or Native). Viewer stacks every page vertically with scrolling and a live `page / pages` indicator; Native is the original `<iframe>`.

**Proof it is a PDF**, visible in every mode:

- **Download frame** saves the exact bytes of the displayed frame (`typfolio-ascii-frame.pdf`, `typfolio-editorial-frame.pdf`). The downloaded file is the ground truth: open it in any viewer or run `pdftotext`/`pdfinfo` on it.
- **Open in tab** opens the same bytes full-page in the browser's own viewer.
- The info line reads `PDF · 48 KB · 1 page · compiled 4 ms ago`: size from the byte array's length, page count from pdf.js, age since the compile finished.
- Only the latest frame's bytes are retained (one buffer, replaced each frame); downloads and Native snapshots copy from it on demand.

The single "Capture frame as PDF" button still compiles on the main thread through `@typfolio/react` and shows the result in an `<iframe>`.

## Font parity

pretext measures through canvas with the fonts the browser has; Typst lays out with the font files the compiler was given. `src/assets.ts` names each Libertinus Serif face by URL and uses the **same files twice**: `new FontFace('Libertinus Serif', 'url(...)', { weight, style })` registered (and awaited) before any `prepare*` call, and `createCompiler({ fonts })` / `createWorkerClient({ compiler: { fonts } })`, which fetch those URLs themselves (inside each worker for the live pool). Demo `px` are `pt` 1:1 in the PDF, and the page is the stage size.

Other details that keep the two renderers identical:

- **Baselines come from the DOM.** A zero-size inline-block probe styled like each text style reports where the browser puts the baseline (half-leading included). Templates use `top-edge/bottom-edge: "baseline"` and place at `y + baseline`.
- **ASCII art disables kerning and ligatures on both sides** (`font-kerning: none` / `kerning: false`) because every cell advance is an independently measured glyph width. The editorial body text keeps default kerning and ligatures on both sides.
- The ASCII rows report the row width the browser actually laid out next to pretext's predicted sum; it agrees to about 0.15 px (sub-pixel layout rounding in the browser).
- Spaces in the ASCII art are `h(width)` gaps, not literal spaces: Typst markup would collapse them.

Fonts: `fixtures/fonts/LibertinusSerif-{Regular,Bold}.otf` come from `typst-assets`; `-Italic.otf` and `-BoldItalic.otf` (used by the pull quotes) were added from the official Libertinus v7.051 release. The first two are byte-identical to the release.

## Not a one-to-one port

- The stage is a fixed logical size (1200x760 or 860x760) instead of the browser viewport, so it can size a PDF page. The narrow-viewport mode and text-selection handling from the original are omitted.
- The orbs' CSS `box-shadow` glow has no Typst equivalent; it is approximated by a radial gradient sampled from the same Gaussian falloff.
- Body text is 19 px Libertinus Serif (the original uses an 18 px Iowan/Palatino stack).
- The mid-word breaks ("docum / ents") in narrow slots come from the original algorithm.

## Credits

- [pretext](https://github.com/chenglou/pretext) by Cheng Lou, MIT: the `@chenglou/pretext` package, plus the demo algorithms and the editorial text, reimplemented here from `pages/demos/` (`variable-typographic-ascii.ts`, `editorial-engine.ts`).
- [Libertinus](https://github.com/alerque/libertinus), SIL Open Font License 1.1 (license text in `fixtures/fonts/NOTICE.typst-assets`).
- Typst, via the pinned compiler in `@typfolio/core`.
