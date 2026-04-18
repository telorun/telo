import type { ParsedResource, Selection } from "../../model";
import type { ResolvedResourceOption } from "../resource-schema-form/types";
import { ResourceCanvas } from "./resource-canvas/ResourceCanvas";
import { RouterTopologyCanvas } from "./topology/RouterTopologyCanvas";
import { SequenceTopologyCanvas } from "./topology/SequenceTopologyCanvas";

interface PickCanvasProps {
  resource: ParsedResource;
  schema: Record<string, unknown>;
  topology?: string;
  resolvedResources: ResolvedResourceOption[];
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelectResource: (kind: string, name: string) => void;
  onSelect: (selection: Selection) => void;
  onBackgroundClick: () => void;
  /** Forwarded to `ResourceCanvas` only. Specialized canvases (Router,
   *  Sequence) render their own headers. */
  hideHeader?: boolean;
}

/** Picks the canvas renderer for a resource based on its kind's `topology`.
 *  Shared by `TopologyView` (main canvas) and `DetailPanel` (peek panel) so
 *  both surfaces agree on which renderer to show for a given kind. */
export function PickCanvas({
  resource,
  schema,
  topology,
  resolvedResources,
  onUpdateResource,
  onSelectResource,
  onSelect,
  onBackgroundClick,
  hideHeader,
}: PickCanvasProps) {
  if (topology === "Router") {
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

  if (topology === "Sequence") {
    return (
      <SequenceTopologyCanvas
        resource={resource}
        schema={schema}
        onUpdateResource={onUpdateResource}
        onSelect={onSelect}
        onBackgroundClick={onBackgroundClick}
      />
    );
  }

  return (
    <ResourceCanvas
      resource={resource}
      schema={schema}
      resolvedResources={resolvedResources}
      onUpdateResource={onUpdateResource}
      onSelectResource={onSelectResource}
      onBackgroundClick={onBackgroundClick}
      hideHeader={hideHeader}
    />
  );
}
