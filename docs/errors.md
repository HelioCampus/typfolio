# Errors

A failed compile rejects with a `TypstPdfError` (`TypfolioWorkerError` from the worker client). Its `code` says what kind of failure it is, and its `diagnostics` say where. A diagnostic that Typfolio recognises carries a `code` of its own, the facts as fields, and a one-line message with a link to its section below. Switch on `code`, not on the message text: messages may change, codes do not.

```ts
try {
  await client.compile(request);
} catch (error) {
  const missing = error.diagnostics?.filter(d => d.code === 'missing-glyph').map(d => d.text) ?? [];
  if (missing.length) notify(`The PDF's fonts can't draw ${missing.join(' ')}`);
}
```

## Error codes

| `error.code` | When |
|---|---|
| `INVALID_INPUT` | Data does not match its schema (a template made with `defineTemplate`). The message names the input and lists the issues; `error.issues` has them all. |
| `INVALID_REQUEST` | The request is malformed: a missing input or partial's data, an unknown partial, a bad path, data that is not JSON. |
| `UNSUPPORTED_OPTION` | An option this compiler does not support, such as two PDF standards at once. |
| `COMPILATION` | Typst could not compile the template, or the PDF failed a standard's checks. See `diagnostics`. |
| `INITIALIZATION` | The WASM module or a font could not be loaded. |
| `BUSY`, `DISPOSED`, `ABORTED`, `ENGINE` | The compiler was in use, disposed, the compile was cancelled, or the compiler failed unexpectedly. |

## Diagnostic codes

### file-not-found

A template reads a file the request does not carry: an `#import`, a `json(...)`, an `image(...)`. `diagnostic.file` is the missing file and `diagnostic.path` the file that reads it.

```text
File not found: /common/header.typ (read by /outcomes/main.typ). See …#file-not-found
```

A template compiles from the files it declares and nothing else. What to do depends on the file:

- **A Typst file** (`.typ`) with no data of its own: add it to the template's `files`.
- **A Typst file that reads data of its own** (its own `input(json.with(...))`): make it a partial (`definePartial`) and add it to the template's `partials`; the request then carries its data in `partials.<key>`.
- **A JSON file at a schema path** (`*.schema.json`): it is the input of a partial whose data the request does not carry. Add the partial to the template's `partials` and its data to the request's `partials`.
- **Anything else** (an image, a JSON file of your own): add it to the request's `assets`, or attach it (`createAttachments()`, `usePdf`'s `attach`) and put the path in the data.

### missing-glyph

A character in the document is in none of the loaded fonts, and a PDF standard (`ua-1`, `a-2b` and others) refuses it. `diagnostic.text` is the character. There is one diagnostic per character.

```text
PDF/UA-1 error: the text `"王"` could not be displayed with font `"Open Sans"`. See …#missing-glyph
```

Without a standard Typst draws the character as a blank gap (or the font's empty box) and reports nothing; a standard turns that into this error. To print it, load a font that covers it: `fonts` is the only source of glyphs, and Typst falls back through every loaded font in order. A font for a large script (CJK) is several megabytes, so an application may load it only when the data needs it.
