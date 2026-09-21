import { capabilityStartsTargets } from "@telorun/analyzer";
import { ArrowLeft, ChevronRight, Lock } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { AvailableKind, ParsedResource, Selection } from "../../../../model";
import { suggestedResourceName } from "../../../../resource-naming";
import { celEvalModeAtPointer } from "../../../resource-schema-form/cel-utils";
import type { JsonSchemaProperty } from "../../../resource-schema-form/types";
import { Button } from "../../../ui/button";
import type { RefWrite } from "../application-canvas-model";
import type { TopologyViewProps } from "../topology-view";
import { ModuleGraphView } from "./ModuleGraphView";
import {
  entryAddress,
  entryAt,
  entryPointer,
  entryRefWrites,
  extractedEntries,
  isBootRoot,
  templateBody,
  TemplateWriteRefused,
  withBootSequence,
  withCreatedEntries,
  withEntryFields,
  type TemplateBody,
} from "./template-body";
import type { TemplateGraph } from "./template-graph";

/**
 * A templated kind's body, as a canvas of its own.
 *
 * It is the module canvas, drawn over the body: each entry is a box, a
 * reference between entries is an edge, and the definition's boot sequence
 * marks the entries it starts. What differs is where a write lands — every
 * entry lives inside the definition's `resources:`, so each edit the canvas
 * makes against an entry is re-addressed into that one document (see
 * `template-body.ts`), and a selection opens the entry in the detail panel at
 * its place in the definition.
 *
 * A module resource the body references is drawn too, read-only: selecting it
 * opens the resource itself, and no write reaches it from here. A write the
 * body cannot take — to a name it declares twice — is refused and reported.
 */
