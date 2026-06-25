import Dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Boxes, ChevronRight, FileCog, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasViewport, Selection } from "../../../model";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { isRecord } from "../../../lib/utils";
import { summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { severityBorderClass } from "../../diagnostics/severity";
import {
  type AppCanvasModel,
  type GraphNode,
  type NodeStep,
  type RefWrite,
  type TypeSignature,
} from "./application-canvas-model";
import type { NodePort } from "./node-ports";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const STEP_ROW_HEIGHT = 22;
const STEPS_SECTION_PAD = 10;
const PORT_ROW_HEIGHT = 22;
const PORTS_SECTION_PAD = 10;

/** Select value standing in for "no ref" — Radix reserves the empty string. */
const PICKER_NONE = "__none__";

/** Rendered rows a port occupies: one per slot, plus the array add-slot. */
function portRows(port: NodePort): number {
  return port.slots.length + (port.addPath ? 1 : 0);
}

function portsRowCount(ports: NodePort[] | undefined): number {
  return (ports ?? []).reduce((n, p) => n + portRows(p), 0);
}

/** Layout height for a node — grows with its rendered step rows and port rows so
 *  dagre spaces nodes without overlap. */
function nodeHeight(n: GraphNode): number {
  let h = NODE_HEIGHT;
  if (n.steps?.length) h += STEPS_SECTION_PAD + n.steps.length * STEP_ROW_HEIGHT;
  const ports = portsRowCount(n.ports);
  if (ports) h += PORTS_SECTION_PAD + ports * PORT_ROW_HEIGHT;
  return h;
}

/** Short capability label (drops the `Telo.` prefix). */
function capLabel(capability: string): string {
  return capability.startsWith("Telo.") ? capability.slice(5) : capability;
}

const nodeId = (kind: string, name: string) => `${kind} ${name}`;

/** Selector-safe xyflow handle id for a concrete path (step or port). Concrete
 *  paths carry `[` / `]` / `.`, which can trip xyflow's handle lookup, so
 *  collapse them to `-`. Applied identically to the rendered handle and the
 *  edge's `sourceHandle`, and reversed via a lookup map for connections. */
const handleId = (path: string) => path.replace(/[^a-zA-Z0-9]+/g, "-");

/** Left indent per nesting level for a step row. */
const STEP_INDENT = 10;

/** One-line summary of a resolved type schema for the signature pill tooltip. */
function schemaSummary(schema: Record<string, unknown>): string {
  if (isRecord(schema.properties)) {
    const props = Object.entries(schema.properties).map(([k, v]) => {
      const t = isRecord(v) && typeof v.type === "string" ? v.type : "any";
      return `${k}: ${t}`;
    });
    return props.length ? `{ ${props.join(", ")} }` : "{}";
  }
  return typeof schema.type === "string" ? schema.type : "object";
}

/** Tooltip text for a signature pill: the resolved shape, the named type, or an
 *  unset marker. */
function summarizeSignature(sig: TypeSignature): string {
  const shape = sig.schema ? schemaSummary(sig.schema) : undefined;
  if (sig.name) return shape ? `${sig.name} ${shape}` : sig.name;
  if (shape) return shape;
  return sig.set ? "inline type" : "not set";
}

/** A type signature pill straddling the node's left edge. Both input and output
 *  sit on the left because the call flows in from the left and its result flows
 *  back out to the same caller — input near the top, output near the bottom. Set
 *  types read solid violet; unset types read as a muted dashed placeholder. The
 *  shape shows on hover. When `onEdit` is supplied and the field is editable on
 *  the instance, the pill is a button that opens a focused editor for that type
 *  (stopping the click from also selecting the node). */
function SignaturePill({
  side,
  sig,
  selected,
  onEdit,
}: {
  side: "in" | "out";
  sig: TypeSignature;
  selected?: boolean;
  onEdit?: () => void;
}) {
  const label = sig.name ?? side;
  // Both pills hug the left edge — input at the top-left corner, output at the
  // bottom-left corner — so they stay clear of the icon/label and each other.
  const pos = side === "in" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2";
  const interactive = !!onEdit && !!sig.fieldSchema;
  const pill = (
    <span
      className={`inline-block w-9 truncate rounded border px-1.5 py-0.5 text-center text-[9px] font-medium shadow-sm ${
        sig.set
          ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200"
          : "border-dashed border-zinc-300 bg-white text-zinc-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-500"
      } ${interactive ? "hover:border-violet-400 hover:text-violet-800 dark:hover:text-violet-100" : ""} ${
        selected ? "ring-2 ring-violet-500 ring-offset-1 dark:ring-offset-zinc-900" : ""
      }`}
    >
      {label}
    </span>
  );
  return (
    <div
      className={`absolute left-0 z-10 -translate-x-1/2 ${pos}`}
      title={`${side === "in" ? "input" : "output"}: ${summarizeSignature(sig)}${
        interactive ? " — click to edit" : ""
      }`}
    >
      {interactive ? (
        <button
          type="button"
          data-no-open
          className="nodrag nopan cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onEdit!();
          }}
        >
          {pill}
        </button>
      ) : (
        pill
      )}
    </div>
  );
}

