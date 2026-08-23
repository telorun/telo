import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight, FileCog, Maximize2, Plus } from "lucide-react";
import { summarizeResource } from "../../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../../diagnostics/DiagnosticsContext";
import { severityBorderClass } from "../../../diagnostics/severity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { capLabel } from "../ApplicationTopologyCanvas";
import { CONTAINER_HEADER, LANE_LABEL, type NestedBox, type NestedLane } from "../nested-layout";

/**
 * The nested view's node vocabulary — its own, not the level canvas's.
 *
 * The two views ask different questions of a node, so they draw different nodes.
 * On the level canvas a node is the WORK SURFACE: its port rail is where refs
 * are wired, its steps are where an invoke anchors, its type pills open an
 * editor. Here a node is an IDENTITY CHIP inside a frame — what it is, and
 * whether it opens — because the picture is about position, and a rail nested
 * two frames deep is detail nobody reads at that zoom.
 *
 * Sharing one component made this view inherit every rail, step list and
 * signature pill the level canvas needs, which is what made a container of three
 * services taller than the screen. Keeping them apart is also what lets either
 * be adjusted without the other moving.
 */

/** Every node datum carries the layout's emission counter: xyflow resolves
 *  `parentId` by array position, and lanes interleave with boxes. */
interface Ordered extends Record<string, unknown> {
  order: number;
}

export interface SubflowNodeData extends Ordered {
  box: NestedBox;
  selected: boolean;
  /** Draw the socket an edge leaves from / arrives at. Only the boxes an edge
   *  actually touches get one, so a leaf is drawn clean. */
  hasSource: boolean;
  hasTarget: boolean;
  /** Peek this resource in the detail panel. */
  onOpen: () => void;
  /** Expand in place, or re-root the view when the box sits at the depth
   *  budget. Absent when there is no interior to open. */
  onOpenInterior?: () => void;
}

/** A collapsed resource: name, kind, and the control that opens it. */
function SubflowNode({ data }: NodeProps<Node<SubflowNodeData>>) {
  const { box } = data;
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, box.id);
  const border =
    (summary && severityBorderClass(summary.worstSeverity)) ||
    "border-zinc-200 dark:border-zinc-700";
  return (
    <div
      className={`flex h-full w-full flex-col justify-center rounded-md border bg-white px-2 shadow-sm dark:bg-zinc-900 ${border} ${
        data.selected ? "ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
      }`}
    >
      {data.hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        />
      )}
      <div className="flex items-center gap-1.5">
        <FileCog className="size-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
          {box.id}
        </span>
        {summary && (
          <span data-no-open className="ml-auto shrink-0">
            <DiagnosticBadge summary={summary} size="sm" />
          </span>
        )}
        {data.onOpenInterior && (
          <button
            type="button"
            data-no-open
            className={`nodrag nopan flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${
              summary ? "" : "ml-auto"
            }`}
            title={
              box.reroots
                ? `Open ${box.id} — too deep to nest, so the view re-roots here`
                : `Open ${box.id}${box.childCount ? ` — ${box.childCount} inside` : ""}`
            }
            onClick={(e) => {
              e.stopPropagation();
              data.onOpenInterior!();
            }}
          >
            {box.childCount || null}
            {box.reroots ? <Maximize2 className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
      </div>
      <div className="truncate text-[10px] uppercase tracking-wide text-zinc-400">
        {capLabel(box.node.capability)}
      </div>
      {data.hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-2 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        />
      )}
    </div>
  );
}

export interface SubflowContainerData extends Ordered {
  box: NestedBox;
  selected: boolean;
  hasSource: boolean;
  hasTarget: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onFocus: () => void;
}

/** An opened resource: a frame around its contents, with its identity in the
 *  header strip so nesting never costs you the name of what you are inside. */
function SubflowContainer({ data }: NodeProps<Node<SubflowContainerData>>) {
  const { box } = data;
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, box.id);
  const border =
    (summary && severityBorderClass(summary.worstSeverity)) ||
    "border-zinc-300 dark:border-zinc-600";
  return (
    <div
      className={`relative h-full w-full rounded-lg border-2 border-dashed ${border} bg-zinc-50/60 dark:bg-zinc-900/40 ${
        data.selected ? "ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
      }`}
    >
      {data.hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        />
      )}
      <div className="flex items-center gap-1.5 px-2" style={{ height: CONTAINER_HEADER }}>
        <button
          type="button"
          data-no-open
          className="nodrag nopan shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          title="Collapse"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle();
          }}
        >
          <ChevronDown className="size-3.5" />
        </button>
        <FileCog className="size-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
          {box.id}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-400">
          {capLabel(box.node.capability)}
        </span>
        {summary && (
          <span data-no-open className="shrink-0">
            <DiagnosticBadge summary={summary} size="sm" />
          </span>
        )}
        <button
          type="button"
          data-no-open
          className="nodrag nopan ml-auto shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
          title="Focus this level — the view re-roots here"
          onClick={(e) => {
            e.stopPropagation();
            data.onFocus();
          }}
        >
          <Maximize2 className="size-3" />
        </button>
      </div>
      {data.hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-2 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        />
      )}
    </div>
  );
}

export interface SubflowLaneData extends Ordered {
  lane: NestedLane;
  onCreate?: (concretePath: string, kind: string) => void;
}

/** One slot's band: a label strip, and — when the slot is an array of refs —
 *  the control that creates a resource into it. */
function SubflowLaneBand({ data }: NodeProps<Node<SubflowLaneData>>) {
  const { lane } = data;
  if (!lane.label) return null;
  return (
    <div className="h-full w-full rounded-md border border-zinc-200/70 bg-white/50 dark:border-zinc-700/50 dark:bg-zinc-800/30">
      <div className="flex items-center gap-1 px-1.5" style={{ height: LANE_LABEL }}>
        <span className="truncate text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          {lane.label}
        </span>
        <LaneAddButton lane={lane} onCreate={data.onCreate} />
      </div>
    </div>
  );
}

/** Create-and-link into the lane's slot. On the LANE rather than on the
 *  container as a whole, because the slot is what a new resource is added TO —
 *  the same relation the level canvas states with its per-port `+`, which
 *  nesting replaced with the lane. */
function LaneAddButton({
  lane,
  onCreate,
}: {
  lane: NestedLane;
  onCreate?: (concretePath: string, kind: string) => void;
}) {
  const kinds = lane.createKinds ?? [];
  if (!onCreate || !lane.addPath || kinds.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-no-open
          className="nodrag nopan flex items-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          title={`Create a resource and add it to ${lane.label}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Plus className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
        {kinds.map((k) => (
          <DropdownMenuItem key={k} className="text-xs" onSelect={() => onCreate(lane.addPath!, k)}>
            {k}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const subflowNodeTypes = {
  resource: SubflowNode,
  container: SubflowContainer,
  lane: SubflowLaneBand,
};