export function TemplateCanvas({
  canvas,
  template,
  editable,
  moduleName,
  state,
  onStateChange,
  onBack,
}: {
  /** The module canvas's own props — the host this body sits in. */
  canvas: TopologyViewProps;
  template: TemplateGraph;
  /** The definition is this module's own and its file can be written. */
  editable: boolean;
  moduleName: string;
  state: unknown;
  onStateChange: (next: unknown) => void;
  onBack: () => void;
}) {
  const {
    viewData,
    selection,
    viewportFor,
    onViewportChange,
    onSelect,
    onSelectResource,
    onUpdateResource,
    onMoveField,
    onRemoveField,
    onWriteRef,
  } = canvas;

  const body = useMemo<TemplateBody>(() => {
    const declared = editable
      ? viewData.manifest.resources.find(
          (r) => r.kind === template.definition.kind && r.name === template.name,
        )
      : undefined;
    return templateBody(declared ?? analyzedResource(template), extractedEntries(template.graph));
  }, [editable, viewData, template]);

  const definitionRef = useMemo(
    () => ({ kind: body.definition.kind, name: body.definition.name }),
    [body],
  );

  /** The module's resources the body reaches — drawn here, owned elsewhere. */
  const enclosing = useMemo(
    () =>
      new Set(
        template.graph.nodes
          .filter((node) => node.ownership === "enclosing")
          .map((node) => `${node.kind}\0${node.name}`),
      ),
    [template],
  );
  const isEnclosing = useCallback(
    (resource: { kind: string; name: string }) =>
      enclosing.has(`${resource.kind}\0${resource.name}`),
    [enclosing],
  );

  const schemaOf = useCallback(
    (kind: string) => viewData.kinds.get(kind)?.schema as JsonSchemaProperty | undefined,
    [viewData],
  );

  /** The entry the panel has open, when the open selection is inside this body
   *  — or the module resource it has open, when that is one the body reaches. */
  const selectedEntry = useMemo(() => {
    if (!selection) return null;
    if (
      selection.resource.kind === definitionRef.kind &&
      selection.resource.name === definitionRef.name
    ) {
      return entryAt(body, selection.pointer) ?? null;
    }
    return isEnclosing(selection.resource) ? selection.resource : null;
  }, [selection, definitionRef, body, isEnclosing]);

  const selectEntry = useCallback(
    (kind: string, name: string) => {
      if (isEnclosing({ kind, name })) {
        onSelectResource(kind, name);
        return;
      }
      refusing(() =>
        onSelect({
          resource: definitionRef,
          pointer: entryPointer(entryAddress(body, name), ""),
          schema: (schemaOf(kind) as Record<string, unknown> | undefined) ?? {
            type: "object",
            additionalProperties: true,
          },
        }),
      );
    },
    [isEnclosing, onSelectResource, onSelect, definitionRef, body, schemaOf],
  );

  const selectInEntry = useCallback(
    (inner: Selection) => {
      if (isEnclosing(inner.resource)) {
        onSelect(inner);
        return;
      }
      refusing(() => {
        const address = entryAddress(body, inner.resource.name);
        const entry = body.entries.find((e) => e.name === inner.resource.name);
        const celEval =
          inner.celEval ??
          (entry ? celEvalModeAtPointer(schemaOf(entry.kind), inner.pointer) : null) ??
          undefined;
        onSelect({
          ...inner,
          resource: definitionRef,
          pointer: entryPointer(address, inner.pointer),
          ...(celEval ? { celEval } : {}),
        });
      });
    },
    [isEnclosing, body, onSelect, definitionRef, schemaOf],
  );

  const updateResource = useCallback(
    (kind: string, name: string, fields: Record<string, unknown>) =>
      refusing(() => {
        const next = isBootRoot(body, kind, name)
          ? withBootSequence(body, bootSequenceOf(fields))
          : withEntryFields(body, entryAddress(body, name), fields);
        onUpdateResource(definitionRef.kind, definitionRef.name, next);
      }),
    [body, onUpdateResource, definitionRef],
  );

  const moveField = useMemo(
    () =>
      onMoveField
        ? (target: { kind: string; name: string }, pointer: string, toIndex: number) =>
            refusing(() =>
              onMoveField(
                definitionRef,
                isBootRoot(body, target.kind, target.name)
                  ? pointer
                  : entryPointer(entryAddress(body, target.name), pointer),
                toIndex,
              ),
            )
        : undefined,
    [onMoveField, body, definitionRef],
  );

  const removeField = useMemo(
    () =>
      onRemoveField
        ? (target: { kind: string; name: string }, pointer: string) =>
            refusing(() => {
              if (!isBootRoot(body, target.kind, target.name)) {
                onRemoveField(definitionRef, entryPointer(entryAddress(body, target.name), pointer));
                return;
              }
              // A lone `run:` has no sequence to splice: taking its one entry
              // out removes the field.
              if (body.bootFrom === "run") {
                onUpdateResource(definitionRef.kind, definitionRef.name, withBootSequence(body, []));
                return;
              }
              onRemoveField(definitionRef, pointer);
            })
        : undefined,
    [onRemoveField, onUpdateResource, body, definitionRef],
  );

  const writeRef = useMemo(
    () =>
      onWriteRef
        ? (writes: RefWrite[]) =>
            refusing(() => {
              if (!writes.some((write) => write.createKind)) {
                onWriteRef(entryRefWrites(body, writes));
                return;
              }
              onUpdateResource(
                definitionRef.kind,
                definitionRef.name,
                withCreatedEntries(body, writes, (kind, taken) =>
                  suggestedResourceName(kind, viewData.kinds.get(kind)?.capability, taken),
                ),
              );
            })
        : undefined,
    [onWriteRef, onUpdateResource, body, definitionRef, viewData],
  );

  const innerViewData = useMemo(() => {
    // The body's entries, and the module resources it reaches, which a row of
    // theirs is still read from. The kind's own schema is in hand even for an
    // imported kind the module knows only by alias: a forwarded field is
    // titled from it.
    const kinds = new Map(viewData.kinds);
    if (!kinds.has(template.kindId)) kinds.set(template.kindId, templateKind(template));
    return {
      ...viewData,
      kinds,
      manifest: {
        ...viewData.manifest,
        resources: [
          ...body.entries,
          ...viewData.manifest.resources.filter((resource) => isEnclosing(resource)),
        ],
      },
    };
  }, [viewData, body, template, isEnclosing]);

  const resolvedResources = useMemo(
    () =>
      body.entries.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        capability: viewData.kinds.get(entry.kind)?.capability || undefined,
      })),
    [body, viewData],
  );

  const outerIsEditable = canvas.isEditableModule;
  const isEditableModule = useCallback(
    (module: string) => editable && outerIsEditable(module),
    [editable, outerIsEditable],
  );

  const bodyViewportFor = useCallback(
    (key: string) => viewportFor(`template:${template.kindId}#${key}`),
    [viewportFor, template.kindId],
  );
  const bodyViewportChange = useCallback<TopologyViewProps["onViewportChange"]>(
    (key, viewport) => onViewportChange(`template:${template.kindId}#${key}`, viewport),
    [onViewportChange, template.kindId],
  );

  const inner: TopologyViewProps = {
    ...canvas,
    moduleGraph: template.graph,
    viewData: innerViewData,
    resource: body.bootRoot,
    resolvedResources,
    selectedResource: selectedEntry,
    state,
    onStateChange,
    viewportFor: bodyViewportFor,
    onViewportChange: bodyViewportChange,
    isEditableModule,
    onSelectResource: selectEntry,
    onSelect: selectInEntry,
    onUpdateResource: updateResource,
    onMoveField: editable ? moveField : undefined,
    onRemoveField: editable ? removeField : undefined,
    onWriteRef: editable ? writeRef : undefined,
    // Each of these writes a document of its own, which a body entry does not
    // have — extraction would move a sibling out of the body it belongs to.
    onExtractInline: undefined,
    onRelocateField: undefined,
    onDeleteResource: undefined,
    onCreateResource: undefined,
    onOpenTemplate: undefined,
    bootWritable:
      editable && capabilityStartsTargets(template.capability),
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        <Button variant="ghost" size="xs" onClick={onBack} title="Back to the module">
          <ArrowLeft />
          {moduleName}
        </Button>
        <ChevronRight className="size-3 shrink-0 text-zinc-400" />
        <span className="font-semibold text-zinc-800 dark:text-zinc-100">{template.name}</span>
        <span className="rounded bg-zinc-100 px-1 text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          template
        </span>
        {!editable && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400">
            <Lock className="size-3" />
            read-only
          </span>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <ModuleGraphView key={template.kindId} {...inner} />
      </div>
    </div>
  );
}

