import { isOrderedRow, type GraphNode, type GraphPort, type GraphRow } from "@telorun/analyzer";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Container,
  FileCog,
  ChevronsDown,
  ChevronsUp,
  Braces,
  CornerDownRight,
  Lock,
  Plus,
  Radio,
  Shield,
  SlidersHorizontal,
  Trash2,
  Unplug,
  Eraser,
  FilePlus2,
  Filter,
  CopyMinus,
} from "lucide-react";
import { summarizeResource } from "../../../../diagnostics-aggregate";
import { CREATE_REF_OPTION_PREFIX } from "../../../resource-schema-form/ref-candidates";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/select";
import { DiagnosticBadge } from "../../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../../diagnostics/DiagnosticsContext";
import { severityBorderClass } from "../../../diagnostics/severity";
import { collapsibleProps, isCollapsible, propertyOf, type CollapsibleProp } from "./collapsible";
import { drawnRows } from "./box-geometry";
import { isPickerPort, pickerRows } from "./picker-port";
import { branchingRows } from "./row-tree";

/**
 * One box: a declaration, its declared reference slots, and — when opened — the
 * ordered rows it owns.
 *
 * The box is the whole vocabulary. A port row is a SLOT, filled or not, so an
 * unwired `notFoundHandler` reads as an empty socket rather than as nothing at
 * all; an ordered row is a step, a route or a boot target, drawn in written
 * order because that order is the behaviour. Both carry their own handle, so an
 * edge docks onto the exact slot or row that declares it instead of onto the
 * box as a whole.
 */

/**
 * Where on the viewport a control sits — what a menu opening "here" is anchored
 * to.
 *
 * Viewport coordinates, not canvas ones: the menu is portalled to the document,
 * so a canvas coordinate would have to be transformed by a pan and zoom the menu
 * knows nothing about, and would drift the moment either changed.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A control's own position, so a menu opens at the thing that opened it rather
 *  than at the pointer, which may be anywhere within it. */
function pointOf(event: { currentTarget: Element }): ScreenPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.bottom };
}

/** Handles must survive a name that carries dots and brackets. */
export const handleId = (raw: string): string => raw.replace(/[^A-Za-z0-9_-]/g, "_");

/** Last segment of a slot path, markers stripped — the label when the schema
 *  offers no title. */
function slotLabel(slot: string, titles: Record<string, string>): string {
  return titles[slot] ?? (slot.split(".").pop() ?? slot).replace(/\[\]$|\{\}$/, "");
}

