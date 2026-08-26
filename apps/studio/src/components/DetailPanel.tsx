import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleDocument, ModuleViewData, Selection } from "../model";
import { summarizeResource } from "../diagnostics-aggregate";
import { isRecord } from "../lib/utils";
import { fieldPointer, readPointer, writePointer } from "../lib/json-pointer";
import { suggestedResourceName } from "../resource-naming";
import {
  celEvalModeAtPointer,
  getCelEvalMode,
  type CelEvalMode,
} from "./resource-schema-form/cel-utils";
import { DiagnosticBadge } from "./diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "./diagnostics/DiagnosticsContext";
import { APPLICATION_KIND_ID, isModuleRootKind, moduleRootFormSchema } from "../application-adapter";
import { ModuleRootTargetsSummary } from "./ModuleRootDetailBody";
import type { RefResolver } from "./resource-schema-form/ref-candidates";
import {
  startsWith,
  toSegments,
  type FieldDiagnostic,
} from "./resource-schema-form/field-diagnostics";
import type { ResolvedResourceOption, TypeKindOption } from "./ResourceSchemaForm";
import { ResourceSchemaForm } from "./ResourceSchemaForm";
import {
  findPendingRefCreate,
  inlineResourceKind,
  resolvePendingRefCreate,
} from "./resource-schema-form/ref-candidates";
import { PickCanvas } from "./views/pick-canvas";
import { DetailYamlPane } from "./DetailYamlPane";
import { ExtractInlineDialog } from "./ExtractInlineDialog";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { FileOutput } from "lucide-react";

type DetailMode = "form" | "yaml";

interface DetailPanelProps {
  selectedResource: { kind: string; name: string } | null;
  selection: Selection | null;
  /** True while the module cannot be edited (remote, or the agent holds it).
   *  The YAML pane is a write surface like the form, so it honours this. */
  readOnly: boolean;
  /** Commits a whole-file edit — what the YAML pane's splice produces. */
  onSourceEdit: (filePath: string, moduleDoc: ModuleDocument) => void;
  /** Moves the resource declared inline at `pointer` into its own document
   *  named `name`, leaving a reference to it behind. */
  onExtractInline: (
    host: { kind: string; name: string },
    pointer: string,
    name: string,
  ) => void;
  /** The inverse: folds the resource the slot at `pointer` references back into
   *  that slot and removes its document. Refused — with its reason — when
   *  anything else still names it, which only the host can answer. */
  onInlineReference: (host: { kind: string; name: string }, pointer: string) => void;
  /**
   * The resource the canvas beside this panel is already drawing, when one is.
   *
   * The panel's job is the SELECTION — a property from the rail, a step from
   * the canvas. With nothing selected it peeks at the resource instead, which
   * is worth having while the peek is at something else (a leaf clicked from a
   * list, a mount clicked under its server) and is pure duplication once the
   * peek and the canvas are the same resource: drilling in selects what it
   * focuses, so the panel drew the boot list a second time beside the boot
   * list, and the whole field form beside the form view.
   *
   * Told rather than derived, because only the host knows what it rendered —
   * whether a canvas resolved at all, and for which node.
   */
  canvasResource: { kind: string; name: string } | null;
  viewData: ModuleViewData | null;
  /** Narrows `x-telo-ref` candidates by kind satisfaction (abstract refs). */
  registry: RefResolver | null;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelectResource: (kind: string, name: string) => void;
  onSelect: (selection: Selection) => void;
  /** Creates a resource of `createKind` and, in the SAME workspace mutation,
   *  writes `buildFields(newName)` back to `target`. One operation because two
   *  would race: the create re-renders this panel, which re-derives its
   *  selection context and resets the pending edit, and the second persist would
   *  read a workspace snapshot taken before the first. */
  onCreateAndLink: (
    target: { kind: string; name: string },
    createKind: string,
    buildFields: (newName: string) => Record<string, unknown>,
  ) => void;
}

