import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
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
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  GripVertical,
  Plus,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { isModuleRootKind } from "../../../../application-adapter";
import { isRecord } from "../../../../lib/utils";
import {
  buildEditableSchema,
  getStepSchema,
  getTopologyRole,
  getVariants,
  type VariantMeta,
} from "../../../../schema-utils";
import { summarizeResource } from "../../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../../diagnostics/DiagnosticsContext";
import { Button } from "../../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import {
  collectRefTargets,
  resolveRefCandidates,
  toRefValue,
} from "../../../resource-schema-form/ref-candidates";
import type { ResolvedResourceOption } from "../../../resource-schema-form/types";
import type { TypeSignature } from "../application-canvas-model";
import {
  buildStepList,
  type StepAddition,
  type StepBranch,
  type StepEntry,
} from "../step-list-model";
import {
  appendAt,
  freshStepName,
  mergeAt,
  newStep,
  pointerSegment,
  readBody,
  writeAt,
} from "../step-body-edit";
import type { TopologyViewProps } from "../topology-view";

/** A stable empty body, so a kind with none written yet does not hand the step
 *  list a fresh array reference on every render. */
const NO_STEPS: readonly unknown[] = [];

/**
 * The body a kind runs, as the ordered thing it is.
 *
 * It replaced a bespoke sequence canvas, and the reasons are the ones
 * {@link RootLevel} already gives for the boot list — the two are the same
 * shape, since a step and a boot target are both the shared `InvokeStep`
 * fragment. What that canvas did differently was all cost: it committed the
 * WHOLE array through a field write on every edit, re-serializing each entry
 * from plain data and silently dropping the `!ref` tags, quote styles and
 * comments the author attached to them; it mirrored the array into local state
 * resynced through a `JSON.stringify` effect, so the array was true in two
 * places; and it read `fields.steps` by name, while the model beside it found
 * the same array through the annotation.
 *
 * So every edit here is a named AST operation against ONE node — `onMoveField`
 * within a branch, `onRelocateField` across two, `onRemoveField` for a deletion
 * — and only APPENDING goes through an ordinary field write, which is safe for
 * the reason it is safe in the boot list: a new last index rewrites nothing.
 *
 * Nothing in it names a kind. The steps array is whichever field carries
 * `x-telo-topology-role: steps`, and the control-flow vocabulary is read from
 * that field's own variants — so a composer that adopts the step-body fragment
 * gets this view without an editor change.
 */
