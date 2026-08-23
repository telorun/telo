import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, ChevronRight, GripVertical, Plus, X } from "lucide-react";
import { useMemo } from "react";
import { isModuleRootKind } from "../../../../application-adapter";
import { summarizeResource } from "../../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../../diagnostics/DiagnosticsContext";
import { Button } from "../../../ui/button";
import { buildEntryList, entryListOf, type EntryRow } from "../entry-list-model";
import { summarizeValue } from "../value-summary";
import type { TopologyViewProps } from "../topology-view";

/** A stable empty list, so a kind with no entries written yet does not hand the
 *  model a fresh array reference on every render. */
const NO_ENTRIES: readonly unknown[] = [];

/**
 * The list of configured entries a resource holds — `Http.Server`'s mounts, an
 * `Mcp.Tools`' advertised tools, an `Http.Api`'s routes.
 *
 * The same treatment as the boot sequence and a step body, because it is the
 * same shape: an array of entries each naming what it dispatches to. It
 * replaced reading mounts off the containment graph, which drew the resource an
 * entry NAMES and nothing else — losing the entry's own configuration (a
 * mount's path, a tool's description) and its position in the list. For a mount
 * the position is match order, so that loss was silent rather than cosmetic;
 * for a tool it is merely the order the author wrote them in.
 *
 * Every edit is a named AST operation against one node (`onMoveField` /
 * `onRemoveField`), so an entry keeps the `!ref` tag, quote style and comments
 * its author attached to it. Only appending goes through a field write, which
 * rewrites nothing.
 *
 * It names no kind and no field. The whole grammar is read through
 * {@link entryListOf}: `entries` on the array, `matcher` on the field that
 * selects one, `handler` on the reference it dispatches to — so a second kind
 * with an entry list needs the annotations and nothing here.
 */
