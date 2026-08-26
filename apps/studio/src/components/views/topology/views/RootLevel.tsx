import {
  DndContext,
  PointerSensor,
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
import { makeTaggedSentinel } from "@telorun/templating";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { isModuleRootKind } from "../../../../application-adapter";
import {
  findResourceReferences,
  type ResourceReference,
} from "../../../../resource-references";
import { Button } from "../../../ui/button";
import type { GraphNode, TypeSignature } from "../application-canvas-model";
import { buildBootModel, type BootTarget } from "../boot-model";
import { ReferencesBlockedDialog } from "../ReferencesBlockedDialog";
import type { TopologyViewProps } from "../topology-view";

/**
 * The TOP level of the containment tree, which is a list rather than a graph.
 *
 * `targets:` is a FLAT boot sequence, so a graph here draws a list as a DAG and
 * asks the reader to recover an order the picture does not carry; a Library's
 * top level is its export surface, which is a set. The graph earns its keep one
 * level down — a router's routes, a sequence's steps — which is what the levels
 * view renders below this one. That is why this is not a view of its own: which
 * renderer a level gets follows from what the level IS, and offering the reader
 * a list and a graph of the same root as alternatives asked them to choose
 * between an ordered thing and a picture that cannot show the order.
 *
 * It edits POSITIONS, which is why every mutation goes through a named AST
 * operation (`onMoveField` / `onRemoveField`) rather than through a whole-field
 * write. A field diff is positional, so reordering or dropping one entry reads
 * as "rewrite every index in between" and re-serializes each from plain data —
 * losing the `!ref` tag, the quote style and the comments the author attached to
 * the entries, silently. Appending is the one exception and goes through the
 * ordinary field write: a new last index rewrites nothing.
 */
export function RootLevel({
  viewData,
  registry,
  tree,
  model: canvasModel,
  resource,
  selectedResource,
  selection,
  canFocus,
  onFocusResource,
  onSelect,
  onSelectResource,
  onUpdateResource,
  onDeleteResource,
  onMoveField,
  onRemoveField,
  onCreateResource,
  onBackgroundClick,
}: TopologyViewProps) {
  const manifest = viewData.manifest;
  const isApplication = manifest.kind === "Application";
  // A Library's counterpart to `targets`: what importers may reach. Only the
  // bare entries name something this module declares — `<Alias>.<name>`
  // re-exports someone else's instance, which is not in this graph.
  const exported = isApplication
    ? []
    : (manifest.exports?.resources ?? []).filter((name) => !name.includes("."));
  const targets: unknown[] = Array.isArray(resource.fields.targets)
    ? (resource.fields.targets as unknown[])
    : [];

  const model = useMemo(
    () => {
      // The canvas already resolved every node's signature with the right
      // precedence — the instance's own `inputType:` / `outputType:` first, then
      // the kind's — including named `Telo.Type` lookups. Reading it back is
      // what keeps this list and the canvas's signature pills from disagreeing.
      const byName = new Map((canvasModel?.nodes ?? []).map((n) => [n.name, n] as const));
      return buildBootModel(
        targets,
        manifest.resources.filter((r) => !isModuleRootKind(r.kind)).map((r) => r.name),
        tree,
        manifest.kind === "Library" ? (manifest.exports?.resources ?? []) : [],
        canvasModel?.stripItems ?? [],
        (name) => {
          const node = byName.get(name);
          return node ? { input: node.inputType, output: node.outputType } : undefined;
        },
      );
    },
    // `targets` is read off `resource.fields` each render; keying on the array
    // identity is what the host's own memoization already gives us.
    [resource.fields.targets, manifest, tree, canvasModel],
  );

  // Resolved through the canvas model first, so an exported instance reads
  // exactly as it does everywhere else; an exported PROVIDER is not in the
  // relation at all, so the manifest is the fallback.
  const exportedNodes = useMemo<GraphNode[]>(
    () =>
      exported.flatMap((name) => {
        const node = tree?.nodeById.get(name) ?? canvasModel?.stripItems.find((n) => n.name === name);
        if (node) return [node];
        const declared = manifest.resources.find((r) => r.name === name);
        return declared
          ? [
              {
                kind: declared.kind,
                name,
                capability: viewData.kinds.get(declared.kind)?.capability ?? "",
              },
            ]
          : [];
      }),
    [exported, tree, canvasModel, manifest, viewData],
  );

  const target = { kind: resource.kind, name: resource.name };
  const editable = !!onMoveField && !!onRemoveField;
  const [blocked, setBlocked] = useState<{ name: string; references: ResourceReference[] } | null>(
    null,
  );

  // A pointer-based sensor with a small activation distance: a row is clickable
  // AND draggable, and without a threshold every click starts a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !onMoveField) return;
    const from = Number(active.id);
    const to = Number(over.id);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    onMoveField(target, `/targets/${from}`, to);
  }

  /** Appends a boot target naming `name`. A `!ref` sentinel, never a bare
   *  string: the plain form is legacy, and writing it would author a spelling
   *  the formatter normalizes away on the next round trip. */
  function addTarget(name: string) {
    onUpdateResource(resource.kind, resource.name, {
      ...resource.fields,
      targets: [...targets, makeTaggedSentinel("ref", name)],
    });
  }

  /**
   * Opens the row's resource: into the detail panel always, and INTO the canvas
   * when there is an interior to enter.
   *
   * Both, because they answer different questions and a boot row raises both —
   * the panel says how this entry is configured, the focus says what it runs. A
   * leaf is panel-only: focusing it would replace this list with the same field
   * form the panel is already rendering, which costs the reader their place and
   * shows them nothing new. `canFocus` is the host's answer, resolved through
   * the view registry, so this list cannot disagree with what focusing does.
   */
  function open(name: string | undefined) {
    if (!name) return;
    const declared = manifest.resources.find((r) => r.name === name);
    if (declared) onSelectResource(declared.kind, declared.name);
    if (canFocus(name)) onFocusResource(name);
  }

  /**
   * Deletes a resource, or reports what stops it.
   *
   * Asked at the moment of the delete rather than carried on each row: the
   * answer is a walk of the whole module per resource, and a list of a dozen
   * providers would run it a dozen times on every render to grey out a button
   * nobody pressed. A row that cannot be deleted therefore looks the same as one
   * that can, and finds out on the click — which is the honest arrangement
   * anyway, since the reason has to be shown either way.
   */
  function remove(node: { kind: string; name: string }) {
    if (!onDeleteResource) return;
    // No registry means the analysis has not finished, so the reference set is
    // UNKNOWN — not empty. Reading it as empty made the guard fail open on the
    // one input that means "I cannot answer", deleting unchecked exactly when
    // there was least reason to trust it. Reported as a blocked delete with no
    // references listed, which is what "ask again in a moment" looks like here.
    if (!registry) {
      setBlocked({ name: node.name, references: [] });
      return;
    }
    const found = findResourceReferences(registry, manifest, node.name);
    if (found.length === 0) {
      onDeleteResource(node.kind, node.name);
      return;
    }
    setBlocked({ name: node.name, references: found });
  }

  return (
    <div
      className="h-full flex-1 overflow-y-auto bg-zinc-50 p-4 dark:bg-zinc-900"
      onClick={onBackgroundClick}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {/* The create action lives here because this level is where a resource
            is declared with nothing holding it yet — the levels below draw the
            interior of something that already exists. */}
        {/* Left, not right: the view picker floats over this column's top-right
            corner, and on a narrow window the column reaches it. */}
        {onCreateResource && (
          <div className="flex justify-start">
            <Button size="xs" variant="outline" onClick={onCreateResource}>
              <Plus className="size-3" />
              New resource
            </Button>
          </div>
        )}

        {isApplication ? (
          <section>
            <SectionHeading
              title="Boot sequence"
              hint={
                model.targets.length > 0
                  ? "Runs top to bottom once every resource has initialized."
                  : undefined
              }
            />
            {model.targets.length === 0 ? (
              <Empty>
                No targets. Work is carried by services that start on their own — which is valid,
                not a gap.
              </Empty>
            ) : (
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={model.targets.map((t) => String(t.index))}
                  strategy={verticalListSortingStrategy}
                >
                  <ol className="flex flex-col gap-1">
                    {model.targets.map((t) => (
                      <TargetRow
                        key={t.index}
                        entry={t}
                        editable={editable}
                        focusable={!!t.name && canFocus(t.name)}
                        active={
                          !!t.name &&
                          selectedResource?.name === t.name &&
                          !isModuleRootKind(selectedResource.kind)
                        }
                        onOpen={() => open(t.name)}
                        // Runtime CEL: a step's arguments are evaluated at
                        // dispatch, so every field offers the expression toggle
                        // — the same mode a canvas edge's inputs open in.
                        onEditInputs={
                          t.inputs
                            ? () =>
                                onSelect({
                                  resource: target,
                                  pointer: t.inputs!.pointer,
                                  schema: t.inputs!.schema,
                                  celEval: "runtime",
                                })
                            : undefined
                        }
                        inputsOpen={selection?.pointer === t.inputs?.pointer}
                        onRemove={
                          onRemoveField
                            ? () => onRemoveField(target, `/targets/${t.index}`)
                            : undefined
                        }
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            )}
          </section>
        ) : null}

        {/* A Library's top level is its public surface. Without it the root of a
            library would list only what nothing references — which excludes the
            exports by design, so the one view of the module would have been
            emptiest for the library that exports the most. A name that resolves
            to no resource is left out: that is a broken export, reported where
            it is declared, not a row here. */}
        {exportedNodes.length > 0 && (
          <section>
            <SectionHeading
              title="Exported"
              hint="Instances importers may reference as `!ref <Alias>.<name>`."
            />
            <ul className="flex flex-col gap-1">
              {exportedNodes.map((node) => (
                <ResourceRow
                  key={node.name}
                  node={node}
                  focusable={canFocus(node.name)}
                  onOpen={() => open(node.name)}
                />
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionHeading
            title="Not wired up"
            hint="Declared here, but no reference reaches them — no boot target and no other resource's slot."
          />
          {model.unreferenced.length === 0 ? (
            <Empty>Every resource this module declares is reached by a reference.</Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {model.unreferenced.map((node) => (
                <ResourceRow
                  key={node.name}
                  node={node}
                  focusable={canFocus(node.name)}
                  onOpen={() => open(node.name)}
                  onDelete={onDeleteResource ? () => remove(node) : undefined}
                  action={
                    isApplication ? (
                      <Button size="xs" variant="outline" onClick={() => addTarget(node.name)}>
                        <Plus className="size-3" />
                        Boot
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </section>

        {/* Listed here rather than in the host's rail, which exists because a
            CANVAS cannot draw them — and directly under the unwired list,
            because otherwise they read as a silent counterexample to it: no
            reference reaches them either, and nothing on screen would say why
            that is expected of them and not of the rows above. One section per
            capability, since that is the level at which the reason differs. */}
        {model.ambient.map((group) => (
          <section key={group.capability}>
            <SectionHeading
              title={AMBIENT_COPY[group.capability]?.title ?? group.capability.replace("Telo.", "")}
              hint={AMBIENT_COPY[group.capability]?.hint}
            />
            <ul className="flex flex-col gap-1">
              {group.items.map((node) => (
                <ResourceRow
                  key={node.name}
                  node={node}
                  // A provider is reached through CEL and a type has no
                  // instance, so neither has an interior to enter.
                  focusable={false}
                  onOpen={() => open(node.name)}
                  onDelete={onDeleteResource ? () => remove(node) : undefined}
                  action={<FormBadge>{node.capability.replace("Telo.", "")}</FormBadge>}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <ReferencesBlockedDialog
        name={blocked?.name ?? null}
        move="delete"
        references={blocked?.references ?? []}
        onOpenChange={(open) => !open && setBlocked(null)}
        onSelectResource={onSelectResource}
      />
    </div>
  );
}

/** How each ambient capability reads. Presentation, so it lives here rather
 *  than in the model — which says only WHICH groups there are. A capability with
 *  no entry falls back to its bare name and no hint: terse, never wrong. */
const AMBIENT_COPY: Record<string, { title: string; hint: string }> = {
  "Telo.Provider": {
    title: "Providers",
    hint: "Read as values through CEL (`resources.<name>`), so no reference points at them.",
  },
  "Telo.Type": {
    title: "Types",
    hint: "Named shapes. Nothing runs them; slots reference them as a type, not as an instance.",
  },
};

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {title}
      </h3>
      {hint && <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-4 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
      {children}
    </p>
  );
}

const ROW_CLASS =
  "flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 dark:bg-zinc-950";

function TargetRow({
  entry,
  editable,
  focusable,
  active,
  onOpen,
  onEditInputs,
  inputsOpen,
  onRemove,
}: {
  entry: BootTarget;
  editable: boolean;
  /** Clicking the row enters the resource as well as selecting it. Shown, so
   *  the two kinds of row are told apart before the click rather than after. */
  focusable: boolean;
  active: boolean;
  onOpen: () => void;
  onEditInputs?: () => void;
  inputsOpen?: boolean;
  onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(entry.index), disabled: !editable });
  const showInputs = !!onEditInputs || !!entry.inputKeys?.length;

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
      {/* Arguments above the step and the result below it, so a row reads in the
          direction the values travel: what goes in, the call, what comes out and
          is readable by the targets after it. */}
      {showInputs && (
        // Editable only where the target declared a contract to check against.
        // A step carrying arguments the editor cannot type is still SHOWN — they
        // are in the manifest, and a row that rendered nothing would be hiding
        // them — but it says so and sends the author to Source rather than
        // offering a form with no shape behind it.
        <StripBase
          as={onEditInputs ? "button" : "div"}
          className={`rounded-t-lg border-b-0 ${
            inputsOpen
              ? "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950"
              : onEditInputs
                ? "border-zinc-200 bg-zinc-100/60 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                : "border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900"
          }`}
          onClick={onEditInputs}
          title={
            onEditInputs
              ? "Edit the arguments passed to this step"
              : "The invoked resource declares no input type — edit these in Source"
          }
        >
          <ArrowDownToLine className="size-3 shrink-0 text-zinc-400" />
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">inputs</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-zinc-400">
            {entry.inputKeys?.length ? entry.inputKeys.join(", ") : "none set"}
          </span>
        </StripBase>
      )}
      <div
        className={`${ROW_CLASS} ${showInputs ? "rounded-t-none" : ""} ${
          entry.output ? "rounded-b-none" : ""
        } ${
          active
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
        {entry.index + 1}
      </span>
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm text-zinc-800 dark:text-zinc-100">
            {entry.stepName ?? entry.name ?? "(unreadable entry)"}
          </span>
          {entry.form === "step" && <FormBadge>step</FormBadge>}
          {entry.form === "gated" && <FormBadge>when</FormBadge>}
          {entry.unresolved && (
            <span
              className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400"
              title={`No resource named ${entry.name} is declared in this module`}
            >
              <AlertTriangle className="size-3" />
              unresolved
            </span>
          )}
        </span>
        {/* The step's target and the condition are what the row's own name does
            not carry — an inline step is named for the step, not the resource. */}
        {(entry.when || (entry.stepName && entry.name)) && (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">
            {[entry.stepName && entry.name ? `→ ${entry.name}` : null, entry.when]
              .filter(Boolean)
              .join("  ·  ")}
          </span>
        )}
      </button>
      {focusable && (
        <ChevronRight
          className="size-4 shrink-0 text-zinc-300 dark:text-zinc-600"
          aria-hidden
        />
      )}
      {onRemove && (
        <button
          className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
          onClick={onRemove}
          title="Remove from the boot sequence"
        >
          <X className="size-4" />
        </button>
      )}
      </div>
      {entry.output && (
        // Read-only: what a step produces is declared by the resource it
        // invokes, not by this call site, so there is nothing here to edit.
        <StripBase
          as="div"
          className="rounded-b-lg border-t-0 border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900"
          title="Declared by the invoked resource"
        >
          <ArrowUpFromLine className="size-3 shrink-0 text-zinc-400" />
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">result</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400">
            {typeLabel(entry.output)}
          </span>
          {/* The name is what makes the result reachable: a later target reads it
              as `steps.<name>.result`, and an unnamed step produces one nothing
              can refer to. */}
          {entry.stepName && (
            <span className="shrink-0 font-mono text-[10px] text-zinc-500">
              steps.{entry.stepName}.result
            </span>
          )}
        </StripBase>
      )}
    </li>
  );
}

/** Shared chrome for the two strips that bracket a step row. A `button` when it
 *  opens something, a `div` when it only reports — never a disabled button,
 *  which reads as an affordance that is temporarily off rather than as text. */
function StripBase({
  as,
  className,
  title,
  onClick,
  children,
}: {
  as: "button" | "div";
  className: string;
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const props = {
    className: `flex w-full items-center gap-1.5 border px-2 py-1 text-left ${className}`,
    title,
  };
  return as === "button" ? (
    <button {...props} onClick={onClick}>
      {children}
    </button>
  ) : (
    <div {...props}>{children}</div>
  );
}

/** How a declared signature reads in one line: its type name when it has one,
 *  else the shape's own vocabulary. Never a placeholder — a signature with
 *  neither a name nor a schema is not rendered at all. */
function typeLabel(sig: TypeSignature): string {
  if (sig.name) return sig.name;
  const schema = sig.schema;
  if (!schema) return "";
  const props = schema.properties;
  if (props && typeof props === "object") return Object.keys(props).join(", ") || "object";
  return typeof schema.type === "string" ? schema.type : "object";
}

/**
 * One declared resource, in whichever section it belongs to.
 *
 * The sections differ in what they SAY about a resource, not in how one is
 * drawn, so the trailing slot takes whatever that section adds — the boot
 * button for an unwired resource, the capability for an ambient one, nothing
 * for an export.
 */
function ResourceRow({
  node,
  focusable,
  onOpen,
  onDelete,
  action,
}: {
  node: GraphNode;
  focusable: boolean;
  onOpen: () => void;
  /** Deletes the resource, or reports why it cannot be — see `remove`. */
  onDelete?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <li
      // The key handler is on the ROW and the tab stop is the name button, so
      // Delete works on whatever the user focused without the row becoming a
      // second stop between every two resources. Backspace too: on a Mac
      // keyboard it is the delete key, and only one of the two is present.
      className={`${ROW_CLASS} border-zinc-200 focus-within:border-indigo-300 dark:border-zinc-800 dark:focus-within:border-indigo-800`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (!onDelete || (e.key !== "Delete" && e.key !== "Backspace")) return;
        e.preventDefault();
        onDelete();
      }}
    >
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <span className="block truncate text-sm text-zinc-800 dark:text-zinc-100">{node.name}</span>
        <span className="block truncate font-mono text-[10px] text-zinc-400">{node.kind}</span>
      </button>
      {focusable && (
        <ChevronRight className="size-4 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden />
      )}
      {action}
      {onDelete && (
        <button
          className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
          onClick={onDelete}
          title={`Delete ${node.name}`}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function FormBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}