export function StepsView({
  resource,
  schema,
  viewData,
  refResolver,
  resolvedResources,
  model,
  selection,
  canFocus,
  onFocusResource,
  onSelect,
  onSelectResource,
  onUpdateResource,
  onMoveField,
  onRelocateField,
  onRemoveField,
  onBackgroundClick,
  hideHeader,
}: TopologyViewProps) {
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const summary = summarizeResource(diagState, filePaths, resource.name);

  const field = useMemo(() => stepsFieldName(schema), [schema]);
  const stepSchema = useMemo(() => getStepSchema(schema), [schema]);
  const variants = useMemo(
    () => (stepSchema ? getVariants(stepSchema, schema) : []),
    [stepSchema, schema],
  );

  const steps: readonly unknown[] =
    field && Array.isArray(resource.fields[field])
      ? (resource.fields[field] as unknown[])
      : NO_STEPS;

  const entries = useMemo(() => {
    if (!field || !stepSchema) return [];
    // Signatures come from the canvas model, which already resolved each
    // resource's `inputType` / `outputType` with the right precedence — the
    // instance's own field first, then the kind. Reading them back is what keeps
    // this list and the canvas from disagreeing about what a step's target takes.
    const byName = new Map((model?.nodes ?? []).map((n) => [n.name, n] as const));
    return buildStepList({
      steps,
      stepSchema,
      variants,
      root: schema,
      pointer: `/${field}`,
      declared: new Set(
        viewData.manifest.resources.filter((r) => !isModuleRootKind(r.kind)).map((r) => r.name),
      ),
      signatureOf: (name) => {
        const node = byName.get(name);
        return node ? { input: node.inputType, output: node.outputType } : undefined;
      },
    });
  }, [field, stepSchema, variants, schema, steps, model, viewData]);

  const target = { kind: resource.kind, name: resource.name };
  const editable = !!onMoveField && !!onRemoveField;

  /** Every row by pointer, so a drop can be resolved from the two ids the
   *  sensor reports without the tree being walked again. */
  const byPointer = useMemo(() => {
    const map = new Map<string, StepEntry>();
    const walk = (list: StepEntry[]) => {
      for (const entry of list) {
        map.set(entry.pointer, entry);
        for (const branch of entry.branches) walk(branch.entries);
      }
    };
    walk(entries);
    return map;
  }, [entries]);

  /** Every step array by pointer, with its length — what a drop onto an empty
   *  branch needs, since there is no row there to land on. */
  const containers = useMemo(() => {
    const map = new Map<string, number>();
    map.set(`/${field}`, entries.length);
    const walk = (list: StepEntry[]) => {
      for (const entry of list) {
        for (const branch of entry.branches) {
          map.set(branch.pointer, branch.entries.length);
          walk(branch.entries);
        }
      }
    };
    walk(entries);
    return map;
  }, [entries, field]);

  /** What a dispatch may name, PER VARIANT.
   *
   *  Read from that variant's own invoke slot through the analyzer's accessor,
   *  so the list offers exactly the resources the checker would accept at the
   *  slot it will be written into — the same answer the detail panel's
   *  reference picker gives, since both go through one resolver. Resolving one
   *  variant's slot and offering it for every dispatch variant would put the
   *  completion surface ahead of its checker the moment a kind declares two
   *  dispatch alternatives with different constraints. */
  const invokeCandidates = useMemo(() => {
    const byVariant = new Map<VariantMeta, ResolvedResourceOption[]>();
    for (const variant of variants) {
      if (!variant.invokeField) continue;
      const props = isRecord(variant.schema.properties) ? variant.schema.properties : {};
      const slot = props[variant.invokeField];
      if (!isRecord(slot)) continue;
      byVariant.set(
        variant,
        resolveRefCandidates(collectRefTargets(slot), resolvedResources, refResolver),
      );
    }
    return byVariant;
  }, [variants, resolvedResources, refResolver]);

  /** Every step name in the body, at any depth. */
  const takenNames = useMemo(() => {
    const names = new Set<string>();
    for (const entry of byPointer.values()) if (entry.stepName) names.add(entry.stepName);
    return names;
  }, [byPointer]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = byPointer.get(String(active.id));
    if (!from) return;

    // A drop lands either on another row — take that row's container and index
    // — or on a branch's own droppable, which is how an EMPTY branch is
    // reachable at all. Nothing else is a drop site.
    const overEntry = byPointer.get(String(over.id));
    const toContainer = overEntry ? overEntry.containerPointer : String(over.id);
    const toIndex = overEntry ? overEntry.index : (containers.get(toContainer) ?? 0);
    if (!containers.has(toContainer)) return;

    // A step dropped inside its own subtree would be reparented under itself,
    // which is not a move but a deletion of everything below it.
    if (toContainer.startsWith(`${from.pointer}/`)) return;

    if (toContainer === from.containerPointer) onMoveField?.(target, from.pointer, toIndex);
    else onRelocateField?.(target, from.pointer, toContainer, toIndex);
  }

  /** Appends a step of `variant` to the body's top level.
   *
   *  The one edit that goes through an ordinary field write rather than an AST
   *  operation, for the reason the boot list appends the same way: a new LAST
   *  index rewrites nothing, so no existing entry is re-serialized. */
  function addStep(variant: VariantMeta, target?: ResolvedResourceOption) {
    if (!field) return;
    appendStep(`/${field}`, variant, target);
  }

  /** Appends a step to ANY body, named against the whole tree so two branches
   *  never mint the same `steps.<name>.result`, and opens its form.
   *
   *  Opening it is not a convenience: what a new step still needs is exactly
   *  what could not be written for it — a dispatch's target above all, since a
   *  reference has no empty value — so the form is where the step is actually
   *  created, and landing anywhere else leaves the author looking for it. */
  function appendStep(
    containerPointer: string,
    variant: VariantMeta,
    invokeTarget?: ResolvedResourceOption,
  ) {
    if (!field) return;
    const current = readBody(resource.fields, containerPointer);
    const step = newStep(variant, freshStepName(takenNames));
    // A dispatch is written WITH what it dispatches to. It is the one variant
    // whose identity is a reference, so a step created without one says nothing
    // — the schema matches no alternative and the row can only ask the question
    // again. Asking it once, here, is the whole difference.
    if (variant.invokeField && invokeTarget) step[variant.invokeField] = toRefValue(invokeTarget);
    onUpdateResource(
      resource.kind,
      resource.name,
      appendAt(resource.fields, containerPointer, step),
    );
    if (!stepSchema) return;
    onSelect({
      resource: target,
      pointer: `${containerPointer}/${current.length}`,
      schema: buildEditableSchema(stepSchema, variant, schema),
    });
  }

  /** Says what an unfinished step does — a step already in the manifest that
   *  declares nothing, whether an author left it half-written or an older
   *  editor created it that way. Writes the fields the chosen variant needs, a
   *  dispatch's target included, and opens that variant's form. */
  function chooseOperation(
    entry: StepEntry,
    variant: VariantMeta,
    invokeTarget?: ResolvedResourceOption,
  ) {
    if (!field || !stepSchema) return;
    const seeded = newStep(variant, entry.stepName ?? freshStepName(takenNames));
    if (variant.invokeField && invokeTarget) {
      seeded[variant.invokeField] = toRefValue(invokeTarget);
    }
    onUpdateResource(resource.kind, resource.name, mergeAt(resource.fields, entry.pointer, seeded));
    onSelect({
      resource: target,
      pointer: entry.pointer,
      schema: buildEditableSchema(stepSchema, variant, schema),
    });
  }

  /** Creates a body the variant allows and the step has not written: an `else`,
   *  a named case, one more else-if. Writing it is what makes it renderable —
   *  the list shows bodies that exist, which is right for reading a manifest
   *  and is why this had to be its own affordance. */
  function addBody(entry: StepEntry, addition: StepAddition, caseKey?: string) {
    if (!field) return;
    // An empty key would collapse the pointer onto the case MAP, and writing
    // there replaces every case with an empty list. The menu asks for one; this
    // is the guard that makes losing them unrepresentable rather than avoided.
    if (addition.form === "case-map" && !caseKey?.trim()) return;
    const at = `${entry.pointer}/${pointerSegment(addition.field)}`;
    const next =
      addition.form === "branch"
        ? writeAt(resource.fields, at, addition.seed)
        : addition.form === "case-map"
          ? writeAt(resource.fields, `${at}/${pointerSegment(caseKey!.trim())}`, addition.seed)
          : appendAt(resource.fields, at, addition.seed);
    onUpdateResource(resource.kind, resource.name, next);
  }

  if (!field || !stepSchema) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-900">
        <p className="max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">
          This kind declares no step body — no field is annotated{" "}
          <code className="font-mono text-xs">x-telo-topology-role: steps</code>.
        </p>
      </div>
    );
  }

  const rowProps = {
    target,
    editable,
    selection,
    // A step names its target, and selecting a resource needs its kind too —
    // resolved here rather than carried on the row, since a step naming nothing
    // declared has no kind to carry.
    kindOf: (name: string) =>
      viewData.manifest.resources.find((r) => r.name === name)?.kind,
    canFocus,
    onFocusResource,
    onSelect,
    onSelectResource,
    onRemoveField,
    variants,
    onAppendStep: appendStep,
    onAddBody: addBody,
    onChooseOperation: chooseOperation,
    invokeCandidates,
  };

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
            {variants.length > 0 && (
              <AddStepMenu
                variants={variants}
                invokeCandidates={invokeCandidates}
                onAdd={addStep}
              />
            )}
          </div>
        )}

        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-4 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            No steps yet. Runs top to bottom once there are.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <StepList entries={entries} {...rowProps} />
          </DndContext>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  target: { kind: string; name: string };
  editable: boolean;
  selection: TopologyViewProps["selection"];
  /** The declared kind of a resource this module holds, or undefined when it
   *  holds none by that name. */
  kindOf: (name: string) => string | undefined;
  canFocus: TopologyViewProps["canFocus"];
  onFocusResource: TopologyViewProps["onFocusResource"];
  onSelect: TopologyViewProps["onSelect"];
  onSelectResource: TopologyViewProps["onSelectResource"];
  onRemoveField: TopologyViewProps["onRemoveField"];
  /** The step vocabulary this body admits — every add affordance offers it. */
  variants: VariantMeta[];
  /** Appends a step to one body, named by its array pointer. */
  onAppendStep: (
    containerPointer: string,
    variant: VariantMeta,
    invokeTarget?: ResolvedResourceOption,
  ) => void;
  /** Creates a body the step does not have yet. */
  onAddBody: (entry: StepEntry, addition: StepAddition, caseKey?: string) => void;
  /** Says what an unfinished step does; a dispatch names its target here. */
  onChooseOperation: (
    entry: StepEntry,
    variant: VariantMeta,
    invokeTarget?: ResolvedResourceOption,
  ) => void;
  /** What each dispatch variant may name, resolved from that variant's own
   *  invoke slot. */
  invokeCandidates: ReadonlyMap<VariantMeta, ResolvedResourceOption[]>;
}