interface ResourceNodeData extends Record<string, unknown> {
  kind: string;
  name: string;
  label: string;
  capability: string;
  isRoot?: boolean;
  /** Input / output type signatures — present only for `Telo.Invocable` nodes. */
  inputType?: TypeSignature;
  outputType?: TypeSignature;
  /** Which type-field pill (if any) is the active selection — highlights it. */
  selectedTypeField?: "inputType" | "outputType";
  selected: boolean;
  steps: NodeStep[];
  ports: NodePort[];
  /** True when the node is the source of an edge that docks on neither a port
   *  nor a step handle — the only case the fallback right-edge socket serves.
   *  Leaf / pure-target nodes get no socket. */
  hasFallbackOutput: boolean;
  editable: boolean;
  onOpen: () => void;
  /** Writes a picker port's selection (or clears it with `null`). */
  onPick: (concretePath: string, target: string | null) => void;
  /** Creates a new resource of `kind` and links the `+` slot at `concretePath`. */
  onCreate: (concretePath: string, kind: string) => void;
  /** Opens a focused editor for the node's `inputType` / `outputType` field. */
  onEditType?: (field: "inputType" | "outputType") => void;
}

/** One edge-port slot row: a label and a source handle that pokes out of the
 *  node's right edge like an adapter. The handle is filled when wired. */
