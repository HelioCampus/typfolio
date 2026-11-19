/** Client coordinates and the canvas bounds share viewport space, including scrolling. */
export function pointerToPage(
  point: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((point.clientX - bounds.left) / bounds.width) * page.width,
    y: ((point.clientY - bounds.top) / bounds.height) * page.height,
  };
}