/**
 * One step array: its own sortable scope, so a reorder inside it is confined to
 * it.
 *
 * The array itself is deliberately NOT a droppable. A step body nests, so an
 * outer list's rectangle contains every inner one, and a container droppable at
 * each level would leave a drop ambiguous between the row under the pointer and
 * whichever ancestor also encloses it — resolved by rectangle geometry rather
 * than by what the user aimed at. Rows are the drop sites; an EMPTY branch is
 * the one case with no row, and {@link EmptyBranch} registers itself for exactly
 * that.
 */
function StepList({
  entries,
  ...rowProps
}: RowProps & { entries: StepEntry[] }) {
  return (
    <SortableContext
      items={entries.map((entry) => entry.pointer)}
      strategy={verticalListSortingStrategy}
    >
      <ol className="flex flex-col gap-1">
        {entries.map((entry) => (
          <StepRow key={entry.pointer} entry={entry} {...rowProps} />
        ))}
      </ol>
    </SortableContext>
  );
}

/** A step, then the bodies it owns. The nesting is rendered as indentation
 *  under a labelled rule rather than as a nested card: a body is a continuation
 *  of the step above it, and boxing each one turns three levels of ordinary
 *  control flow into three frames of chrome. */
function StepRow({ entry, ...rowProps }: RowProps & { entry: StepEntry }) {
  const showBodies = entry.branches.length > 0 || entry.additions.length > 0;
  return (
    <li>
      <StepCard entry={entry} {...rowProps} />
      {showBodies && (
        <div className="ml-3 mt-1 flex flex-col gap-2 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {entry.branches.map((branch) => (
            <BranchBody key={branch.pointer} branch={branch} {...rowProps} />
          ))}
          {rowProps.editable && entry.additions.length > 0 && (
            <AddBodyMenu entry={entry} onAddBody={rowProps.onAddBody} />
          )}
        </div>
      )}
    </li>
  );
}

