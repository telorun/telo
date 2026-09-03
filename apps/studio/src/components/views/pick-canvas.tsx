import { isModuleRootKind } from "../../application-adapter";
import { getStepSchema } from "../../schema-utils";
import { entryListOf } from "./topology/entry-list-model";
import type { ModuleViewData, ParsedResource, Selection } from "../../model";
import type { RefResolver } from "../resource-schema-form/ref-candidates";
import type { ResolvedResourceOption, TypeKindOption } from "../resource-schema-form/types";
import type { TopologyViewContext } from "./topology/topology-view";
import { resolveView } from "./topology/view-registry";

interface PickCanvasProps {
  viewData: ModuleViewData;
  resource: ParsedResource;
  schema: Record<string, unknown>;
  /** The kind's declared `topology`, which is what narrows the candidate set to
   *  a kind-specific view (Router). */
  topology?: string;
  resolvedResources: ResolvedResourceOption[];
  /** Imported `Telo.Type` kinds offered for inline type fields. */
  typeKinds?: TypeKindOption[];
  /** Narrows `x-telo-ref` candidates by kind satisfaction (abstract refs). */
  registry?: RefResolver | null;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  /** Forwarded so a ref slot with no candidates can still create one — the peek
   *  panel renders the same field controls the topology views do. Required for
   *  the same reason it is on the view contract. */
  onCreateAndLink: (
    target: { kind: string; name: string },
    createKind: string,
    buildFields: (newName: string) => Record<string, unknown>,
  ) => void;
  onSelectResource: (kind: string, name: string) => void;
  onSelect: (selection: Selection) => void;
  onBackgroundClick: () => void;
  hideHeader?: boolean;
}

/**
 * The canvas for one resource on a surface with no view picker — the detail
 * panel's peek. It resolves through the same registry the topology host uses and
 * takes the first applicable view, so "which canvas does this kind get" is
 * answered in exactly one place; a second dispatcher here is what would let a
 * kind-declared canvas and a user-chosen view disagree.
 *
 * The module-wide views need a containment tree, which a peek has no analysis to
 * build, so they render their own loading state here — the same thing the peek
 * showed before there was a registry.
 */
export function PickCanvas({
  viewData,
  resource,
  schema,
  topology,
  resolvedResources,
  typeKinds,
  registry,
  onUpdateResource,
  onCreateAndLink,
  onSelectResource,
  onSelect,
  onBackgroundClick,
  hideHeader,
}: PickCanvasProps) {
  const ctx: TopologyViewContext = {
    kind: { fullKind: resource.kind, topology },
    hasSteps: !!getStepSchema(schema),
    hasEntries: !!entryListOf(schema),
    isModuleRoot: isModuleRootKind(resource.kind),
  };
  const view = resolveView(ctx, undefined);
  if (!view) return null;

  return (
    <view.Component
      moduleGraph={null}
      moduleGraphFor={() => null}
      isEditableModule={() => false}
      viewData={viewData}
      registry={null}
      refResolver={registry ?? null}
      resource={resource}
      schema={schema}
      resolvedResources={resolvedResources}
      typeKinds={typeKinds ?? []}
      selectedResource={null}
      selection={null}
      state={undefined}
      onStateChange={() => undefined}
      viewportFor={() => null}
      onViewportChange={() => undefined}
      onSelectResource={onSelectResource}
      onSelect={onSelect}
      onUpdateResource={onUpdateResource}
      onCreateAndLink={onCreateAndLink}
      onBackgroundClick={onBackgroundClick}
      hideHeader={hideHeader}
    />
  );
}
