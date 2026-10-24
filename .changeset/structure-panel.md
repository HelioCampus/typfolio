---
'@typfolio/dev-tools': minor
---

Structure panel: a PDF's tags in the page while you work on a template.

- `@typfolio/dev-tools/panel`: `mountStructureDevtools(options)` adds a button with the number of structure problems found (in the corner `buttonPosition` names) that opens a panel along a side of the page (`position`: bottom, top, left or right; its toolbar moves it); `mountStructurePanel(element, options)` shows the panel in an element of yours. The panel lists each page's tags in reading order, the structure warnings with the tag each is about, and the selected tag's text, alt text and language, with a filter by role or text.
- React is bundled into the entry, so a page needs no React of its own; the page passes its own pdf.js. `THIRD_PARTY_NOTICES.md` carries React's licence.
