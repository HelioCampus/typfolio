const baselines = new Map<string, number>();

/** Measure each font's line-box baseline once, without mounting a demo renderer. */
export function measureBaseline(font: string, lineHeight: number, letterSpacing = 0): number {
  const key = `${font}|${lineHeight}|${letterSpacing}`;
  const cached = baselines.get(key);
  if (cached !== undefined) return cached;

  const line = document.createElement('span');
  Object.assign(line.style, {
    position: 'absolute',
    left: '-10000px',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'pre',
    font,
    lineHeight: `${lineHeight}px`,
    letterSpacing: `${letterSpacing}px`,
  });
  const probe = document.createElement('i');
  Object.assign(probe.style, { display: 'inline-block', width: '0', height: '0' });
  line.append('H', probe);
  document.body.appendChild(line);
  try {
    const baseline = probe.getBoundingClientRect().bottom - line.getBoundingClientRect().top;
    baselines.set(key, baseline);
    return baseline;
  } finally {
    line.remove();
  }
}
