import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewData, Selection } from "../model";
import { summarizeResource } from "../diagnostics-aggregate";
import { isRecord } from "../lib/utils";
import type { CelEvalMode } from "./resource-schema-form/cel-utils";
import { DiagnosticBadge } from "./diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "./diagnostics/DiagnosticsContext";
import { Button } from "./ui/button";
import type { ResolvedResourceOption } from "./ResourceSchemaForm";
import { ResourceSchemaForm } from "./ResourceSchemaForm";
import { PickCanvas } from "./views/pick-canvas";

interface DetailPanelProps {
  selectedResource: { kind: string; name: string } | null;
  graphContext: { kind: string; name: string } | null;
  selection: Selection | null;
  viewData: ModuleViewData | null;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelectResource: (kind: string, name: string) => void;
  onSelect: (selection: Selection) => void;
  onNavigateResource: (kind: string, name: string) => void;
}

function sanitizeFields(values: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    next[key] = value;
  }
  return next;
}

function parsePointer(pointer: string): (string | number)[] {
  if (!pointer) return [];
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((s) => {
      const n = Number(s);
      return Number.isInteger(n) && n >= 0 ? n : s;
    });
}

function getByPointer(obj: unknown, pointer: string): unknown {
  const segments = parsePointer(pointer);
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) current = current[seg as number];
    else if (isRecord(current)) current = current[seg as string];
    else return undefined;
  }
  return current;
}

function setByPointer(root: unknown, pointer: string, value: unknown): unknown {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return value;

  function update(obj: unknown, idx: number): unknown {
    if (idx === segments.length) return value;
    const seg = segments[idx];
    if (Array.isArray(obj)) {
      const arr = [...obj];
      arr[seg as number] = update(arr[seg as number], idx + 1);
      return arr;
    }
    if (isRecord(obj)) {
      return { ...obj, [seg as string]: update(obj[seg as string], idx + 1) };
    }
    return obj;
  }

  return update(root, 0);
}

export function DetailPanel({
  selectedResource,
  graphContext,
  selection,
  viewData,
  onUpdateResource,
  onSelectResource,
  onSelect,
  onNavigateResource,
}: DetailPanelProps) {
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

  const selectionContext = useMemo(() => {
    if (!resource || !selection) return null;
    if (
      selection.resource.kind !== resource.kind ||
      selection.resource.name !== resource.name
    ) {
      return null;
    }

    const target = getByPointer(resource.fields, selection.pointer);
    if (!isRecord(target)) return null;

    return { ...selection, values: target };
  }, [resource, selection]);

  const rootCelEval: CelEvalMode | null = useMemo(() => {
    if (!resource || !viewData) return null;
    const capability = viewData.kinds.get(resource.kind)?.capability;
    return capability === "Telo.Provider" ? "compile" : null;
  }, [resource, viewData]);

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

  const handlePointerChange = useCallback((next: Record<string, unknown>) => {
    dirtyRef.current = true;
    setPointerFields(next);
  }, []);

  function commitFields(
    res: NonNullable<typeof resource>,
    ctx: NonNullable<typeof selectionContext>,
    values: Record<string, unknown>,
  ) {
    const target = getByPointer(res.fields, ctx.pointer);
    if (!isRecord(target)) return;

    const editableKeys = new Set(
      Object.keys((ctx.schema.properties as Record<string, unknown>) ?? {}),
    );
    const preserved = Object.fromEntries(
      Object.entries(target).filter(([k]) => !editableKeys.has(k)),
    );
    const updated = { ...preserved, ...sanitizeFields(values) };
    const nextFields = setByPointer(res.fields, ctx.pointer, updated);

    onUpdateResourceRef.current(res.kind, res.name, nextFields as Record<string, unknown>);
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

  if (!resource) return null;

  const resourceKind = viewData?.kinds.get(resource.kind);
  const resourceSchema = resourceKind?.schema;
  const resourceTopology = resourceKind?.topology;
  const isGraphContext =
    graphContext?.kind === resource.kind && graphContext?.name === resource.name;
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const detailSummary = summarizeResource(diagState, filePaths, resource.name);

  return (
    <div className="flex h-full w-xl flex-col overflow-hidden border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-100 px-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            {selectionContext
              ? `${resource.name} • ${selectionContext.pointer}`
              : resource.name}
          </span>
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {resource.kind}
          </span>
          <DiagnosticBadge summary={detailSummary} size="md" stopPropagation={false} />
        </div>
        {!selectionContext && !isGraphContext && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onNavigateResource(resource.kind, resource.name)}
            title="Replace main canvas with this resource"
          >
            Open in canvas
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {selectionContext ? (
          <div className="p-3">
            <ResourceSchemaForm
              schema={selectionContext.schema}
              values={pointerFields}
              onChange={handlePointerChange}
              onParseStateChange={setHasFormErrors}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
            />
          </div>
        ) : !resourceSchema ? (
          <p className="p-3 text-xs text-zinc-400 dark:text-zinc-600">
            No definition schema found for this resource kind.
          </p>
        ) : (
          <PickCanvas
            resource={resource}
            schema={resourceSchema}
            topology={resourceTopology}
            resolvedResources={resolvedResources}
            onUpdateResource={onUpdateResource}
            onSelectResource={onSelectResource}
            onSelect={onSelect}
            onBackgroundClick={() => undefined}
            hideHeader
          />
        )}
      </div>
    </div>
  );
}
