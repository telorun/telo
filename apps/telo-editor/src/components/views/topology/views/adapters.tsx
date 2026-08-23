import { ResourceCanvas } from "../../resource-canvas/ResourceCanvas";
import { RouterTopologyCanvas } from "../RouterTopologyCanvas";
import type { TopologyViewProps } from "../topology-view";

/**
 * The kind-declared canvases, wrapped to the shared view contract.
 *
 * They predate the registry and take only the resource they render, so the
 * adapters are the whole change: what made them views rather than a separate
 * dispatch is `supports`, not a rewrite. A kind that declares its own topology
 * now competes for the same slot as the general views, and the user picks.
 *
 * The routes canvas is what is left here. A router's entries are a keyed SET,
 * so a table is the honest picture of them; a step body is ordered, and its
 * view is `StepsView`, built on the shared step-body annotation rather than on
 * a per-kind `topology:` declaration.
 */

export function RouterView({
  resource,
  schema,
  onUpdateResource,
  onSelect,
  onBackgroundClick,
}: TopologyViewProps) {
  return (
    <RouterTopologyCanvas
      resource={resource}
      schema={schema}
      onUpdateResource={onUpdateResource}
      onSelect={onSelect}
      onBackgroundClick={onBackgroundClick}
    />
  );
}

export function ResourceFormView({
  resource,
  schema,
  resolvedResources,
  typeKinds,
  refResolver,
  onUpdateResource,
  onCreateAndLink,
  onSelectResource,
  onBackgroundClick,
  hideHeader,
}: TopologyViewProps) {
  return (
    <ResourceCanvas
      resource={resource}
      schema={schema}
      resolvedResources={resolvedResources}
      typeKinds={typeKinds}
      registry={refResolver}
      onUpdateResource={onUpdateResource}
      onCreateAndLink={onCreateAndLink}
      onSelectResource={onSelectResource}
      onBackgroundClick={onBackgroundClick}
      hideHeader={hideHeader}
    />
  );
}
