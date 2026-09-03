import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";

/**
 * An edge drawn along the route the layout engine solved for it.
 *
 * xyflow's built-in edges interpolate between two points and know nothing about
 * what lies between them, so on any real module they cross the boxes in the
 * way. ELK already computes an orthogonal route around them while it places the
 * boxes — the two are one problem — so the points come from there and this
 * draws them.
 *
 * Corners are rounded by a fixed radius, clamped to half the shorter of the two
 * segments it joins, so a tight dog-leg degrades to a sharp corner instead of
 * bulging past its own path.
 */
export interface RoutedEdgeData extends Record<string, unknown> {
  points?: { x: number; y: number }[];
  label?: string;
}

const CORNER = 8;

export function roundedPath(points: readonly { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  const parts = [`M ${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(CORNER, inLength / 2, outLength / 2);
    if (r < 0.5) {
      parts.push(`L ${corner.x},${corner.y}`);
      continue;
    }
    const enter = {
      x: corner.x + ((previous.x - corner.x) / inLength) * r,
      y: corner.y + ((previous.y - corner.y) / inLength) * r,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    parts.push(`L ${enter.x},${enter.y}`, `Q ${corner.x},${corner.y} ${leave.x},${leave.y}`);
  }
  const end = points[points.length - 1];
  parts.push(`L ${end.x},${end.y}`);
  return parts.join(" ");
}

function RoutedEdgeComponent({
  id,
  data,
  style,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<Edge<RoutedEdgeData>>) {
  const points = data?.points;
  // No route yet — the first frame after an edit, before the solver has
  // answered. A straight line between the sockets is the honest stand-in: it
  // says the edge exists and does not pretend to a path it has not been given.
  const path =
    points && points.length >= 2
      ? roundedPath(points)
      : `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  const mid = points && points.length >= 2 ? points[Math.floor(points.length / 2)] : null;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {data?.label && mid && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-white/80 px-1 text-[9px] text-zinc-500 dark:bg-zinc-900/80 dark:text-zinc-400"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const moduleGraphEdgeTypes = { routed: RoutedEdgeComponent };
