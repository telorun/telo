import type { GraphKind, GraphNode } from "@telorun/analyzer";
import { Braces, ChevronRight, Database, Layers, PackageOpen, Shapes } from "lucide-react";
import { summarizeResource } from "../../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../../diagnostics/DiagnosticsContext";
import { groupTotal, isEmpty, type DrawerGroups } from "./drawer-groups";

/**
 * Everything the module has that is not one of its own boxes, as one drawer
 * beside the canvas.
 *
 * It is ONE drawer rather than two because a reader asking "what else is in
 * this module" asks it once: a panel per category made the answer depend on
 * guessing which panel a thing had been filed under, and two collapsed handles
 * spent twice the chrome on the same question. The groups are the filing, and
 * they split by WHY a thing is not a box — held rather than run, a type with no
 * instance, declared in another module — never by taste.
 *
 * The two halves behave differently and the drawer says so by what selecting a
 * row does. A provider or a type has LEFT the canvas, so selecting it rings
 * every box that reaches it — the ring is what stands in for the line. An
 * imported kind rings the instances declared of it, and an imported resource is
 * still a box, so selecting it selects that box: the row is a way to find it,
 * not a replacement for it.
 */
export interface ModuleDrawerProps {
  groups: DrawerGroups;
  /** How many boxes hold each off-canvas declaration, by node id — the fan-in
   *  the canvas no longer draws. */
  heldBy: ReadonlyMap<string, number>;
  open: boolean;
  onToggle: () => void;
  /** Set when the module declares no boxes — then this IS the canvas. */
  sole: boolean;
  /** Kind id whose instances are highlighted. */
  selectedKind: string | null;
  onSelectKind: (kindId: string | null) => void;
  selectedResource: { kind: string; name: string } | null;
  onSelectResource: (kind: string, name: string) => void;
}

export function ModuleDrawer({
  groups,
  heldBy,
  open,
  onToggle,
  sole,
  selectedKind,
  onSelectKind,
  selectedResource,
  onSelectResource,
}: ModuleDrawerProps) {
  if (isEmpty(groups)) return null;
  const shown = sole || open;
  const picked = (node: GraphNode) =>
    selectedResource?.kind === node.kind && selectedResource?.name === node.name;

  return (
    <div
      className={`flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${
        sole ? "flex-1" : shown ? "w-64" : "w-9"
      }`}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 border-b border-zinc-100 px-2 py-1.5 text-left dark:border-zinc-800"
        onClick={onToggle}
        title={shown ? "Hide" : `${groupTotal(groups)} not drawn on the canvas`}
      >
        <Shapes className="size-3.5 shrink-0 text-zinc-400" />
        {shown && (
          <>
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Module</span>
            <span className="ml-auto text-[10px] text-zinc-400">{groupTotal(groups)}</span>
            {!sole && <ChevronRight className="size-3 shrink-0 text-zinc-400" />}
          </>
        )}
      </button>
      {shown && (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <Group label="Providers" count={groups.providers.length}>
            {groups.providers.map((node) => (
              <InstanceRow
                key={node.id}
                node={node}
                icon={Database}
                held={heldBy.get(node.id) ?? 0}
                selected={picked(node)}
                onSelect={onSelectResource}
              />
            ))}
          </Group>
          <Group label="Types" count={groups.types.length}>
            {groups.types.map((node) => (
              <InstanceRow
                key={node.id}
                node={node}
                icon={Braces}
                held={heldBy.get(node.id) ?? 0}
                selected={picked(node)}
                onSelect={onSelectResource}
              />
            ))}
          </Group>
          <Group label="Kinds" count={groups.kinds.length}>
            {groups.kinds.map((kind) => (
              <KindRow
                key={kind.id}
                kind={kind}
                selected={selectedKind === kind.id}
                onSelect={onSelectKind}
              />
            ))}
          </Group>
          <Group label="Resources" count={groups.resources.length}>
            {groups.resources.map((node) => (
              <InstanceRow
                key={node.id}
                node={node}
                icon={PackageOpen}
                held={heldBy.get(node.id) ?? 0}
                selected={picked(node)}
                onSelect={onSelectResource}
              />
            ))}
          </Group>
        </div>
      )}
    </div>
  );
}

/** A group with nothing in it draws no heading: an empty label is a claim the
 *  module has a category it does not have. */
function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <>
      <div className="mt-1 flex items-center gap-1 px-1.5 pb-0.5 pt-1 text-[9px] uppercase tracking-widest text-zinc-400">
        <span>{label}</span>
        <span className="ml-auto">{count}</span>
      </div>
      {children}
    </>
  );
}

/**
 * One declaration that is not a box: what it is, how many boxes reach it, and
 * whatever the checker has to say about it — which is why these are listed
 * rather than dropped.
 */
function InstanceRow({
  node,
  icon: Icon,
  held,
  selected,
  onSelect,
}: {
  node: GraphNode;
  icon: typeof Database;
  held: number;
  selected: boolean;
  onSelect: (kind: string, name: string) => void;
}) {
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, node.name);
  return (
    <button
      type="button"
      className={`flex w-full flex-col items-start gap-0.5 rounded px-1.5 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
        selected ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
      }`}
      onClick={() => onSelect(node.kind, node.name)}
      title={held > 0 ? `reached by ${held} resource(s)` : "nothing reaches this"}
    >
      <div className="flex w-full items-center gap-1">
        <Icon className="size-2.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
          {node.name}
        </span>
        {summary && (
          <span className="ml-auto shrink-0">
            <DiagnosticBadge summary={summary} size="sm" />
          </span>
        )}
      </div>
      <div className="flex w-full items-center gap-1 pl-3.5 text-[10px] text-zinc-400">
        <span className="truncate">{node.unknownKind ? "unresolved kind" : node.kind}</span>
        <span className="ml-auto shrink-0">{held > 0 ? `×${held}` : "—"}</span>
      </div>
    </button>
  );
}

/** One kind: what it is, what it specializes, and how many instances exist. */
function KindRow({
  kind,
  selected,
  onSelect,
}: {
  kind: GraphKind;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full flex-col items-start gap-0.5 rounded px-1.5 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
        selected ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
      }`}
      onClick={() => onSelect(selected ? null : kind.id)}
    >
      <div className="flex w-full items-center gap-1">
        <span className="min-w-0 truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
          {kind.name}
        </span>
        {kind.abstract && (
          <span
            className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            title="Abstract — no default implementation, must be extended"
          >
            abstract
          </span>
        )}
        {kind.template && (
          <span
            className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            title="Declares a body of its own rather than naming a controller"
          >
            template
          </span>
        )}
        {kind.exported === false && (
          <span
            className="shrink-0 rounded bg-amber-50 px-1 text-[9px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-500"
            title="Not listed in exports.kinds — an importer cannot construct one"
          >
            private
          </span>
        )}
        {kind.instances.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-400" title="instances declared">
            ×{kind.instances.length}
          </span>
        )}
      </div>
      <div className="flex w-full items-center gap-1 text-[10px] text-zinc-400">
        <span className="truncate">{kind.capability ?? "—"}</span>
        {(kind.extendsId ?? kind.extendsName) && (
          <span className="ml-auto flex min-w-0 items-center gap-0.5" title="specializes">
            <Layers className="size-2.5 shrink-0" />
            <span className="truncate">{shortKind(kind.extendsId ?? kind.extendsName!)}</span>
          </span>
        )}
      </div>
    </button>
  );
}

/** `notify.Webhook` → `Webhook`: the module is already the row above it. */
function shortKind(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot > 0 ? id.slice(dot + 1) : id;
}
