// The panel's styles, inside its shadow root: the page's styles do not reach it, and these do not reach the page.
const dark = `
  --tf-bg: #161a22;
  --tf-bg-soft: #1d222c;
  --tf-fg: #e4e8ef;
  --tf-muted: #9aa3b2;
  --tf-border: #2e3542;
  --tf-accent: #8fb0ff;
  --tf-selected: #243150;
  --tf-hover: #212835;
  --tf-role: #252b37;
  --tf-warn-bg: #3a2c0c;
  --tf-warn-fg: #f5c86a;
  --tf-error-bg: #3d1717;
  --tf-error-fg: #ff9c9c;
  --tf-ok-bg: #133020;
  --tf-ok-fg: #7fd69a;
  color-scheme: dark;
`;

export const css = `
:host { all: initial; }
.tf {
  --tf-bg: #ffffff;
  --tf-bg-soft: #f5f6f8;
  --tf-fg: #1c2230;
  --tf-muted: #5f6878;
  --tf-border: #dfe3ea;
  --tf-accent: #2f5bd3;
  --tf-selected: #e8eefc;
  --tf-hover: #f0f2f6;
  --tf-role: #eef0f4;
  --tf-warn-bg: #fff3d6;
  --tf-warn-fg: #7a4b00;
  --tf-error-bg: #fde7e7;
  --tf-error-fg: #9b1c1c;
  --tf-ok-bg: #e3f4e8;
  --tf-ok-fg: #1b6532;
  color-scheme: light;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--tf-fg);
}
.tf[data-theme="dark"] {${dark}}
@media (prefers-color-scheme: dark) {
  .tf[data-theme="system"] {${dark}}
}
.tf *, .tf *::before, .tf *::after { box-sizing: border-box; }
.tf button, .tf input { font: inherit; color: inherit; }
.tf button { cursor: pointer; }
.tf :focus-visible { outline: 2px solid var(--tf-accent); outline-offset: -2px; }
.tf ul { list-style: none; margin: 0; padding: 0; }
.tf h2, .tf h3, .tf p, .tf dl, .tf dd { margin: 0; }

.tf-embedded { height: 100%; }
.tf-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--tf-bg);
  container-type: inline-size;
}
.tf-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--tf-border);
  background: var(--tf-bg-soft);
}
.tf-title { font-size: 13px; font-weight: 600; }
.tf-counts { color: var(--tf-muted); }
.tf-reading { color: var(--tf-muted); font-style: italic; }
.tf-filter {
  margin-left: auto;
  width: 200px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--tf-border);
  border-radius: 4px;
  background: var(--tf-bg);
}
.tf-close {
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 18px;
  line-height: 24px;
}
.tf-close:hover { background: var(--tf-hover); }

.tf-banner { padding: 6px 10px; border-bottom: 1px solid var(--tf-border); }
.tf-banner[data-tone="error"] { background: var(--tf-error-bg); color: var(--tf-error-fg); }
.tf-banner[data-tone="ok"] { background: var(--tf-ok-bg); color: var(--tf-ok-fg); }
.tf-banner[data-tone="quiet"] { color: var(--tf-muted); }

.tf-problems {
  max-height: 34%;
  overflow: auto;
  flex-shrink: 0;
  border-bottom: 1px solid var(--tf-border);
  background: var(--tf-warn-bg);
  color: var(--tf-warn-fg);
}
.tf-problems h2 { padding: 6px 10px 2px; font-size: 12px; font-weight: 600; }
.tf-problem {
  display: block;
  width: 100%;
  padding: 3px 10px;
  border: 0;
  background: none;
  text-align: left;
}
button.tf-problem:hover { text-decoration: underline; }
.tf-problem-page { font-weight: 600; }

.tf-main {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  flex: 1;
  min-height: 0;
}
@container (max-width: 560px) {
  .tf-main { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 3fr) minmax(0, 2fr); }
  .tf-details { border-left: 0; border-top: 1px solid var(--tf-border); }
}
.tf-tree { overflow: auto; padding: 4px 0 12px; }
.tf-page-title {
  position: sticky;
  top: -4px;
  z-index: 1;
  padding: 4px 10px;
  background: var(--tf-bg);
  color: var(--tf-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tf-tree ul ul { padding-left: 16px; }
.tf-row { display: flex; align-items: center; min-width: 0; padding-left: 6px; border-radius: 3px; }
.tf-row:hover { background: var(--tf-hover); }
.tf-row[data-selected="true"] { background: var(--tf-selected); }
.tf-twist, .tf-twist-space { flex-shrink: 0; width: 18px; height: 22px; }
.tf-twist {
  padding: 0;
  border: 0;
  background: none;
  color: var(--tf-muted);
  font-size: 10px;
  transition: transform 100ms;
}
.tf-twist[aria-expanded="true"] { transform: rotate(90deg); }
.tf-select {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 22px;
  padding: 0 8px 0 2px;
  border: 0;
  background: none;
  text-align: left;
}
.tf-role {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--tf-role);
  font: 11px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tf-role[data-heading="true"] { color: var(--tf-accent); font-weight: 700; }
.tf-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-text[data-quiet="true"] { color: var(--tf-muted); }
.tf-row[data-found="true"] .tf-text { font-weight: 600; }
.tf-mark {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--tf-warn-bg);
  color: var(--tf-warn-fg);
  font-size: 11px;
  font-weight: 600;
}

.tf-details { overflow: auto; padding: 10px 12px; border-left: 1px solid var(--tf-border); background: var(--tf-bg-soft); }
.tf-details h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.tf-details dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; }
.tf-details dt { color: var(--tf-muted); }
.tf-details dd { overflow-wrap: anywhere; white-space: pre-wrap; }
.tf-details .tf-problem-note { margin-top: 10px; padding: 6px 8px; border-radius: 4px; background: var(--tf-warn-bg); color: var(--tf-warn-fg); }
.tf-hint { color: var(--tf-muted); }

.tf-toggle {
  position: fixed;
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--tf-border);
  border-radius: 999px;
  background: var(--tf-bg);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
  font-weight: 600;
}
.tf-toggle[hidden] { display: none; }
.tf-toggle[data-position="bottom-right"] { right: 12px; bottom: 12px; }
.tf-toggle[data-position="bottom-left"] { left: 12px; bottom: 12px; }
.tf-toggle[data-position="top-right"] { right: 12px; top: 12px; }
.tf-toggle[data-position="top-left"] { left: 12px; top: 12px; }
.tf-badge {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.tf-badge[data-tone="warn"] { background: var(--tf-warn-bg); color: var(--tf-warn-fg); }
.tf-badge[data-tone="error"] { background: var(--tf-error-bg); color: var(--tf-error-fg); }
.tf-badge[data-tone="ok"] { background: var(--tf-ok-bg); color: var(--tf-ok-fg); }
.tf-badge[data-tone="quiet"] { background: var(--tf-role); color: var(--tf-muted); }
.tf-dock {
  position: fixed;
  z-index: 99999;
  display: flex;
  background: var(--tf-bg);
}
.tf-dock[hidden] { display: none; }
.tf-dock[data-side="bottom"], .tf-dock[data-side="top"] { right: 0; left: 0; height: 40vh; min-height: 140px; max-height: calc(100vh - 40px); }
.tf-dock[data-side="left"], .tf-dock[data-side="right"] { top: 0; bottom: 0; width: min(520px, 45vw); min-width: 280px; max-width: calc(100vw - 40px); }
.tf-dock[data-side="bottom"] { bottom: 0; flex-direction: column; border-top: 1px solid var(--tf-border); box-shadow: 0 -4px 16px rgb(0 0 0 / 0.16); }
.tf-dock[data-side="top"] { top: 0; flex-direction: column-reverse; border-bottom: 1px solid var(--tf-border); box-shadow: 0 4px 16px rgb(0 0 0 / 0.16); }
.tf-dock[data-side="left"] { left: 0; flex-direction: row-reverse; border-right: 1px solid var(--tf-border); box-shadow: 4px 0 16px rgb(0 0 0 / 0.16); }
.tf-dock[data-side="right"] { right: 0; flex-direction: row; border-left: 1px solid var(--tf-border); box-shadow: -4px 0 16px rgb(0 0 0 / 0.16); }
.tf-dock .tf-panel { flex: 1; min-width: 0; min-height: 0; }
.tf-resize { flex-shrink: 0; }
.tf-resize:hover, .tf-resize:focus-visible { background: var(--tf-accent); }
.tf-dock[data-side="bottom"] .tf-resize, .tf-dock[data-side="top"] .tf-resize { height: 5px; cursor: ns-resize; }
.tf-dock[data-side="left"] .tf-resize, .tf-dock[data-side="right"] .tf-resize { width: 5px; cursor: ew-resize; }
.tf-dock[data-side="bottom"] .tf-resize { margin-top: -3px; }
.tf-dock[data-side="top"] .tf-resize { margin-bottom: -3px; }
.tf-dock[data-side="left"] .tf-resize { margin-right: -3px; }
.tf-dock[data-side="right"] .tf-resize { margin-left: -3px; }
.tf-sides { display: flex; gap: 2px; }
.tf-side {
  display: flex;
  padding: 4px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--tf-muted);
}
.tf-side:hover { background: var(--tf-hover); }
.tf-side[aria-pressed="true"] { background: var(--tf-selected); color: var(--tf-accent); }
`;
