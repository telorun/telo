export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The viewport that brings `node` fully into a canvas of `size`, moved no more
 * than needed; null when it is already in view. A node larger than the canvas
 * is aligned to the top-left margin.
 */
export function viewportRevealing(
  viewport: FlowViewport,
  node: FlowRect,
  size: { width: number; height: number },
  margin = 24,
): FlowViewport | null {
  const axis = (position: number, extent: number, available: number): number => {
    const start = position;
    const end = position + extent;
    if (extent > available - 2 * margin || start < margin) return margin - start;
    if (end > available - margin) return available - margin - end;
    return 0;
  };
  const dx = axis(node.x * viewport.zoom + viewport.x, node.width * viewport.zoom, size.width);
  const dy = axis(node.y * viewport.zoom + viewport.y, node.height * viewport.zoom, size.height);
  return dx === 0 && dy === 0 ? null : { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}