/** The bodies a control-flow step could still declare.
 *
 *  It sits under the step beside the bodies it already has, because that is
 *  what it produces — not in the step's form, which deliberately holds the
 *  step's own fields and leaves every body to this list.
 *
 *  A case is the one addition that needs a value from the author: case keys are
 *  matched against a discriminator, so they cannot be generated. */
function AddBodyMenu({
  entry,
  onAddBody,
}: {
  entry: StepEntry;
  onAddBody: RowProps["onAddBody"];
}) {
  const [caseFor, setCaseFor] = useState<StepAddition | null>(null);
  const [draft, setDraft] = useState("");

  if (caseFor) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
          {caseFor.field}
        </span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setCaseFor(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setCaseFor(null);
            if (e.key !== "Enter") return;
            const key = draft.trim();
            if (!key) return;
            onAddBody(entry, caseFor, key);
            setCaseFor(null);
            setDraft("");
          }}
          placeholder="case key"
          className="w-32 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="self-start text-zinc-400">
          <Plus className="size-3" />
          branch
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {entry.additions.map((addition) => (
          <DropdownMenuItem
            key={`${addition.form}:${addition.field}`}
            onClick={() => {
              if (addition.form === "case-map") {
                setDraft("");
                setCaseFor(addition);
                return;
              }
              onAddBody(entry, addition);
            }}
          >
            {addition.form === "case-map"
              ? `${addition.field}: add a case…`
              : addition.form === "branch-list"
                ? `${addition.field}: add a condition`
                : addition.field}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchBody({ branch, ...rowProps }: RowProps & { branch: StepBranch }) {
  const { editable, variants, onAppendStep } = rowProps;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
          {branch.label}
        </span>
        {/* A body could previously be filled only by dragging a step in from
            the top level, so a branch created here had no way to gain its first
            step. The menu writes into THIS array. */}
        {editable && variants.length > 0 && (
          <AddStepMenu
            variants={variants}
            invokeCandidates={rowProps.invokeCandidates}
            onAdd={(variant, invokeTarget) =>
              onAppendStep(branch.pointer, variant, invokeTarget)
            }
            compact
          />
        )}
      </div>
      {branch.entries.length === 0 ? (
        <EmptyBranch pointer={branch.pointer} />
      ) : (
        <StepList entries={branch.entries} {...rowProps} />
      )}
    </div>
  );
}

/** A branch with nothing in it is still a drop target — otherwise a step could
 *  be dragged out of a branch and never back into one. */
function EmptyBranch({ pointer }: { pointer: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: pointer });
  return (
    <div
      ref={setNodeRef}
      className={`rounded border border-dashed px-2 py-1.5 text-[10px] ${
        isOver
          ? "border-indigo-400 text-indigo-500 dark:border-indigo-600"
          : "border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
      }`}
    >
      empty — drop a step here
    </div>
  );
}

const ROW_CLASS = "flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 dark:bg-zinc-950";

/**
 * One step.
 *
 * Arguments above and result below, so the row reads in the direction the
 * values travel — the shape the boot list already uses, and the reason a reader
 * moving between the two levels does not have to learn a second one.
 */
function StepCard({
  entry,
  target,
  editable,
  selection,
  kindOf,
  canFocus,
  onFocusResource,
  onSelect,
  onSelectResource,
  onRemoveField,
  variants,
  onChooseOperation,
  invokeCandidates,
}: RowProps & { entry: StepEntry }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.pointer, disabled: !editable });

  const inputsOpen = !!entry.inputs && selection?.pointer === entry.inputs.pointer;
  const selected = selection?.pointer === entry.pointer;
  const showInputs = !!entry.inputs || !!entry.inputKeys?.length;

  /** Opens the step's own fields in the detail panel. */
  function openStep() {
    onSelect({ resource: target, pointer: entry.pointer, schema: entry.schema });
  }

  /** Opens the resource this step invokes — into the panel always, and into the
   *  canvas when it has an interior worth entering. The same rule every list in
   *  this editor follows. */
  function openTarget() {
    if (!entry.target) return;
    const kind = kindOf(entry.target);
    if (kind) onSelectResource(kind, entry.target);
    if (canFocus(entry.target)) onFocusResource(entry.target);
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {showInputs && (
        // Editable only where the invoked resource declared a contract to check
        // against. A step carrying arguments the editor cannot type is still
        // SHOWN — they are in the manifest — but it says so rather than offering
        // a form with no shape behind it.
        <StripBase
          as={entry.inputs ? "button" : "div"}
          className={`rounded-t-lg border-b-0 ${
            inputsOpen
              ? "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950"
              : entry.inputs
                ? "border-zinc-200 bg-zinc-100/60 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                : "border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900"
          }`}
          title={
            entry.inputs
              ? "Edit the arguments passed to this step"
              : "The invoked resource declares no input type — edit these in Source"
          }
          onClick={
            entry.inputs
              ? () =>
                  onSelect({
                    resource: target,
                    pointer: entry.inputs!.pointer,
                    schema: entry.inputs!.schema,
                    // A step's arguments are evaluated at dispatch, so every
                    // field offers the CEL-expression toggle.
                    celEval: "runtime",
                  })
              : undefined
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
          selected
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
            title="Drag to reorder, or into another branch"
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <span className="w-4 shrink-0 text-center font-mono text-[10px] text-zinc-400">
          {entry.symbol ?? entry.index + 1}
        </span>
        <button className="min-w-0 flex-1 text-left" onClick={openStep}>
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm text-zinc-800 dark:text-zinc-100">
              {entry.stepName ?? entry.target ?? entry.keyword ?? "unfinished step"}
            </span>
            {entry.keyword && <Badge>{entry.keyword}</Badge>}
            {!entry.classified && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                nothing to run yet
              </span>
            )}
            {entry.unresolved && (
              <span
                className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                title={`No resource named ${entry.target} is declared in this module`}
              >
                <AlertTriangle className="size-3" />
                unresolved
              </span>
            )}
          </span>
          {/* What the row's own name does not carry: a named step is named for
              the step, not the resource it calls, and a guard decides whether
              any of it runs. */}
          {(entry.when || (entry.stepName && entry.target)) && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">
              {[entry.stepName && entry.target ? `→ ${entry.target}` : null, entry.when]
                .filter(Boolean)
                .join("  ·  ")}
            </span>
          )}
        </button>
        {/* A step that declares nothing about what it does has ONE thing left to
            decide, so it is offered as a choice here rather than as a form full
            of operations. Writing the choice is what makes the step readable —
            and for a dispatch there is nothing valid to write, so it opens the
            target picker instead. */}
        {!entry.classified && editable && variants.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline" className="shrink-0">
                Choose
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <StepVariantItems
                variants={variants}
                invokeCandidates={invokeCandidates}
                onPick={(variant, invokeTarget) =>
                  onChooseOperation(entry, variant, invokeTarget)
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {entry.target && canFocus(entry.target) && (
          <button
            className="shrink-0 rounded text-zinc-300 hover:text-zinc-500 dark:text-zinc-600"
            onClick={openTarget}
            title={`Open ${entry.target}`}
          >
            <ChevronRight className="size-4" />
          </button>
        )}
        {onRemoveField && (
          <button
            className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
            onClick={() => onRemoveField(target, entry.pointer)}
            title="Remove this step"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {entry.output && (
        // Read-only: what a step produces is declared by the resource it
        // invokes, not by this call site.
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
          {/* The name is what makes the result reachable: a later step reads it
              as `steps.<name>.result`, and an unnamed step produces one nothing
              can refer to. */}
          {entry.stepName && (
            <span className="shrink-0 font-mono text-[10px] text-zinc-500">
              steps.{entry.stepName}.result
            </span>
          )}
        </StripBase>
      )}
    </div>
  );
}

/**
 * The step vocabulary, as menu items.
 *
 * A dispatch opens into WHAT IT DISPATCHES TO instead of being a leaf: it is the
 * one variant whose identity is a reference, so choosing it without a target
 * writes a step that says nothing — which is how "add an invoke step" used to
 * produce a step the schema rejects and a row that could only ask again. Every
 * other variant is written whole and is a leaf.
 */
function StepVariantItems({
  variants,
  invokeCandidates,
  onPick,
}: {
  variants: VariantMeta[];
  invokeCandidates: ReadonlyMap<VariantMeta, ResolvedResourceOption[]>;
  onPick: (variant: VariantMeta, invokeTarget?: ResolvedResourceOption) => void;
}) {
  return (
    <>
      {variants.map((variant, i) => {
        const label = variant.title || `Variant ${i + 1}`;
        if (!variant.invokeField) {
          return (
            <DropdownMenuItem key={label} onClick={() => onPick(variant)}>
              {label}
            </DropdownMenuItem>
          );
        }
        const candidates = invokeCandidates.get(variant) ?? [];
        if (candidates.length === 0) {
          return (
            // Disabled rather than hidden: the vocabulary is what it is, and a
            // missing entry reads as "this composer cannot dispatch".
            <DropdownMenuItem key={label} disabled>
              {label} — nothing to invoke yet
            </DropdownMenuItem>
          );
        }
        return (
          <DropdownMenuSub key={label}>
            <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
              {candidates.map((candidate) => (
                <DropdownMenuItem
                  key={`${candidate.kind}/${candidate.name}`}
                  onClick={() => onPick(variant, candidate)}
                  className="justify-between gap-3"
                >
                  <span>{candidate.name}</span>
                  <span className="font-mono text-[10px] text-zinc-400">{candidate.kind}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </>
  );
}

function AddStepMenu({
  variants,
  invokeCandidates,
  onAdd,
  compact,
}: {
  variants: VariantMeta[];
  invokeCandidates: ReadonlyMap<VariantMeta, ResolvedResourceOption[]>;
  onAdd: (variant: VariantMeta, invokeTarget?: ResolvedResourceOption) => void;
  /** Inside a body, where the control sits on a label rather than in a header. */
  compact?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant={compact ? "ghost" : "outline"}>
          <Plus className="size-3" />
          {compact ? "step" : "Add step"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <StepVariantItems
          variants={variants}
          invokeCandidates={invokeCandidates}
          onPick={onAdd}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shared chrome for the two strips bracketing a step. A `button` when it opens
 *  something, a `div` when it only reports — never a disabled button, which
 *  reads as an affordance that is temporarily off rather than as text. */
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

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}

/** How a declared signature reads in one line: its type name when it has one,
 *  else the shape's own vocabulary. */
function typeLabel(sig: TypeSignature): string {
  if (sig.name) return sig.name;
  const schema = sig.schema;
  if (!schema) return "";
  const props = schema.properties;
  if (props && typeof props === "object") return Object.keys(props).join(", ") || "object";
  return typeof schema.type === "string" ? schema.type : "object";
}

/** The field carrying this kind's step body — the one annotated
 *  `x-telo-topology-role: steps`. */
function stepsFieldName(kindSchema: Record<string, unknown>): string | null {
  const props = kindSchema.properties;
  if (!isRecord(props)) return null;
  for (const [name, prop] of Object.entries(props)) {
    if (getTopologyRole(prop) === "steps") return name;
  }
  return null;
}