export interface GraphBoxData extends Record<string, unknown> {
  node: GraphNode;
  /** Nesting depth — 0 for a box of its own, deeper for one drawn inside its
   *  owner. Drives the quieter chrome a nested box gets. */
  depth: number;
  /** How many declarations this box draws inside itself. */
  owned: number;
  selected: boolean;
  /** Slot path → label, resolved from the kind schema by the view. */
  portTitles: Record<string, string>;
  /** Ambient holds this box declares, collapsed to `slot → target` chips
   *  instead of edges — for the slots a picker does not already answer. */
  collapsedHolds: { slot: string; targets: string[] }[];
  /** How many ambient holds arrive here — the count that replaces the fan-in. */
  heldBy?: number;
  /** Nothing reaches this declaration: no reference, no boot target. */
  unwired?: boolean;
  /** A way work ENTERS: the module root, or a resource registering an inbound
   *  trigger. Marked on the box, since the flow ranking already puts it left. */
  entryPoint?: boolean;
  /** Zone regions this box OPENS, as `attribute → reason` — what it guarantees
   *  about everything its body reaches. */
  zones?: { site: string; attributes: Readonly<Record<string, string>> }[];
  /** Inside a zone the selected box opens — the region highlight. */
  inZone?: boolean;
  /** Highlighted because it is RELATED to what a drawer has selected: an
   *  instance of the selected kind, or a box that reaches the selected provider
   *  or shape. One ring, because it says one thing — this is what you asked
   *  about — and the drawer says which question was asked. */
  ofSelectedKind?: boolean;
  /** Its module's files cannot be edited from here (a published import). */
  readOnly?: boolean;
  /** Is this branch — or this ROW's subtree — open? A row is addressed by its
   *  own stable id, which cannot collide with a field name. */
  isOpen: (property: string) => boolean;
  /** Open or put away one branch — and, with it, everything only that branch
   *  reaches. Takes a row id just as readily: a body nests, so a `while` is put
   *  away with its contents. */
  onToggleProperty: (property: string) => void;
  onOpen: () => void;
  onSelectRow?: (row: GraphRow) => void;
  /** Move a row within its own array. Absent when the module is not editable
   *  here — a published import has nowhere for the write to land. */
  onMoveRow?: (row: GraphRow, toIndex: number) => void;
  /** Remove a row from its array. */
  onRemoveRow?: (row: GraphRow) => void;
  /** Edit this call's arguments — the map the slot declared for them. */
  onEditRowInputs?: (row: GraphRow) => void;
  /** How many rows share each array, so the last one hides its "down". */
  rowCountByArray?: Record<string, number>;
  /** Append a row to one of this box's ordered arrays. Absent where a write
   *  cannot land. */
  onAddRow?: (array: string) => void;
  /** Human label per array, for the add control (`targets`, `Mounts`). */
  arrayLabels?: Record<string, string>;
  /**
   * This box is a MIRROR: a stand-in for a resource drawn in full elsewhere,
   * put beside the call site that reaches it so a shared utility does not pull
   * a line across the whole picture. It carries a name and a kind and nothing
   * else — there is one original with one configuration and one verdict from
   * the checker, and repeating those per call site is worse than the lines they
   * replaced.
   */
  mirror?: boolean;
  /** How many call sites reach this box in all — said on the ORIGINAL, so the
   *  count survives the mirroring that hid the lines. */
  fanIn?: number;
  /** Wiring by drag is offered from this box's ports — false where a write
   *  cannot land (a published import). */
  connectable?: boolean;
  /** What a picked slot offers: the names already declared that may fill it,
   *  and the kinds one could be created as. Absent when no resolver is in hand,
   *  where the select degrades to showing what is set. */
  pickerOptions?: (port: GraphPort) => { candidates: string[]; createKinds: string[] };
  /** Fill one picked slot, or clear it with `null`. Absent where a write cannot
   *  land, which is what makes the select read-only rather than refusing. */
  onPickRef?: (concretePath: string, target: string | null) => void;
  /** Create a resource of `kind` and fill this slot with it, in ONE write — the
   *  only thing that keeps a slot fillable when nothing of its kind exists. */
  onCreateRef?: (concretePath: string, kind: string) => void;
  /**
   * Offer to create a resource AND wire it, at one concrete site.
   *
   * Beside the socket rather than only through a drag: a drag into empty space
   * is the same gesture and reaches the same picker, but it has to be
   * discovered, cannot be started from the keyboard, and asks for pointer
   * precision a click does not. Absent where a write cannot land.
   */
  onCreateAtSlot?: (concretePath: string, at: ScreenPoint) => void;
  /** Empty one filled site — a reference or a declaration written at it. The
   *  same write in both cases: the slot goes back to being unfilled. */
  onClearSlot?: (concretePath: string) => void;
  /** Give a declaration written at a slot a name and a document of its own,
   *  leaving a reference behind. The one thing that can be done to a
   *  declaration and to nothing else. */
  onExtractInline?: (concretePath: string, kind: string) => void;
}

/** The select value standing in for "nothing" — Radix reserves the empty
 *  string, and a resource name can never contain a space. */
const PICKER_NONE = "· none ·";

function ownershipNote(node: GraphNode): string | null {
  switch (node.ownership) {
    case "inline":
      return "inline";
    case "scoped":
      return "scoped";
    case "imported":
      return node.module ? `from ${node.module}` : "imported";
    case "injected":
      return "supplied";
    default:
      return null;
  }
}