/**
 * Run a write the body may refuse, reporting the refusal where the reader is.
 *
 * A refusal is the body saying the write has no single place to land; any
 * other failure is not one, and is rethrown as it came.
 */
function refusing(write: () => void): void {
  try {
    write();
  } catch (error) {
    if (!(error instanceof TemplateWriteRefused)) throw error;
    toast.error("Edit not applied", { description: error.message });
  }
}

/** The boot sequence a boot-root write carries. */
function bootSequenceOf(fields: Record<string, unknown>): unknown[] {
  const targets = fields.targets;
  return Array.isArray(targets) ? targets : [];
}

/** The analyzed definition as a resource — the read-only body's source, where
 *  the workspace holds no document for it. */
function analyzedResource(template: TemplateGraph): ParsedResource {
  const { kind, metadata, ...fields } = template.definition as unknown as Record<string, unknown>;
  return { kind: kind as string, name: template.name, fields };
}

/** The templated kind itself, under its canonical id. */
function templateKind(template: TemplateGraph): AvailableKind {
  const schema = (template.definition as unknown as { schema?: unknown }).schema;
  return {
    fullKind: template.kindId,
    alias: template.module ?? template.name,
    kindName: template.name,
    capability: template.capability ?? "",
    schema: (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>,
    categories: [],
  };
}
