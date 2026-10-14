export type PreviewMode = 'fast' | 'viewer' | 'native';

export const MODE_LABELS: Record<PreviewMode, { label: string; hint: string }> = {
  fast: { label: 'Fast', hint: 'Bare pdf.js canvas: highest frame rate, drag on the PDF works' },
  viewer: { label: 'Viewer', hint: 'The same live canvas inside viewer chrome we draw ourselves' },
  native: { label: 'Native', hint: "Chrome's built-in PDF viewer, refreshed on demand" },
};

interface ModeSwitchProps {
  readonly modes: readonly PreviewMode[];
  readonly value: PreviewMode;
  readonly onChange: (mode: PreviewMode) => void;
}

export function ModeSwitch({ modes, value, onChange }: ModeSwitchProps) {
  return (
    <div className="segmented" role="group" aria-label="PDF view mode">
      <span className="segmented-label">View</span>
      {modes.map(mode => (
        <button
          aria-pressed={value === mode}
          className={value === mode ? 'on' : undefined}
          key={mode}
          onClick={() => onChange(mode)}
          title={MODE_LABELS[mode].hint}
          type="button"
        >
          {MODE_LABELS[mode].label}
        </button>
      ))}
    </div>
  );
}

export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

interface ToolbarProps {
  readonly name: string;
  readonly page: number;
  readonly pages: number;
  readonly zoom: number;
  readonly onZoom: (zoom: number) => void;
}

/** A PDF-viewer-style toolbar drawn by the example (not the browser's). */
export function ViewerToolbar({ name, page, pages, zoom, onZoom }: ToolbarProps) {
  const index = ZOOMS.findIndex(value => value === zoom);
  const step = (delta: number): void => {
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (index < 0 ? 2 : index) + delta))]!;
    onZoom(next);
  };
  return (
    <div className="viewer-toolbar" role="toolbar" aria-label="Viewer toolbar">
      <span className="viewer-name" title={name}>{name}</span>
      <span className="viewer-page">{page} / {pages}</span>
      <span className="viewer-zoom">
        <button aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => step(-1)} type="button">−</button>
        <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
        <button aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => step(1)} type="button">+</button>
        <button className="viewer-fit" disabled={zoom === 1} onClick={() => onZoom(1)} type="button">Fit</button>
      </span>
    </div>
  );
}