export function EntriesView({
  resource,
  schema,
  viewData,
  selection,
  canFocus,
  onFocusResource,
  onSelect,
  onSelectResource,
  onUpdateResource,
  onMoveField,
  onRemoveField,
  onBackgroundClick,
  hideHeader,
}: TopologyViewProps) {
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, resource.name);

  const list = useMemo(() => entryListOf(schema), [schema]);
  const entries: readonly unknown[] =
    list && Array.isArray(resource.fields[list.name])
      ? (resource.fields[list.name] as unknown[])
      : NO_ENTRIES;

  const rows = useMemo(() => {
    if (!list) return [];
    return buildEntryList({
      entries,
      list,
      pointer: `/${list.name}`,
      declared: new Set(
        viewData.manifest.resources.filter((r) => !isModuleRootKind(r.kind)).map((r) => r.name),
      ),
    });
  }, [list, entries, viewData]);

  const target = { kind: resource.kind, name: resource.name };
  const editable = !!onMoveField && !!onRemoveField;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || !list) return;
    const from = rows.find((row) => row.pointer === String(active.id));
    const to = rows.find((row) => row.pointer === String(over.id));
    if (!from || !to) return;
    onMoveField?.(target, from.pointer, to.index);
  }

  /** Appends an empty entry and opens it. Empty because there is nothing to
   *  guess — an entry's whole point is the resource it names — so the form is
   *  opened on it straight away rather than leaving a blank row on the list. */
  function addEntry() {
    if (!list) return;
    onUpdateResource(resource.kind, resource.name, {
      ...resource.fields,
      [list.name]: [...entries, {}],
    });
    onSelect({
      resource: target,
      pointer: `/${list.name}/${entries.length}`,
      schema: list.itemSchema,
    });
  }

  if (!list) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-900">
        <p className="max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">
          This kind declares no entry list — no field is annotated{" "}
          <code className="font-mono text-xs">x-telo-topology-role: entries</code> with items
          naming a handler.
        </p>
      </div>
    );
  }

  const label = typeof list.itemSchema.title === "string" ? list.itemSchema.title : "entry";

  return (
    <div
      className="h-full flex-1 overflow-y-auto bg-zinc-50 p-4 dark:bg-zinc-900"
      onClick={onBackgroundClick}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {!hideHeader && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {resource.name}
              </h2>
              <DiagnosticBadge summary={summary} size="sm" stopPropagation={false} />
              <span className="shrink-0 font-mono text-[10px] text-zinc-400">{resource.kind}</span>
            </div>
            {editable && (
              <Button size="xs" variant="outline" onClick={addEntry}>
                <Plus className="size-3" />
                Add {label.toLowerCase()}
              </Button>
            )}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-4 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            No entries yet.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={rows.map((row) => row.pointer)}
              strategy={verticalListSortingStrategy}
            >
              {/* An ordered list, numbered: for a mount the position IS the
                  match order, and for the rest it is at least what the author
                  wrote — neither of which a set of nodes can show. */}
              <ol className="flex flex-col gap-1">
                {rows.map((row) => (
                  <EntryRowView
                    key={row.pointer}
                    row={row}
                    target={target}
                    editable={editable}
                    open={selection?.pointer === row.pointer}
                    focusable={!!row.target && canFocus(row.target)}
                    onOpen={() =>
                      onSelect({ resource: target, pointer: row.pointer, schema: row.schema })
                    }
                    onOpenTarget={() => {
                      if (!row.target) return;
                      const declared = viewData.manifest.resources.find(
                        (r) => r.name === row.target,
                      );
                      if (declared) onSelectResource(declared.kind, declared.name);
                      if (canFocus(row.target)) onFocusResource(row.target);
                    }}
                    onRemove={
                      onRemoveField ? () => onRemoveField(target, row.pointer) : undefined
                    }
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function EntryRowView({
  row,
  editable,
  open,
  focusable,
  onOpen,
  onOpenTarget,
  onRemove,
}: {
  row: EntryRow;
  target: { kind: string; name: string };
  editable: boolean;
  open: boolean;
  focusable: boolean;
  onOpen: () => void;
  onOpenTarget: () => void;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.pointer, disabled: !editable });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 dark:bg-zinc-950 ${
          open
            ? "border-indigo-300 dark:border-indigo-800"
            : "border-zinc-200 dark:border-zinc-800"
        }`}
      >
        {editable && (
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600"
            title="Drag to reorder"
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <span className="w-5 shrink-0 text-right font-mono text-[10px] text-zinc-400">
          {row.index + 1}
        </span>
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <span className="flex items-center gap-1.5">
            {/* The MATCHER leads: it is what tells one entry from the next —
                two mounts of the same API differ only in their path, and two
                tools only in their name. The target follows on the line below,
                where it does not have to compete with it. */}
            <span className="truncate text-sm text-zinc-800 dark:text-zinc-100">
              {row.matcher
                ? summarizeValue(row.matcher.value)
                : (row.target ?? "(nothing attached)")}
            </span>
            {row.unresolved && (
              <span
                className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                title={`No resource named ${row.target} is declared in this module`}
              >
                <AlertTriangle className="size-3" />
                unresolved
              </span>
            )}
          </span>
          {(row.matcher || row.fields.length > 0) && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">
              {[
                // Shown once the matcher took the title, so the row never omits
                // what it dispatches to.
                row.matcher ? `→ ${row.target ?? "nothing"}` : null,
                ...row.fields.map((f) => `${f.name}: ${summarizeValue(f.value)}`),
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </span>
          )}
        </button>
        {focusable && (
          <button
            className="shrink-0 rounded text-zinc-300 hover:text-zinc-500 dark:text-zinc-600"
            onClick={onOpenTarget}
            title={`Open ${row.target}`}
          >
            <ChevronRight className="size-4" />
          </button>
        )}
        {onRemove && (
          <button
            className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
            onClick={onRemove}
            title="Remove this entry"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}