function EdgeSlotRow({ label, target, path }: { label: string; target?: string; path: string }) {
  return (
    <div className="relative flex items-center px-3" style={{ height: PORT_ROW_HEIGHT }}>
      <span className="truncate text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
        {label}
      </span>
      {target && (
        <span className="ml-auto truncate pl-1 font-mono text-[9px] text-zinc-400">{target}</span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        id={handleId(path)}
        className={
          target
            ? "!size-2.5 !border-zinc-600 !bg-zinc-600"
            : "!size-2.5 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        }
      />
    </div>
  );
}

/** The array add-slot row: a `+` affordance and an empty source handle. Drag
 *  from the handle to wire an existing node; click the `+` to create-and-link a
 *  new resource of an applicable kind. */
function AddSlotRow({
  label,
  path,
  createKinds,
  editable,
  onCreate,
}: {
  label: string;
  path: string;
  createKinds: string[];
  editable: boolean;
  onCreate: (concretePath: string, kind: string) => void;
}) {
  const canCreate = editable && createKinds.length > 0;
  return (
    <div className="relative flex items-center px-3" style={{ height: PORT_ROW_HEIGHT }}>
      <span className="truncate text-[10px] text-zinc-400">{label}</span>
      {canCreate ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="nodrag nopan ml-auto flex items-center text-zinc-400 hover:text-zinc-600"
              title="Create & link a resource"
            >
              <Plus className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
            {createKinds.map((k) => (
              <DropdownMenuItem key={k} className="text-xs" onSelect={() => onCreate(path, k)}>
                {k}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Plus className="ml-auto size-3 text-zinc-400" />
      )}
      <Handle
        type="source"
        position={Position.Right}
        id={handleId(path)}
        className="!size-2.5 !border-zinc-400 !bg-white dark:!bg-zinc-900"
      />
    </div>
  );
}

/** One picker-port slot row: an inline select over the matching ambient
 *  resources. No handle — picker ports never draw edges. */
function PickerSlotRow({
  label,
  value,
  candidates,
  editable,
  onPick,
}: {
  label: string;
  value: string | undefined;
  candidates: string[];
  editable: boolean;
  onPick: (target: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3" style={{ height: PORT_ROW_HEIGHT }}>
      <span className="truncate text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
        {label}
      </span>
      <Select
        value={value ?? PICKER_NONE}
        disabled={!editable}
        onValueChange={(v) => onPick(v === PICKER_NONE ? null : v)}
      >
        <SelectTrigger
          size="sm"
          className="nodrag nopan ml-auto !h-5 !min-h-0 !py-0 max-w-[110px] gap-1 px-1.5 text-[10px]"
        >
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PICKER_NONE}>—</SelectItem>
          {candidates.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Renders one port as a stack of rows. Edge ports emit handle rows + an add
 *  row; picker ports emit select rows. The field label shows on the first row. */
function PortRows({
  port,
  editable,
  onPick,
  onCreate,
}: {
  port: NodePort;
  editable: boolean;
  onPick: (concretePath: string, target: string | null) => void;
  onCreate: (concretePath: string, kind: string) => void;
}) {
  if (port.flavor === "picker") {
    const candidates = port.candidates ?? [];
    return (
      <>
        {port.slots.map((slot, i) => (
          <PickerSlotRow
            key={slot.concretePath}
            label={i === 0 ? port.label : ""}
            value={slot.target}
            candidates={candidates}
            editable={editable}
            onPick={(t) => onPick(slot.concretePath, t)}
          />
        ))}
        {port.addPath && (
          <PickerSlotRow
            key={port.addPath}
            label={port.slots.length === 0 ? port.label : ""}
            value={undefined}
            candidates={candidates}
            editable={editable}
            onPick={(t) => onPick(port.addPath!, t)}
          />
        )}
      </>
    );
  }
  return (
    <>
      {port.slots.map((slot, i) => (
        <EdgeSlotRow
          key={slot.concretePath}
          label={i === 0 ? port.label : ""}
          target={slot.target}
          path={slot.concretePath}
        />
      ))}
      {port.addPath && (
        <AddSlotRow
          label={port.slots.length === 0 ? port.label : ""}
          path={port.addPath}
          createKinds={port.createKinds ?? []}
          editable={editable}
          onCreate={onCreate}
        />
      )}
    </>
  );
}

/** Canvas node: resource name, capability badge, a rail of reference ports
 *  (adapters), and — for sequence-like nodes — an internal list of steps. Each
 *  edge port / step carries its own source handle (id = concrete path) so edges
 *  anchor to the exact slot they came from. The module root is styled
 *  distinctly. */
function ResourceNode({ data }: NodeProps<Node<ResourceNodeData>>) {
  const isRoot = data.isRoot;
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, data.name);
  const bgClass = isRoot ? "bg-indigo-50 dark:bg-indigo-950" : "bg-white dark:bg-zinc-900";
  const defaultBorder = isRoot
    ? "border-indigo-300 dark:border-indigo-700"
    : "border-zinc-200 dark:border-zinc-700";
  const borderClass = (summary && severityBorderClass(summary.worstSeverity)) || defaultBorder;
  return (
    <div
      className={`relative rounded-md border px-3 py-2 text-left shadow-sm ${bgClass} ${borderClass} ${
        data.selected ? "ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
      }`}
      style={{ width: NODE_WIDTH }}
    >
      {/* The module root is an edge source only — nothing wires into it, so it
          gets no input socket. */}
      {!isRoot && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2.5 !border-zinc-400 !bg-white dark:!bg-zinc-900"
        />
      )}
      {data.inputType && (
        <SignaturePill
          side="in"
          sig={data.inputType}
          selected={data.selectedTypeField === "inputType"}
          onEdit={data.onEditType ? () => data.onEditType!("inputType") : undefined}
        />
      )}
      {data.outputType && (
        <SignaturePill
          side="out"
          sig={data.outputType}
          selected={data.selectedTypeField === "outputType"}
          onEdit={data.onEditType ? () => data.onEditType!("outputType") : undefined}
        />
      )}
      <div className="flex items-center gap-1.5">
        {isRoot ? (
          <Boxes className="size-3.5 shrink-0 text-indigo-500" />
        ) : (
          <FileCog className="size-3.5 shrink-0 text-zinc-400" />
        )}
        <span className="min-w-0 truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
          {data.label}
        </span>
        {summary && (
          <span data-no-open className="ml-auto shrink-0">
            <DiagnosticBadge summary={summary} size="sm" />
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
        {capLabel(data.capability)}
      </div>
      {data.ports.length > 0 && (
        <div className="mt-1.5 -mx-3 flex flex-col gap-0.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
          {data.ports.map((port) => (
            <PortRows
              key={port.key}
              port={port}
              editable={data.editable}
              onPick={data.onPick}
              onCreate={data.onCreate}
            />
          ))}
        </div>
      )}
      {data.steps.length > 0 && (
        <div className="mt-1.5 -mx-3 flex flex-col gap-0.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
          {data.steps.map((s) => (
            <div
              key={s.path}
              className="relative flex items-center gap-1.5 pr-3"
              style={{ height: STEP_ROW_HEIGHT, paddingLeft: 12 + s.depth * STEP_INDENT }}
            >
              <span className="truncate text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                {s.name}
              </span>
              {s.detail && (
                <span className="ml-auto truncate font-mono text-[9px] text-zinc-400">
                  {s.detail}
                </span>
              )}
              <Handle
                type="source"
                position={Position.Right}
                id={handleId(s.path)}
                className="!bg-violet-400"
              />
            </div>
          ))}
        </div>
      )}
      {/* Fallback source handle — rendered only when an edge actually docks here
          (no specific port / step anchor). Leaf / target-only nodes get none. */}
      {data.hasFallbackOutput && (
        <Handle type="source" position={Position.Right} className="!bg-zinc-400" />
      )}
    </div>
  );
}

const nodeTypes = { resource: ResourceNode };

interface RefEdgeData extends Record<string, unknown> {
  source: { kind: string; name: string };
  concretePath: string;
  /** Present when the edge's invocation accepts inputs — clicking opens the
   *  inputs form at this pointer with this schema. */
  inputs?: { pointer: string; schema: Record<string, unknown> };
}

/** Concrete paths that have an edge-port handle on a given node (slots + add).
 *  Keyed by node name. Used to anchor edges and gate deletion to port edges. */
function portHandlePaths(nodes: GraphNode[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const n of nodes) {
    const set = new Set<string>();
    for (const p of n.ports ?? []) {
      if (p.flavor !== "edge") continue;
      for (const s of p.slots) set.add(s.concretePath);
      if (p.addPath) set.add(p.addPath);
    }
    map.set(n.name, set);
  }
  return map;
}

/** Post-dagre alignment: pulls each node's vertical center toward the handle it
 *  is wired from — a step row for a per-step invoke edge, otherwise the source
 *  node's center — so edges run roughly horizontal. Ranks are swept
 *  left-to-right; per rank, nodes are ordered on their desired y, pushed apart
 *  with a min gap, then re-centered on the desired centroid to limit drift. A
 *  node with no incoming edge keeps dagre's y. Returns center-y per node name. */
function alignNodesToSources(
  model: AppCanvasModel,
  center: Map<string, { x: number; y: number }>,
): Map<string, number> {
  const GAP = 24;
  const nodeByName = new Map(model.nodes.map((n) => [n.name, n] as const));

  const stepRowCenter = (rowIndex: number) =>
    NODE_HEIGHT + STEPS_SECTION_PAD + (rowIndex + 0.5) * STEP_ROW_HEIGHT;

  const incoming = new Map<string, { from: string; fromStepPath?: string }[]>();
  for (const e of model.edges) {
    const list = incoming.get(e.to) ?? [];
    list.push({ from: e.from, fromStepPath: e.fromStepPath });
    incoming.set(e.to, list);
  }

  const finalY = new Map<string, number>();
  for (const n of model.nodes) finalY.set(n.name, center.get(n.name)?.y ?? 0);

  const sourceAnchorY = (from: string, fromStepPath?: string): number => {
    const srcY = finalY.get(from) ?? center.get(from)?.y ?? 0;
    const src = nodeByName.get(from);
    if (fromStepPath && src?.steps) {
      const rowIndex = src.steps.findIndex((s) => s.path === fromStepPath);
      if (rowIndex >= 0) return srcY - nodeHeight(src) / 2 + stepRowCenter(rowIndex);
    }
    return srcY;
  };

  const byRank = new Map<number, GraphNode[]>();
  for (const n of model.nodes) {
    const x = Math.round(center.get(n.name)?.x ?? 0);
    const group = byRank.get(x);
    if (group) group.push(n);
    else byRank.set(x, [n]);
  }

  for (const x of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(x)!;
    const desired = new Map<string, number>();
    for (const n of group) {
      const inc = incoming.get(n.name) ?? [];
      const ys = inc.map((e) => sourceAnchorY(e.from, e.fromStepPath));
      desired.set(n.name, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : finalY.get(n.name)!);
    }

    const sorted = [...group].sort((a, b) => desired.get(a.name)! - desired.get(b.name)!);
    const placed: number[] = [];
    let prevBottom = -Infinity;
    for (const n of sorted) {
      const h = nodeHeight(n);
      const y = Math.max(desired.get(n.name)!, prevBottom + GAP + h / 2);
      placed.push(y);
      prevBottom = y + h / 2;
    }
    const meanDesired = sorted.reduce((s, n) => s + desired.get(n.name)!, 0) / sorted.length;
    const meanPlaced = placed.reduce((a, b) => a + b, 0) / placed.length;
    const shift = meanDesired - meanPlaced;
    sorted.forEach((n, i) => finalY.set(n.name, placed[i] + shift));
  }
  return finalY;
}

/** Runs dagre over the model and returns positioned xyflow nodes + edges. Ref
 *  edges dock onto the source node's port (or step) handle and are deletable —
 *  when editable — only for port edges (deleting clears that ref). */
function layout(
  model: AppCanvasModel,
  editable: boolean,
  selected: { kind: string; name: string } | null,
  /** Resource with an active sub-field selection (in/out type, edge inputs) —
   *  its node-level highlight is dropped, since a part of it is focused. */
  fieldSelected: { kind: string; name: string } | null,
  /** The in/out type field that is the active selection — its pill is
   *  highlighted on the matching node. */
  selectedTypeField: { kind: string; name: string; field: "inputType" | "outputType" } | null,
  onOpen: (n: GraphNode) => void,
  onPickRef: (source: { kind: string; name: string }, concretePath: string, target: string | null) => void,
  onCreateRef: (source: { kind: string; name: string }, concretePath: string, kind: string) => void,
  onEditType: (node: GraphNode, field: "inputType" | "outputType") => void,
): { nodes: Node[]; edges: Edge[] } {
  const portPaths = portHandlePaths(model.nodes);

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 80 });
  for (const n of model.nodes) {
    g.setNode(nodeId(n.kind, n.name), { width: NODE_WIDTH, height: nodeHeight(n) });
  }
  for (const e of model.edges) {
    const from = model.nodes.find((n) => n.name === e.from);
    const to = model.nodes.find((n) => n.name === e.to);
    if (from && to) g.setEdge(nodeId(from.kind, from.name), nodeId(to.kind, to.name));
  }
  Dagre.layout(g);

  const center = new Map<string, { x: number; y: number }>();
  for (const n of model.nodes) {
    const p = g.node(nodeId(n.kind, n.name));
    center.set(n.name, { x: p?.x ?? 0, y: p?.y ?? 0 });
  }
  const finalY = alignNodesToSources(model, center);

  // Source nodes whose edge docks on the fallback handle (neither a port nor a
  // step handle) — the only nodes that need the right-edge socket rendered.
  const fallbackSources = new Set<string>();
  for (const e of model.edges) {
    const isPortEdge = !!e.fromPath && !!portPaths.get(e.from)?.has(e.fromPath);
    if (e.fromStepPath || isPortEdge) continue;
    const from = model.nodes.find((n) => n.name === e.from);
    if (from) fallbackSources.add(nodeId(from.kind, from.name));
  }

  const nodes: Node[] = model.nodes.map((n) => {
    const c = center.get(n.name) ?? { x: 0, y: 0 };
    return {
      id: nodeId(n.kind, n.name),
      type: "resource",
      position: { x: c.x - NODE_WIDTH / 2, y: (finalY.get(n.name) ?? c.y) - nodeHeight(n) / 2 },
      data: {
        kind: n.kind,
        name: n.name,
        label: n.name,
        capability: n.capability,
        isRoot: n.isRoot,
        inputType: n.inputType,
        outputType: n.outputType,
        selected:
          selected?.kind === n.kind &&
          selected?.name === n.name &&
          !(fieldSelected?.kind === n.kind && fieldSelected?.name === n.name),
        selectedTypeField:
          selectedTypeField?.kind === n.kind && selectedTypeField?.name === n.name
            ? selectedTypeField.field
            : undefined,
        steps: n.steps ?? [],
        ports: n.ports ?? [],
        hasFallbackOutput: fallbackSources.has(nodeId(n.kind, n.name)),
        editable,
        onOpen: () => onOpen(n),
        onPick: (concretePath: string, target: string | null) =>
          onPickRef({ kind: n.kind, name: n.name }, concretePath, target),
        onCreate: (concretePath: string, kind: string) =>
          onCreateRef({ kind: n.kind, name: n.name }, concretePath, kind),
        onEditType: (field: "inputType" | "outputType") => onEditType(n, field),
      } satisfies ResourceNodeData,
    };
  });

  const edges: Edge[] = model.edges.flatMap((e, i) => {
    const from = model.nodes.find((n) => n.name === e.from);
    const to = model.nodes.find((n) => n.name === e.to);
    if (!from || !to) return [];
    const isPortEdge = !!e.fromPath && !!portPaths.get(e.from)?.has(e.fromPath);
    const sourceHandle = e.fromStepPath
      ? handleId(e.fromStepPath)
      : isPortEdge
        ? handleId(e.fromPath!)
        : undefined;
    const hasData = isPortEdge || !!e.inputs;
    return [
      {
        id: `e${i} ${e.from} ${e.to} ${e.fromPath ?? ""} ${e.fromStepPath ?? ""}`,
        source: nodeId(from.kind, from.name),
        sourceHandle,
        target: nodeId(to.kind, to.name),
        // Input-carrying edges are tinted to hint they're clickable.
        style: { stroke: e.inputs ? "#a5b4fc" : "#d4d4d8" },
        deletable: isPortEdge && editable,
        ...(hasData
          ? {
              data: {
                source: { kind: from.kind, name: from.name },
                concretePath: e.fromPath ?? "",
                inputs: e.inputs,
              } satisfies RefEdgeData,
            }
          : {}),
      },
    ];
  });

  return { nodes, edges };
}

interface ApplicationTopologyCanvasProps {
  model: AppCanvasModel;
  /** Identity of the active module (its filePath) — keys the ReactFlow instance
   *  so each app/lib keeps its own viewport. */
  viewportKey: string;
  /** Saved viewport for this module, or null/undefined to fit on first view. */
  viewport?: CanvasViewport | null;
  /** Persists the viewport after a pan/zoom gesture. */
  onViewportChange?: (viewport: CanvasViewport) => void;
  /** Currently selected resource — highlights the matching node. */
  selectedResource?: { kind: string; name: string } | null;
  /** Active pointer-scoped selection. When it targets a node, that node's
   *  highlight is dropped — a sub-field (in/out type, edge inputs) is focused,
   *  not the whole node. */
  selection?: Selection | null;
  /** Removes a resource. When supplied, pressing Delete / Backspace on the
   *  selected (non-root) node deletes it. */
  onDeleteResource?: (kind: string, name: string) => void;
  /** Peek a node / strip entry in the detail panel. */
  onSelectResource: (kind: string, name: string) => void;
  /** Applies reference writes (drag-to-wire, edge deletion, picker changes).
   *  When omitted the canvas is read-only (no wiring, no edge deletion). */
  onWriteRef?: (writes: RefWrite[]) => void;
  /** Opens a pointer-scoped editor — used when an edge carrying invocation
   *  `inputs` is clicked, to edit those inputs in the detail panel. */
  onSelect?: (selection: Selection) => void;
  /** Opens the create-resource flow. Rendered as a canvas action. */
  onCreateResource?: () => void;
  onBackgroundClick: () => void;
}

/** Module-wide overview graph rendered for the `Telo.Application` /
 *  `Telo.Library` root. Nodes are capability-partitioned (the model decides);
 *  Provider / Type sources live in a collapsible side strip. Each node carries a
 *  rail of reference ports: edge ports drag-to-wire to other nodes, picker ports
 *  select an ambient source inline. When `onWriteRef` is supplied the rail is
 *  editable — dragging from a port wires a ref, deleting a port edge clears it. */
export function ApplicationTopologyCanvas({
  model,
  viewportKey,
  viewport,
  onViewportChange,
  selectedResource,
  selection,
  onDeleteResource,
  onSelectResource,
  onWriteRef,
  onSelect,
  onCreateResource,
  onBackgroundClick,
}: ApplicationTopologyCanvasProps) {
  const [stripOpen, setStripOpen] = useState(true);
  const diagState = useDiagnosticsState();
  const activeFilePaths = useActiveFilePaths();
  const editable = !!onWriteRef;
  const selected = selectedResource ?? null;
  // A pointer-scoped selection focuses a sub-field, so its node's whole-node
  // highlight is dropped.
  const fieldSelected = selection?.resource ?? null;
  // When the active selection is an in/out type field (its schema scopes exactly
  // `inputType` or `outputType`), the matching pill is highlighted instead.
  const selectedTypeField = useMemo<{
    kind: string;
    name: string;
    field: "inputType" | "outputType";
  } | null>(() => {
    if (!selection || selection.pointer !== "") return null;
    const props = isRecord(selection.schema) ? selection.schema.properties : undefined;
    const keys = isRecord(props) ? Object.keys(props) : [];
    const field = keys.length === 1 ? keys[0] : undefined;
    if (field !== "inputType" && field !== "outputType") return null;
    return { ...selection.resource, field };
  }, [selection]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Live count of selected edges — a selected port edge is xyflow's to delete
  // (`onEdgesDelete`), so the node-delete handler stands down when one is set.
  const selectedEdgeCount = useRef(0);

  const onPickRef = useCallback(
    (source: { kind: string; name: string }, concretePath: string, target: string | null) => {
      onWriteRef?.([{ source, concretePath, target }]);
    },
    [onWriteRef],
  );

  const onCreateRef = useCallback(
    (source: { kind: string; name: string }, concretePath: string, kind: string) => {
      onWriteRef?.([{ source, concretePath, target: null, createKind: kind }]);
    },
    [onWriteRef],
  );

  // Opens a focused editor for a node's `inputType` / `outputType` — a
  // pointer-scoped selection over just that field, so the detail panel renders
  // its type control directly. Falls back to a plain node open when the host
  // wires no pointer-scoped selection or the field isn't editable on the node.
  const onEditType = useCallback(
    (node: GraphNode, field: "inputType" | "outputType") => {
      const sig = field === "inputType" ? node.inputType : node.outputType;
      if (onSelect && sig?.fieldSchema) {
        onSelect({
          resource: { kind: node.kind, name: node.name },
          pointer: "",
          schema: { type: "object", properties: { [field]: sig.fieldSchema } },
        });
        return;
      }
      onSelectResource(node.kind, node.name);
    },
    [onSelect, onSelectResource],
  );

  const { nodes, edges } = useMemo(
    () =>
      layout(
        model,
        editable,
        selected,
        fieldSelected,
        selectedTypeField,
        (n) => onSelectResource(n.kind, n.name),
        onPickRef,
        onCreateRef,
        onEditType,
      ),
    [
      model,
      editable,
      selected,
      fieldSelected,
      selectedTypeField,
      onSelectResource,
      onPickRef,
      onCreateRef,
      onEditType,
    ],
  );

  // Delete / Backspace removes the selected non-root node. The listener stands
  // down when a port edge is selected (xyflow owns that deletion) and only fires
  // when focus is on the canvas itself — not when typing or in another panel.
  useEffect(() => {
    if (!onDeleteResource || !selected) return;
    const node = model.nodes.find((n) => n.kind === selected.kind && n.name === selected.name);
    if (!node || node.isRoot) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selectedEdgeCount.current > 0) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body) {
        if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
        if (!wrapperRef.current?.contains(t)) return;
      }
      e.preventDefault();
      onDeleteResource(node.kind, node.name);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDeleteResource, selected, model.nodes]);

  // nodeId → {name, kind, capability} for connection validation / mapping.
  const nodeMeta = useMemo(() => {
    const map = new Map<string, { name: string; kind: string; capability: string }>();
    for (const n of model.nodes) {
      map.set(nodeId(n.kind, n.name), { name: n.name, kind: n.kind, capability: n.capability });
    }
    return map;
  }, [model.nodes]);

  // (nodeId, handleId) → the port slot's concrete path + accepted capabilities.
  // Recovers the write target from a connection's sanitized source handle.
  const portHandleMap = useMemo(() => {
    const map = new Map<string, Map<string, { concretePath: string; capabilities: string[] }>>();
    for (const n of model.nodes) {
      const inner = new Map<string, { concretePath: string; capabilities: string[] }>();
      for (const p of n.ports ?? []) {
        if (p.flavor !== "edge") continue;
        for (const s of p.slots) {
          inner.set(handleId(s.concretePath), { concretePath: s.concretePath, capabilities: p.capabilities });
        }
        if (p.addPath) {
          inner.set(handleId(p.addPath), { concretePath: p.addPath, capabilities: p.capabilities });
        }
      }
      map.set(nodeId(n.kind, n.name), inner);
    }
    return map;
  }, [model.nodes]);

  // A connection is valid when the dragged port accepts the target's capability.
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const slot = portHandleMap.get(c.source ?? "")?.get(c.sourceHandle ?? "");
      const target = nodeMeta.get(c.target ?? "");
      if (!slot || !target) return false;
      return slot.capabilities.includes(target.capability);
    },
    [portHandleMap, nodeMeta],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const slot = portHandleMap.get(c.source ?? "")?.get(c.sourceHandle ?? "");
      const src = nodeMeta.get(c.source ?? "");
      const target = nodeMeta.get(c.target ?? "");
      if (!onWriteRef || !slot || !src || !target) return;
      onWriteRef([
        { source: { kind: src.kind, name: src.name }, concretePath: slot.concretePath, target: target.name },
      ]);
    },
    [portHandleMap, nodeMeta, onWriteRef],
  );

  // Clicking an edge that carries invocation inputs opens the inputs form in the
  // detail panel (runtime CEL fields). Other edges just select/highlight.
  const onEdgeClick = useCallback(
    (_e: unknown, edge: Edge) => {
      const d = edge.data as RefEdgeData | undefined;
      if (d?.inputs && onSelect) {
        onSelect({
          resource: d.source,
          pointer: d.inputs.pointer,
          schema: d.inputs.schema,
          celEval: "runtime",
        });
      }
    },
    [onSelect],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!onWriteRef) return;
      const writes = deleted
        .map((e) => e.data as RefEdgeData | undefined)
        .filter((d): d is RefEdgeData => !!d?.concretePath)
        .map((d) => ({ source: d.source, concretePath: d.concretePath, target: null }));
      if (writes.length) onWriteRef(writes);
    },
    [onWriteRef],
  );

  return (
    <div className="relative flex h-full flex-1">
      <div ref={wrapperRef} className="h-full flex-1">
        <ReactFlow
          key={viewportKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={editable}
          edgesReconnectable={false}
          isValidConnection={isValidConnection}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          onEdgesDelete={onEdgesDelete}
          onSelectionChange={({ edges: sel }) => {
            selectedEdgeCount.current = sel.length;
          }}
          defaultViewport={viewport ?? undefined}
          fitView={!viewport}
          onMoveEnd={(_e, vp) => onViewportChange?.(vp)}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(e, node) => {
            // Interactive children (e.g. signature pills) opt out of node-open
            // so their own click handler — which selects a sub-field — wins.
            if ((e.target as HTMLElement).closest("[data-no-open]")) return;
            (node.data as ResourceNodeData).onOpen();
          }}
          onPaneClick={onBackgroundClick}
        >
          <Background />
          <Controls showInteractive={false} />
          {onCreateResource && (
            <Panel position="top-left">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs shadow-sm"
                onClick={onCreateResource}
              >
                <Plus className="size-3.5" />
                Resource
              </Button>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {model.stripItems.length > 0 && (
        <div className="flex h-full shrink-0 border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {stripOpen ? (
            <div className="w-48 overflow-y-auto p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                  Providers & types
                </span>
                <button
                  className="text-zinc-400 hover:text-zinc-600"
                  onClick={() => setStripOpen(false)}
                  title="Collapse"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {model.stripItems.map((item) => {
                  const summary = summarizeResource(diagState, activeFilePaths, item.name);
                  return (
                    <div key={nodeId(item.kind, item.name)} className="relative">
                      <button
                        className="w-full rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-left hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                        onClick={() => onSelectResource(item.kind, item.name)}
                      >
                        <div className="truncate pr-5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                          {item.name}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-zinc-400">
                          {capLabel(item.capability)}
                        </div>
                      </button>
                      {summary && (
                        <span className="absolute right-1 top-1">
                          <DiagnosticBadge summary={summary} size="sm" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <button
              className="flex w-6 items-center justify-center text-zinc-400 hover:text-zinc-600"
              onClick={() => setStripOpen(true)}
              title="Show providers & types"
            >
              <Boxes className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