function GraphBox({ data }: NodeProps<Node<GraphBoxData>>) {
  const { node } = data;
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, node.name);
  // A way IN is marked on the node rather than by where it sits: entry points
  // no longer have a lane, since one pulled a whole chain into it.
  const Icon = node.root ? Container : data.entryPoint ? Radio : FileCog;
  const border =
    (summary && severityBorderClass(summary.worstSeverity)) ||
    (node.unknownKind
      ? "border-amber-400 dark:border-amber-500"
      : data.unwired
        ? "border-dashed border-zinc-300 dark:border-zinc-600"
        : "border-zinc-200 dark:border-zinc-700");
  // A `shape` slot names a TYPE — no runtime relation, nothing to wire, and no
  // edge is ever drawn for it — so it is not a socket. It stays in the field
  // form, where a type is edited.
  const note = ownershipNote(node);
  const nested = data.depth > 0;
  if (data.mirror) {
    return (
      <div
        className={`flex h-full w-full items-center gap-1 overflow-hidden rounded border border-dashed bg-zinc-50/70 px-1.5 text-left dark:bg-zinc-900/40 ${
          data.selected || data.ofSelectedKind
            ? "border-indigo-400 dark:border-indigo-500"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
        title={`${node.name} — ${node.kind}, drawn in full elsewhere`}
        onClick={data.onOpen}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!size-1.5 !border-zinc-300 !bg-white dark:!bg-zinc-900"
        />
        <CopyMinus className="size-2.5 shrink-0 text-zinc-400" />
        <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{node.name}</span>
        <span className="ml-auto shrink-0 truncate text-[9px] uppercase tracking-wide text-zinc-300 dark:text-zinc-600">
          {node.kind.split(".").pop()}
        </span>
      </div>
    );
  }

  // The body's tree, walked ONCE per box: the same list the geometry sized this
  // box from, so the rows cannot run past its border.
  const drawn = drawnRows(node, (_id, property) => data.isOpen(property));
  const branching = branchingRows(node.rows);

  return (
    <div
      className={`flex w-full flex-col rounded-md border text-left shadow-sm ${
        nested
          ? "bg-zinc-50/90 dark:bg-zinc-800/60"
          : "bg-white dark:bg-zinc-900"
      } ${border} ${
        data.selected ? "ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
      } ${node.root ? "border-2" : ""} ${
        data.inZone ? "ring-1 ring-violet-300 dark:ring-violet-700" : ""
      } ${data.ofSelectedKind ? "ring-1 ring-indigo-300 dark:ring-indigo-700" : ""}`}
      style={{ height: nested ? "100%" : undefined, minHeight: nested ? undefined : "100%" }}
      onClick={data.onOpen}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !border-zinc-400 !bg-white dark:!bg-zinc-900"
      />
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <Icon className="size-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
          {node.name}
        </span>
        {data.fanIn ? (
          <span
            className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            title={`${data.fanIn} call sites reach this; all but the first are drawn as mirrors`}
          >
            ×{data.fanIn}
          </span>
        ) : null}
        {data.readOnly && (
          <Lock
            className="size-3 shrink-0 text-zinc-400"
            aria-label="published import — its files are not editable here"
          />
        )}
        {data.unwired && (
          <Unplug
            className="size-3 shrink-0 text-zinc-400"
            aria-label="nothing references this, and it is in no targets"
          />
        )}
        {summary && (
          <span data-no-open className="ml-auto shrink-0">
            <DiagnosticBadge summary={summary} size="sm" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="truncate text-[10px] uppercase tracking-wide text-zinc-400">
          {node.unknownKind ? "unresolved kind" : node.kind}
        </span>
        {note && (
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {note}
          </span>
        )}
        {data.heldBy ? (
          <span
            className="ml-auto shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            title={`${data.heldBy} resource(s) hold this`}
          >
            ×{data.heldBy}
          </span>
        ) : null}
      </div>

      {(data.zones ?? []).map((zone) => (
        <div
          key={zone.site}
          className="mx-2 mb-1 flex items-center gap-1 rounded bg-violet-50 px-1 py-0.5 text-[9px] text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
          title={Object.entries(zone.attributes)
            .map(([name, reason]) => `${name}: ${reason}`)
            .join("\n")}
        >
          <Shield className="size-2.5 shrink-0" />
          <span className="truncate">
            {zone.site}
            {Object.keys(zone.attributes).length > 0
              ? ` — ${Object.keys(zone.attributes).join(", ")}`
              : ""}
          </span>
        </div>
      ))}

      {collapsibleProps(node).map((prop) => (
        <PropertyGroup
          key={prop.key}
          prop={prop}
          label={data.arrayLabels?.[prop.key] ?? slotLabel(prop.key, data.portTitles)}
          drawn={drawn}
          branching={branching}
          onToggle={() => data.onToggleProperty(prop.key)}
          data={data}
        />
      ))}
    </div>
  );
}

/**
 * One collapsible branch of a box: its slots, its ordered rows, and — where
 * collapsing it would hide something — the control that puts the whole thing
 * away.
 *
 * Collapsing hides what the branch REACHES, not the branch itself — the header
 * line stays, because it is what reopens it, and because a slot with no socket
 * is a slot nothing can be wired into. A branch that reaches nothing therefore
 * gets no control at all (see `isCollapsible`), and is drawn open.
 */
function PropertyGroup({
  prop,
  label,
  drawn,
  branching,
  onToggle,
  data,
}: {
  prop: CollapsibleProp;
  label: string;
  /** The box's whole visible tree, already capped — filtered here to this
   *  branch rather than re-walked, so every branch agrees with the geometry. */
  drawn: GraphRow[];
  /** Rows that own children, and so carry a control of their own. */
  branching: ReadonlySet<string>;
  onToggle: () => void;
  data: GraphBoxData;
}) {
  const collapsible = isCollapsible(prop);
  const open = !collapsible || data.isOpen(prop.key);
  const rows = open ? drawn.filter((row) => propertyOf(row.array) === prop.key) : [];
  // The count a reader recognises is the array's own length — a `while` is one
  // step, however many statements are inside it.
  const count = prop.rows.filter((row) => !row.parent).length;
  return (
    <>
      {prop.ports.map((port) =>
        isPickerPort(port) ? (
          <PickerPortRows key={port.slot} port={port} label={label} data={data} />
        ) : (
          <PortRow
            key={port.slot}
            port={port}
            label={label}
            collapsed={data.collapsedHolds.find((h) => h.slot === port.slot)?.targets ?? []}
            connectable={(data.connectable ?? false) && open}
            open={open}
            {...(collapsible ? { onToggle } : {})}
            {...(data.onCreateAtSlot ? { onCreate: data.onCreateAtSlot } : {})}
            {...(data.onClearSlot ? { onClear: data.onClearSlot } : {})}
          />
        ),
      )}
      {prop.ordered && (
        <button
          type="button"
          data-no-open
          disabled={!collapsible}
          title={
            collapsible ? (open ? `Put away ${label}` : `Show ${label}`) : `${label} — nothing yet`
          }
          className="nodrag nopan flex h-[18px] w-full items-center gap-1 px-2 text-[10px] text-zinc-400 enabled:hover:bg-zinc-50 enabled:hover:text-zinc-700 dark:enabled:hover:bg-zinc-800 dark:enabled:hover:text-zinc-200"
          onClick={(e) => {
            e.stopPropagation();
            if (collapsible) onToggle();
          }}
        >
          {collapsible &&
            (open ? (
              <ChevronDown className="size-2.5 shrink-0" />
            ) : (
              <ChevronRight className="size-2.5 shrink-0" />
            ))}
          <span className="truncate">{label}</span>
          <span className="ml-auto shrink-0">{count || ""}</span>
        </button>
      )}
      {rows.map((row) => (
        <RowLine
          key={row.id}
          row={row}
          // Last within its OWN array — a nested row's siblings are its branch's,
          // not the whole body's, so the count comes from the array it sits in.
          last={(data.rowCountByArray?.[row.array] ?? 0) - 1 === row.index}
          branches={branching.has(row.id)}
          rowOpen={data.isOpen(row.id)}
          onToggleRow={() => data.onToggleProperty(row.id)}
          onSelect={data.onSelectRow}
          {...(data.onCreateAtSlot && row.dispatch && !row.dispatch.inline && !row.target
            ? { onCreate: (at: ScreenPoint) => data.onCreateAtSlot!(row.dispatch!.path, at) }
            : {})}
          {...(data.onClearSlot && row.dispatch && (row.dispatch.inline || row.target)
            ? { onClear: () => data.onClearSlot!(row.dispatch!.path) }
            : {})}
          {...(data.onExtractInline && row.kind === "inline" && row.declares
            ? { onExtract: () => data.onExtractInline!(row.path, row.declares!) }
            : {})}
          {...(data.onMoveRow ? { onMove: data.onMoveRow } : {})}
          {...(data.onRemoveRow ? { onRemove: data.onRemoveRow } : {})}
          {...(data.onEditRowInputs ? { onEditInputs: data.onEditRowInputs } : {})}
        />
      ))}
      {prop.ordered && open && data.onAddRow && (
        <AddRow label={label} onAdd={() => data.onAddRow!(prop.key)} />
      )}
    </>
  );
}

/** One declared slot. An empty one keeps its socket: the slot exists whether or
 *  not anything fills it, and it is the only thing an editor can offer to fill.
 *  `onToggle` is absent when collapsing would hide nothing — the chevron is
 *  then not drawn at all, and the row's first column goes to the label. */
function PortRow({
  port,
  label,
  collapsed,
  connectable,
  open,
  onToggle,
  onCreate,
  onClear,
}: {
  port: GraphPort;
  label: string;
  collapsed: string[];
  connectable: boolean;
  open: boolean;
  onToggle?: () => void;
  onCreate?: (concretePath: string, at: ScreenPoint) => void;
  onClear?: (concretePath: string) => void;
}) {
  const filled = port.slots.filter((s) => s.target || s.inline);
  const empty = filled.length === 0;
  const filledPath = filled.length === 1 ? filled[0].path : undefined;
  const inlineCount = port.slots.filter((s) => s.inline).length;
  return (
    <div className="group relative flex h-5 items-center gap-1 px-2 text-[10px]">
      {onToggle && (
        <button
          type="button"
          data-no-open
          title={open ? `Put away ${label}` : `Show what ${label} reaches`}
          className="nodrag nopan shrink-0 text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {open ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        </button>
      )}
      <span className={empty ? "truncate text-zinc-400" : "truncate text-zinc-600 dark:text-zinc-300"}>
        {label}
      </span>
      {empty ? (
        <CircleDashed
          className="size-2.5 shrink-0 text-zinc-300 dark:text-zinc-600"
          aria-label="unset — drag from the socket, or set it in the panel"
        />
      ) : collapsed.length > 0 ? (
        <span className="ml-auto truncate text-zinc-500 dark:text-zinc-400">
          {collapsed.join(", ")}
        </span>
      ) : inlineCount > 0 ? (
        <span className="ml-auto text-zinc-400" title="declared inline at this slot">
          inline{inlineCount > 1 ? ` ×${inlineCount}` : ""}
        </span>
      ) : (
        <span className="ml-auto text-zinc-400">{filled.length > 1 ? `×${filled.length}` : ""}</span>
      )}
      {port.slots.map((slot) => (
        <Handle
          key={slot.path}
          id={handleId(slot.path)}
          type="source"
          position={Position.Right}
          isConnectable={connectable}
          className="!size-1.5 !border-zinc-300 !bg-white dark:!border-zinc-600 dark:!bg-zinc-900"
        />
      ))}
      {/* The append slot: dragging from here writes a NEW array item, which is
          the only way to add one without a name to type first. */}
      {port.addPath && (
        <Handle
          id={handleId(port.addPath)}
          type="source"
          position={Position.Right}
          isConnectable={connectable}
          className="!size-1.5 !border-dashed !border-zinc-400 !bg-transparent"
        />
      )}
      {/* An array always has a next site, so it keeps its "add"; a single slot
          that is already filled offers the only other thing it can — emptying
          it. */}
      {port.addPath
        ? onCreate && <SlotButton kind="add" onClick={(at) => onCreate(port.addPath!, at)} />
        : filledPath && onClear
          ? <SlotButton kind="clear" onClick={() => onClear(filledPath)} />
          : onCreate && port.slots[0] && (
              <SlotButton kind="add" onClick={(at) => onCreate(port.slots[0].path, at)} />
            )}
    </div>
  );
}

/**
 * What a slot offers: fill it, or empty it.
 *
 * ONE control, because a slot is in one of two states and the reader is asking
 * about the state it is in — an "add" beside a slot that is already occupied
 * offers a gesture whose only possible meaning is "replace what is here", said
 * by the wrong word. Shown on hover, like a row's own controls: a permanent
 * control on every socket is a lot of chrome for something used once per slot,
 * and the drag into empty space reaches the same picker for anyone who prefers
 * it.
 */
function SlotButton({
  kind,
  onClick,
}: {
  kind: "add" | "clear";
  onClick: (at: ScreenPoint) => void;
}) {
  const Icon = kind === "add" ? Plus : Eraser;
  return (
    <button
      type="button"
      data-no-open
      title={kind === "add" ? "Fill this slot" : "Empty this slot"}
      className="nodrag nopan absolute right-2 hidden rounded p-0.5 text-zinc-400 group-hover:block hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
      onClick={(e) => {
        e.stopPropagation();
        onClick(pointOf(e));
      }}
    >
      <Icon className="size-2.5" />
    </button>
  );
}

/**
 * An ambient hold, as one select per occupancy.
 *
 * A connection, a table, a declared shape is HELD by half the module, so the
 * canvas never draws the edge — it shows the name. Showing it as text left the
 * one field a reader most often wants to change reachable only through the
 * detail panel, while the empty case showed a socket that no line could ever
 * leave. The select is what the old canvas offered for exactly these slots, and
 * what the panel still offers for the same field, so the two agree about what
 * may fill it.
 *
 * Array-valued holds draw a row per entry plus one for the next, which is how a
 * schema's first table is added at all; the label rides the first row, since
 * repeating it down the stack says nothing.
 */
function PickerPortRows({
  port,
  label,
  data,
}: {
  port: GraphPort;
  label: string;
  data: GraphBoxData;
}) {
  const options = data.pickerOptions?.(port) ?? { candidates: [], createKinds: [] };
  return (
    <>
      {pickerRows(port).map((row, index) => (
        <PickerRow
          key={row.path ?? `slot-${index}`}
          label={index === 0 ? label : ""}
          role={row.role}
          value={row.target}
          candidates={options.candidates}
          createKinds={data.onCreateRef ? options.createKinds : []}
          {...(row.path && data.onPickRef
            ? { onPick: (target: string | null) => data.onPickRef!(row.path!, target) }
            : {})}
          {...(row.path && data.onCreateRef
            ? { onCreate: (kind: string) => data.onCreateRef!(row.path!, kind) }
            : {})}
          {...(row.role === "item" && row.path && data.onClearSlot
            ? { onRemove: () => data.onClearSlot!(row.path!) }
            : {})}
        />
      ))}
    </>
  );
}

/** One picked slot: the name it holds, changeable in place. Disabled — rather
 *  than absent — where no write can land, so a published import still reads as
 *  a slot holding something. */
function PickerRow({
  label,
  role,
  value,
  candidates,
  createKinds,
  onPick,
  onCreate,
  onRemove,
}: {
  label: string;
  role: "slot" | "item" | "add";
  value: string | undefined;
  candidates: string[];
  createKinds: string[];
  onPick?: (target: string | null) => void;
  onCreate?: (kind: string) => void;
  /** Take this ENTRY out of its array. Array items only — an array has no
   *  holes, so removing is the only thing emptying one can mean. */
  onRemove?: () => void;
}) {
  // A name written into the slot that no longer resolves is still offered, or
  // opening the select would silently drop what the manifest says.
  const known = value && !candidates.includes(value) ? [value, ...candidates] : candidates;
  return (
    <div className="group flex h-5 items-center gap-1 px-2 text-[10px]" data-no-open>
      <span className="truncate text-zinc-600 dark:text-zinc-300">{label}</span>
      {/* One right-aligned group, so a label lines up with every other label on
          the box whatever controls its own line carries — and so nothing slides
          under the pointer when the remove appears. */}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {/* The line that APPENDS says so. It used to render exactly like a
            filled one, so the only thing marking "add another" was an empty
            select at the bottom of a stack. */}
        {role === "add" && (
          <Plus className="size-2.5 text-zinc-400" aria-label={`Add to ${label || "list"}`} />
        )}
        <Select
          value={value ?? PICKER_NONE}
          disabled={!onPick}
          onValueChange={(next) => {
            if (next.startsWith(CREATE_REF_OPTION_PREFIX)) {
              onCreate?.(next.slice(CREATE_REF_OPTION_PREFIX.length));
              return;
            }
            onPick?.(next === PICKER_NONE ? null : next);
          }}
        >
          <SelectTrigger
            size="sm"
            className="nodrag nopan !h-4 !min-h-0 !gap-1 !rounded !px-1 !py-0 !text-[10px] max-w-[120px] disabled:!opacity-100"
          >
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {role !== "item" && <SelectItem value={PICKER_NONE}>—</SelectItem>}
            {known.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
            {onCreate &&
              createKinds.map((kind) => (
                <SelectItem
                  key={`${CREATE_REF_OPTION_PREFIX}${kind}`}
                  value={`${CREATE_REF_OPTION_PREFIX}${kind}`}
                >
                  New {kind}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {/* The remove's slot is held on EVERY line, not just the lines that
            have one. Held only where the control exists, it aligned those
            selects 20px left of the rest; held only while showing, it slid the
            select out from under the pointer on hover. A row's controls may
            differ; where the row ends may not. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {onRemove && (
            <button
              type="button"
              title="Remove this entry"
              className="nodrag nopan invisible rounded p-0.5 text-zinc-400 group-hover:visible hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Trash2 className="size-2.5" />
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * One ordered entry, drawn in written order because the order is behaviour —
 * and moved with controls rather than dragged.
 *
 * A drag inside a canvas node competes with the canvas's own pan, and the two
 * gestures are indistinguishable until one of them wins; explicit controls say
 * what they do, work from the keyboard, and cannot be started by accident on a
 * surface whose primary gesture is panning.
 */
function RowLine({
  row,
  last,
  branches,
  rowOpen,
  onToggleRow,
  onCreate,
  onClear,
  onExtract,
  onSelect,
  onMove,
  onRemove,
  onEditInputs,
}: {
  row: GraphRow;
  last: boolean;
  /** This row owns a body — a `while`'s `do`, an `if`'s arms, a `switch`'s
   *  cases — so it carries the control that puts that body away. */
  branches: boolean;
  rowOpen: boolean;
  onToggleRow: () => void;
  /** Create a resource and wire it into this row's own dispatch — a step's
   *  `invoke:`, a route's `handler:`, a boot target. Absent once the slot is
   *  filled, where {@link onClear} takes its place, and where a write cannot
   *  land. */
  onCreate?: (at: ScreenPoint) => void;
  /** Empty this row's dispatch, whether it holds a reference or a declaration
   *  written at the site. */
  onClear?: () => void;
  /** Give this declaration a name and a document of its own. `inline` rows
   *  only — it is the one thing that can be done to a declaration and to
   *  nothing else. */
  onExtract?: () => void;
  onSelect?: (row: GraphRow) => void;
  onMove?: (row: GraphRow, toIndex: number) => void;
  onRemove?: (row: GraphRow) => void;
  onEditInputs?: (row: GraphRow) => void;
}) {
  // What the row IS, in the order a reader recognizes it by: its declared name,
  // else what matches it, else what it dispatches to — a boot target has none of
  // the first two and is entirely "run this". The concrete path is the last
  // resort, and says nothing a reader wanted.
  const matched = row.match ? Object.values(row.match).filter(Boolean).join(" ") : undefined;
  // A DECLARATION written at the site is named by the kind it declares — there
  // is nothing elsewhere to point at, so the kind is the whole identity.
  //
  // What a statement IS comes from the branch it matched. The chip reads the
  // author's own title where there is one, and the branch's IDENTITY otherwise
  // — never a segment sliced out of the title, which was a vocabulary hidden
  // inside prose the author is free to reword.
  const keyword = row.variantLabel ?? row.variant;
  const named = row.declares ?? row.name ?? matched ?? row.target;
  const label = named ?? keyword ?? row.path;
  const chip = named && keyword ? keyword : undefined;
  // Suppress the arrow when the label already IS the target.
  const dispatch = row.target && label !== row.target ? row.target : undefined;
  // Reordering and removal are for ORDERED entries: a declaration has no
  // sibling to be moved past, and removing it is an edit to its host's config
  // rather than a splice.
  const ordered = isOrderedRow(row);
  const RowIcon = row.kind === "inline" ? Braces : row.kind === "reference" ? CornerDownRight : null;
  return (
    <div
      className="group relative flex h-5 cursor-pointer items-center gap-1 px-2 text-[10px] hover:bg-zinc-50 dark:hover:bg-zinc-800"
      style={{ paddingLeft: 8 + row.depth * 10 }}
      data-no-open
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(row);
      }}
    >
      {/* A leaf keeps the column a branch's chevron occupies — siblings of one
          depth line up, which is the whole readability of a tree. */}
      {branches ? (
        <button
          type="button"
          title={rowOpen ? "Put away this body" : "Show this body"}
          className="nodrag nopan shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          onClick={(e) => {
            e.stopPropagation();
            onToggleRow();
          }}
        >
          {rowOpen ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        </button>
      ) : (
        <span className="size-2.5 shrink-0" />
      )}
      {RowIcon && <RowIcon className="size-2.5 shrink-0 text-zinc-400" />}
      {chip && (
        <span
          className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          title={row.variantLabel ?? row.variant}
        >
          {chip}
        </span>
      )}
      <span
        className={
          row.kind === "inline"
            ? "truncate font-medium text-zinc-500 dark:text-zinc-400"
            : "truncate text-zinc-700 dark:text-zinc-200"
        }
        title={row.kind === "inline" ? "declared here — click to edit it" : undefined}
      >
        {label}
      </span>
      {row.unknownKind && (
        <span className="shrink-0 text-[9px] text-amber-500" title="this kind resolves to nothing">
          ?
        </span>
      )}
      {/* The expression this statement turns on. It takes the right-hand side
          when there is no target to name there — for a loop it IS the
          behaviour — and shrinks to a marker beside the arrow when there is,
          because what a dispatch calls outranks whether it is guarded. */}
      {row.predicate && !dispatch && (
        <span
          className="ml-auto truncate font-mono text-[9px] text-zinc-400"
          title={row.predicate}
        >
          {row.predicate}
        </span>
      )}
      {row.predicate && dispatch && (
        <Filter className="ml-auto size-2.5 shrink-0 text-zinc-400" aria-label={row.predicate} />
      )}
      {dispatch && (
        <span
          className={`${row.predicate ? "" : "ml-auto "}truncate text-zinc-400`}
          title={`dispatches ${dispatch}`}
        >
          → {dispatch}
        </span>
      )}
      <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {onCreate && (
          <RowButton title="Create a resource and wire it here" onClick={onCreate}>
            <Plus className="size-2.5" />
          </RowButton>
        )}
        {onClear && (
          <RowButton title="Empty this slot" onClick={onClear}>
            <Eraser className="size-2.5" />
          </RowButton>
        )}
        {onExtract && (
          <RowButton
            title="Give this its own name and document, leaving a reference here"
            onClick={onExtract}
          >
            <FilePlus2 className="size-2.5" />
          </RowButton>
        )}
        {onEditInputs && row.inputs && (
          <RowButton title="Edit this call's arguments" onClick={() => onEditInputs(row)}>
            <SlidersHorizontal className="size-2.5" />
          </RowButton>
        )}
        {ordered && onMove && row.index > 0 && (
          <RowButton title="Move up — order is behaviour" onClick={() => onMove(row, row.index - 1)}>
            <ChevronsUp className="size-2.5" />
          </RowButton>
        )}
        {ordered && onMove && !last && (
          <RowButton title="Move down" onClick={() => onMove(row, row.index + 1)}>
            <ChevronsDown className="size-2.5" />
          </RowButton>
        )}
        {ordered && onRemove && (
          <RowButton title="Remove" onClick={() => onRemove(row)}>
            <Trash2 className="size-2.5" />
          </RowButton>
        )}
      </span>
      {/* A socket is where a wire can START. A slot already holding a
          DECLARATION cannot take one without destroying what is written there,
          and a declaration row dispatches nothing of its own — its references
          are the rows beneath it — so neither draws one. Offering a socket that
          can only refuse is the defect this whole rail exists to avoid. */}
      {row.kind !== "inline" && !row.dispatch?.inline && (
        <Handle
          id={handleId(row.path)}
          type="source"
          position={Position.Right}
          className="!size-1.5 !border-zinc-300 !bg-white dark:!border-zinc-600 dark:!bg-zinc-900"
        />
      )}
    </div>
  );
}

/**
 * Append a row to an ordered array — the last thing a canvas of ordered lists
 * was missing, since a reader could reorder and remove what was there and had
 * nowhere to add.
 *
 * It writes an EMPTY entry and opens it in the panel: what a new step or route
 * must contain is the kind's business, not the canvas's, and a form over the
 * item's own schema is where that is answered. The manifest is briefly
 * incomplete and says so through the ordinary diagnostics — which is the honest
 * state of a route someone has just started writing.
 */
function AddRow({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <button
      type="button"
      data-no-open
      title={`Add to ${label}`}
      className="nodrag nopan flex h-5 w-full items-center gap-1 px-2 text-[10px] text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      <Plus className="size-2.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A row's own control: `nodrag`/`nopan` so the canvas does not read the press
 *  as the start of a pan. */
function RowButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (at: ScreenPoint) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-no-open
      title={title}
      className="nodrag nopan rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
      onClick={(e) => {
        e.stopPropagation();
        onClick(pointOf(e));
      }}
    >
      {children}
    </button>
  );
}

export const moduleGraphNodeTypes = { box: GraphBox };