function sanitizeFields(values: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    next[key] = value;
  }
  return next;
}

/**
 * The object a pointer-scoped form edits, or null when there is nothing to edit.
 *
 * An ABSENT target yields an empty object: a step's `inputs:` does not exist
 * until something is put in it, so refusing one is refusing to author it at all.
 * A target that EXISTS and is not an object yields null — a form rendered over
 * it would misrepresent it, and committing would write over something it never
 * read.
 *
 * One function because it is one rule, and it is asked twice — once to decide
 * what the form renders, once to decide what a commit writes. Stated separately
 * they drifted immediately: the commit half was taught to create an absent
 * target while the render half still bailed, so the form it was meant to open
 * silently fell back to the whole resource's.
 */
export function pointerTarget(
  fields: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | null {
  const target = readPointer(fields, pointer);
  if (target === undefined) return {};
  return isRecord(target) ? target : null;
}

export function DetailPanel({
  selectedResource,
  selection,
  canvasResource,
  viewData,
  registry,
  readOnly,
  onSourceEdit,
  onExtractInline,
  onInlineReference,
  onUpdateResource,
  onSelectResource,
  onSelect,
  onCreateAndLink,
}: DetailPanelProps) {
  // Sticky across selections and resources: the choice is about how the user
  // wants to work, not about what is selected, so re-deriving it per selection
  // would put them back in the form on every click.
  const [mode, setMode] = useState<DetailMode>("form");
  /** The inline resource whose extraction is being named — its kind, and the
   *  pointer it is written at — or null. Addressed by pointer rather than by
   *  the open selection, because the move is now offered from the SLOT as well
   *  as from inside the declaration, and those are different pointers. */
  const [extracting, setExtracting] = useState<{ kind: string; pointer: string } | null>(null);
  const resource = useMemo(() => {
    if (!selectedResource || !viewData) return null;
    return (
      viewData.manifest.resources.find(
        (r) => r.kind === selectedResource.kind && r.name === selectedResource.name,
      ) ?? null
    );
  }, [selectedResource, viewData]);

  const resolvedResources: ResolvedResourceOption[] = useMemo(
    () =>
      (viewData?.manifest.resources ?? []).map((r) => ({
        kind: r.kind,
        name: r.name,
        capability: viewData?.kinds.get(r.kind)?.capability || undefined,
      })),
    [viewData],
  );

  // Imported `Telo.Type` kinds — the type systems available to instantiate
  // inline (JSON Schema, Cue, …). Sourced from the module's available kinds, so
  // only what the manifest actually imports is offered.
  const typeKinds: TypeKindOption[] = useMemo(
    () =>
      [...(viewData?.kinds.values() ?? [])]
        .filter((k) => k.capability === "Telo.Type")
        .map((k) => ({ kind: k.fullKind, schema: k.schema })),
    [viewData],
  );

  /** A selection the user made IN this resource — a rail property, a step, a
   *  binding entry. Distinct from a bare `selectedResource`, which is only
   *  "this is the resource in hand". */
  const hasSelection =
    !!resource &&
    !!selection &&
    selection.resource.kind === resource.kind &&
    selection.resource.name === resource.name;

  /** The canvas beside this panel is already drawing this very resource. */
  const echoesCanvas =
    !!resource &&
    !!canvasResource &&
    canvasResource.kind === resource.kind &&
    canvasResource.name === resource.name;

  const selectionContext = useMemo(() => {
    if (!resource) return null;

    // The module root (Telo.Application / Telo.Library) has no pointer-scoped
    // selection of its own. Synthesize a context rooted at the whole fields
    // object so it flows through the same schema form + debounced-commit
    // pipeline as any other resource. The form schema exposes only
    // variables/secrets; the remaining fields (metadata/targets/ports) pass
    // through untouched. A pointer-bearing selection (e.g. editing a target
    // step's `inputs`) takes the selection path below instead.
    //
    // Not while the canvas is the root's own: the module bar lists exactly
    // these bindings and opens each as an entry, so the synthesized form is a
    // second way into the same fields — and the targets summary above it a
    // second rendering of the boot list already filling the canvas.
    if (isModuleRootKind(resource.kind) && !selection?.pointer && !echoesCanvas) {
      return {
        resource: { kind: resource.kind, name: resource.name },
        pointer: "",
        schema: moduleRootFormSchema(resource.kind === APPLICATION_KIND_ID),
        values: resource.fields,
        inlineKind: undefined as string | undefined,
      };
    }

    if (!selection) return null;
    if (
      selection.resource.kind !== resource.kind ||
      selection.resource.name !== resource.name
    ) {
      return null;
    }

    const values = pointerTarget(resource.fields, selection.pointer);
    if (!values) return null;

    // A pointer landing on a resource declared INLINE is a pointer at a
    // resource, not at a slot: it is authored against its own kind's schema,
    // not against the schema of the field holding it. Resolved here rather
    // than by whoever built the selection so every route in — a slot's chip
    // today, the canvas once it draws inline children — agrees, and so the
    // schema is the kind's current one rather than one captured at click time.
    const inlineKind = inlineResourceKind(values);
    const inlineSchema = inlineKind ? viewData?.kinds.get(inlineKind)?.schema : undefined;
    if (inlineSchema) {
      return { ...selection, schema: inlineSchema, values, inlineKind };
    }

    return { ...selection, values, inlineKind: undefined as string | undefined };
  }, [resource, selection, echoesCanvas, viewData]);

  const rootCelEval: CelEvalMode | null = useMemo(() => {
    if (!resource || !viewData) return null;
    // A selection may pin its own CEL mode (an edge's `inputs` form runs at
    // runtime).
    if (selection?.celEval) return selection.celEval;

    // A resource declared inline is authored against its OWN kind, and the
    // analyzer's eval walk stops at that boundary too — the expressions inside
    // it belong to the nested kind, so the host's regions do not reach them.
    const inlineKind = selectionContext?.inlineKind;
    if (inlineKind) {
      return getCelEvalMode(viewData.kinds.get(inlineKind)?.schema ?? {}, null);
    }

    // What the form would have inherited had it started at the resource root
    // rather than at the selection — an ancestor's region does not appear in a
    // pointer-scoped subtree.
    const atPointer = celEvalModeAtPointer(
      viewData.kinds.get(resource.kind)?.schema,
      selectionContext?.pointer ?? "",
    );
    if (atPointer) return atPointer;

    // Otherwise Providers evaluate at compile time, others not at all.
    const capability = viewData.kinds.get(resource.kind)?.capability;
    return capability === "Telo.Provider" ? "compile" : null;
  }, [resource, viewData, selection, selectionContext]);

  const [pointerFields, setPointerFields] = useState<Record<string, unknown>>({});
  const [hasFormErrors, setHasFormErrors] = useState(false);
  // Tracks whether `pointerFields` has been touched by user input since the
  // last reset / commit. Without this flag the debounced commit effect would
  // fire on every selectionContext-driven re-seed and write the same values
  // back to the manifest as a no-op.
  const dirtyRef = useRef(false);

  // Refs mirroring state/props that the flush effect's cleanup needs at the
  // moment it fires. The cleanup captures the OLD selectionContext + resource
  // via closure (so it commits to the right pointer when the user navigates),
  // but must read the LATEST pointerFields, hasFormErrors, and onUpdateResource
  // — those have all advanced past the closure by the time cleanup runs.
  // Assigned during render rather than via useEffect: these refs never feed
  // back into render output, only into imperative cleanup code, so paying for
  // three scheduled effects per render would be pure overhead.
  // `handlePointerChange` is memoized on the host callback alone, so the current
  // resource / context reach it through refs rather than by re-creating it on
  // every render (which would remount the form's controls mid-edit).
  const resourceRef = useRef(resource);
  const selectionContextRef = useRef(selectionContext);
  resourceRef.current = resource;
  selectionContextRef.current = selectionContext;
  const pointerFieldsRef = useRef(pointerFields);
  const hasFormErrorsRef = useRef(hasFormErrors);
  const onUpdateResourceRef = useRef(onUpdateResource);
  pointerFieldsRef.current = pointerFields;
  hasFormErrorsRef.current = hasFormErrors;
  onUpdateResourceRef.current = onUpdateResource;

  useEffect(() => {
    if (selectionContext) setPointerFields(selectionContext.values);
    setHasFormErrors(false);
    dirtyRef.current = false;
  }, [selectionContext]);

  const handlePointerChange = useCallback(
    (next: Record<string, unknown>) => {
      // A ref slot pointed at a kind with no instance yet reports a marker
      // instead of a value (see `pendingRefCreate`). Finding it here — in the
      // complete next values, which the form has already assembled — is what
      // lets the reference be placed without threading a concrete path through
      // every field component, and what keeps create-and-link atomic.
      const pending = findPendingRefCreate(next);
      const res = resourceRef.current;
      const ctx = selectionContextRef.current;
      if (pending && res && ctx) {
        onCreateAndLink(
          { kind: res.kind, name: res.name },
          pending.kind,
          (newName) =>
            commitValues(
              res,
              ctx,
              resolvePendingRefCreate(next, pending.path, pending.kind, newName) as Record<
                string,
                unknown
              >,
            ),
        );
        return;
      }
      dirtyRef.current = true;
      setPointerFields(next);
    },
    [onCreateAndLink],
  );

  /** The resource's next fields for a pointer-scoped edit — the whole of what
   *  a commit writes, split out so create-and-link can hand the same result to
   *  the host without performing the write itself. */
  function commitValues(
    res: NonNullable<typeof resource>,
    ctx: NonNullable<typeof selectionContext>,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    const existing = pointerTarget(res.fields, ctx.pointer);
    if (!existing) return res.fields;

    const editableKeys = new Set(
      Object.keys((ctx.schema.properties as Record<string, unknown>) ?? {}),
    );
    const preserved = Object.fromEntries(
      Object.entries(existing).filter(([k]) => !editableKeys.has(k)),
    );
    const updated = { ...preserved, ...sanitizeFields(values) };
    return writePointer(res.fields, ctx.pointer, updated) as Record<string, unknown>;
  }

  function commitFields(
    res: NonNullable<typeof resource>,
    ctx: NonNullable<typeof selectionContext>,
    values: Record<string, unknown>,
  ) {
    const next = commitValues(res, ctx, values);
    if (next === res.fields) return;
    onUpdateResourceRef.current(res.kind, res.name, next);
  }

  // Debounced commit. Replaces the previous blur-only commit, which dropped
  // structural edits whose triggering control (a remove button) unmounted
  // before the browser could fire blur — e.g. clicking "×" on a JSON-schema
  // property added the property to local state but never wrote the deletion
  // back to the manifest.
  useEffect(() => {
    if (!dirtyRef.current || hasFormErrors || !selectionContext || !resource) return;
    const handle = setTimeout(() => {
      commitFields(resource, selectionContext, pointerFields);
      dirtyRef.current = false;
    }, 250);
    return () => clearTimeout(handle);
    // commitFields reads its inputs explicitly; the deps below are exactly
    // what determines whether/when to schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointerFields, hasFormErrors, selectionContext, resource]);

  // Flush pending edit when selection or resource changes, or on unmount.
  // Without this, navigating away within the 250ms debounce window would
  // clear the pending timer and reset `dirtyRef`, silently dropping the
  // user's last edit. The cleanup captures the OLD `sc`/`res` via closure
  // so the flush goes to the pointer the user was actually editing.
  useEffect(() => {
    const sc = selectionContext;
    const res = resource;
    return () => {
      if (!dirtyRef.current || !sc || !res || hasFormErrorsRef.current) return;
      commitFields(res, sc, pointerFieldsRef.current);
      dirtyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionContext, resource]);

  // Hooks must run unconditionally — keep them above the early return below.
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();

  if (!resource) return null;

  // Nothing selected, and the canvas is already this resource: there is no
  // detail to show that is not on screen a foot to the left. Rendering NOTHING
  // rather than a header over a hint — the canvas view carries its own heading
  // and the breadcrumb says where you are, so an empty panel would cost the
  // canvas a third of the width to repeat both.
  //
  // The YAML pane is the exception, and for the rule's own reason: source is
  // not something the canvas draws, so showing it is not duplication. Hiding it
  // here would also make the pane unreachable on the most common route to a
  // resource — focusing it on the canvas.
  if (echoesCanvas && !hasSelection && mode !== "yaml") return null;

  const resourceKind = viewData?.kinds.get(resource.kind);
  const resourceSchema = resourceKind?.schema;
  const resourceTopology = resourceKind?.topology;
  const detailSummary = summarizeResource(diagState, filePaths, resource.name);

  // Diagnostics for the form currently shown — each analyzer path is relative
  // to the resource root, so strip the form's pointer-scope prefix and keep the
  // remainder for per-field matching. Plain const (not memoized): hooks can't
  // run past the early return above, and the diagnostic set is small.
  const formDiagnostics: FieldDiagnostic[] = (() => {
    if (!selectionContext) return [];
    const scope = toSegments(selectionContext.pointer);
    const out: FieldDiagnostic[] = [];
    for (const { diagnostic } of detailSummary?.diagnostics ?? []) {
      const path = (diagnostic.data as { path?: string } | undefined)?.path;
      if (!path) continue;
      const segments = toSegments(path);
      if (!startsWith(segments, scope)) continue;
      out.push({ segments: segments.slice(scope.length), diagnostic });
    }
    return out;
  })();

  return (
    <div
      // Shares the row's free space with the content column instead of taking a
      // fixed 36rem off the top of it. The chrome around the canvas is four
      // fixed columns summing to ~1216px, so at a fixed width this panel made
      // the CONTENT the narrowest thing on screen on any laptop — the canvas is
      // `flex-1` over a zero basis, so it silently absorbed whatever was left
      // rather than pushing back. Growing to the same cap and no further keeps
      // the panel from ever being wider than what it annotates.
      className="flex h-full min-w-80 max-w-xl flex-1 flex-col overflow-hidden border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-100 px-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            {selectionContext && selectionContext.pointer
              ? `${resource.name} • ${selectionContext.pointer}`
              : resource.name}
          </span>
          {/* The kind being EDITED. For an inline declaration that is its own
              kind, not the host's — the host is already named to the left. */}
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {selectionContext?.inlineKind ?? resource.kind}
          </span>
          {selectionContext?.inlineKind && !readOnly && (
            <button
              type="button"
              onClick={() =>
                selectionContext.inlineKind &&
                setExtracting({
                  kind: selectionContext.inlineKind,
                  pointer: selectionContext.pointer,
                })
              }
              title="Move this declaration to its own resource and reference it here"
              className="flex shrink-0 items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-700 dark:hover:text-amber-300"
            >
              <FileOutput className="size-3" />
              Extract
            </button>
          )}
          <DiagnosticBadge summary={detailSummary} size="md" stopPropagation={false} />
        </div>
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as DetailMode)}
          className="ml-2 shrink-0"
        >
          <TabsList>
            <TabsTrigger value="form" className="px-2 text-xs">
              Form
            </TabsTrigger>
            <TabsTrigger value="yaml" className="px-2 text-xs">
              YAML
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {mode === "yaml" ? (
        <div className="min-h-0 flex-1">
          <DetailYamlPane
            sourceFiles={viewData?.sourceFiles ?? []}
            resource={{ kind: resource.kind, name: resource.name }}
            // The selection's own path when there is one, the whole resource
            // document otherwise — the same scope the form is showing.
            pointer={selectionContext?.pointer ?? ""}
            readOnly={readOnly}
            onSourceEdit={onSourceEdit}
            // The whole resource's, unfiltered: the pane holds a span of the
            // file and decides for itself which of them fall inside it — the
            // form's per-field matching is by PATH, which says nothing about
            // where a diagnostic lands in the text.
            diagnostics={detailSummary?.diagnostics ?? []}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto">
        {selectionContext ? (
          <div className="flex flex-col gap-3 p-3">
            {/* A summary of the WHOLE root, so it belongs only where the root
                itself is what's open. An entry-scoped edit from the module bar
                (`/variables/dbConnection`) is about one binding, and the boot
                sequence above it is noise. */}
            {isModuleRootKind(resource.kind) && selectionContext.pointer === "" && (
              <ModuleRootTargetsSummary fields={resource.fields} />
            )}
            <ResourceSchemaForm
              schema={selectionContext.schema}
              values={pointerFields}
              onChange={handlePointerChange}
              onParseStateChange={setHasFormErrors}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
              onOpenInline={(fieldPath, kind) =>
                onSelect({
                  resource: { kind: resource.kind, name: resource.name },
                  // The form's path is relative to the form's own scope, so a
                  // drill-in from a scoped form composes with that scope.
                  pointer: fieldPointer(selectionContext.pointer, fieldPath),
                  // Replaced by the inline kind's own schema when the selection
                  // resolves; carried so a selection is never schema-less.
                  schema: viewData?.kinds.get(kind)?.schema ?? {},
                })
              }
              // Both directions of the same move, offered at the slot so the
              // parent's form is enough to make it — reaching either from
              // inside the declaration costs a navigation each way.
              onMoveDeclaration={
                readOnly
                  ? undefined
                  : (fieldPath, direction) => {
                      const pointer = fieldPointer(selectionContext.pointer, fieldPath);
                      if (direction === "inline") {
                        onInlineReference({ kind: resource.kind, name: resource.name }, pointer);
                        return;
                      }
                      // Read from the form's own values: they are what the slot
                      // is showing, and what a commit is about to write.
                      const kind = inlineResourceKind(
                        readPointer(pointerFields, fieldPointer("", fieldPath)),
                      );
                      if (kind) setExtracting({ kind, pointer });
                    }
              }
              celTarget={{
                resource: { kind: resource.kind, name: resource.name },
                pointer: selectionContext.pointer,
              }}
              typeKinds={typeKinds}
              registry={registry}
              flat={isModuleRootKind(resource.kind)}
              fieldDiagnostics={formDiagnostics}
            />
          </div>
        ) : !resourceSchema || !viewData ? (
          <p className="p-3 text-xs text-zinc-400 dark:text-zinc-600">
            No definition schema found for this resource kind.
          </p>
        ) : (
          <PickCanvas
            viewData={viewData}
            resource={resource}
            schema={resourceSchema}
            topology={resourceTopology}
            resolvedResources={resolvedResources}
            typeKinds={typeKinds}
            registry={registry}
            onUpdateResource={onUpdateResource}
            onCreateAndLink={onCreateAndLink}
            onSelectResource={onSelectResource}
            onSelect={onSelect}
            onBackgroundClick={() => undefined}
            hideHeader
          />
        )}
      </div>
      )}

      {extracting && (
        <ExtractInlineDialog
          open
          onOpenChange={(open) => !open && setExtracting(null)}
          kind={extracting.kind}
          suggestion={suggestedResourceName(
            extracting.kind,
            viewData?.kinds.get(extracting.kind)?.capability,
            resolvedResources.map((r) => r.name),
          )}
          taken={resolvedResources.map((r) => r.name)}
          onExtract={(name) => {
            setExtracting(null);
            onExtractInline(
              { kind: resource.kind, name: resource.name },
              extracting.pointer,
              name,
            );
          }}
        />
      )}
    </div>
  );
}
