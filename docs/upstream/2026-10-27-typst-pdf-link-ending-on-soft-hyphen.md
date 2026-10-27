# typst-pdf 0.15.1: a link whose text ends on a soft hyphen cannot be exported

Status: not filed. Found 2026-10-26 by the paramdoc fuzz (`experiments/paramdoc`, G52 in its `GAPS.md`); reproduced
on a plain file on 2026-10-27. No existing issue found for the message on 2026-10-27.

Versions: `typst`, `typst-layout` and `typst-pdf` 0.15.1 from crates.io, as pinned in
`experiments/paramdoc/export/Cargo.toml`; `typst_pdf::pdf` with `PdfOptions::default()` (tagged output on).

## Reproduction

`2026-10-27-typst-pdf-link-ending-on-soft-hyphen/main.typ`:

```typst
#set page(width: 60mm, height: 40mm, margin: 5mm)
#set text(font: "Libertinus Serif", size: 11pt, hyphenate: false)
#link("https://example.org")[Open the student portal\u{ad}]
```

Compiled and exported with the pinned crates through the paramdoc exporter's plain mode, from
`experiments/paramdoc`:

```sh
cargo run -p paramdoc-export -- ../../docs/upstream/2026-10-27-typst-pdf-link-ending-on-soft-hyphen --plain-pdf /tmp/out.pdf
```

Output:

```
error: pdf export failed: [SourceDiagnostic { severity: Error, message: "internal error: expected link ancestor in
logical tree (occurred at typst-pdf-0.15.1/src/link.rs:107:10)", hints: ["please report this as a bug", ...] }]
```

Compilation succeeds; the PDF export fails. Two controls, same file otherwise:

| Text | Result |
|---|---|
| `Open the student portal\u{ad}` without the `link` | exports; the hyphen is drawn after "portal" and extracted as U+00AD |
| a `link` whose text has a soft hyphen at a line end but not at its end (`…appeals pro\u{ad}cedure…`, the box 50 mm wide) | exports; the hyphen is drawn inside the link |

## Where it goes wrong

- `typst-layout/src/inline/line.rs`, `line()`: when the line's full text ends on a soft hyphen (`Dash::Soft`,
  line 141), the hyphen is shaped as a text item of its own (`ShapedText::hyphen`) and pushed after
  `collect_items` with `LogicalIndex::END_HYPHEN` (lines 171 to 178). The link's end tag is among the collected
  items, so the hyphen's text item comes after it in the line's frame.
- The hyphen's item is built from the base run's styles, so `Frame::modify_text` gives it a `FrameItem::Link`
  of its own, now outside the link element's tag range.
- `typst-pdf/src/link.rs:107`, `handle_link`: `gc.tags.tree.parent_link().expect_internal("expected link
  ancestor in logical tree")` meets that link item with no Link element open and fails.

The soft hyphen at a line end *inside* the link's text does not trigger it: the next line's items reopen the
tag range, and the hyphen item sits before the link's end tag in its own line.

## Expected

Either the hyphen belongs to the link (it is part of the linked word: same destination, same Link structure
element), or at least the export should not fail. The former matches what the frame shows for a soft hyphen at a
line end inside the link.

## What this repository does meanwhile

Both paramdoc runtimes refuse a link slot whose text ends on a soft hyphen, with the message to strip it
(`experiments/paramdoc/GAPS.md` G52, `fixtures/links/data-shy-error.json`), because such data would also have
no compiler fallback. The structure difference shows up before the crash: the paramdoc exporter's isolation
check sees the hyphen's link item outside the link element ("a link to https://example.org outside a link
element"), and its fuzz reported the changed structure tree as a layout leak, which is how this was found.
