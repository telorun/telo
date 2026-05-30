import { MODULE_OVERVIEW_TOPOLOGY } from "../../application-adapter";
import type { CanvasViewport, ParsedResource, Selection } from "../../model";
import type { ResolvedResourceOption } from "../resource-schema-form/types";
import { ResourceCanvas } from "./resource-canvas/ResourceCanvas";
import { ApplicationTopologyCanvas } from "./topology/ApplicationTopologyCanvas";
import type { AppCanvasModel } from "./topology/application-canvas-model";
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
  /** Module-wide overview model — supplied by `TopologyView` only when
   *  `topology === "Application"`. Other canvases ignore it. */
  applicationModel?: AppCanvasModel | null;
  /** Active module's filePath — keys the overview canvas's viewport per app/lib. */
  viewportKey?: string;
  /** Saved overview-canvas viewport for the active module, or null to fit. */
  canvasViewport?: CanvasViewport | null;
  /** Persists the overview-canvas viewport after pan/zoom. */
  onCanvasViewportChange?: (viewport: CanvasViewport) => void;
  /** Currently selected resource — highlights the matching overview node. */
  selectedResource?: { kind: string; name: string } | null;
  /** Removes a resource (overview-canvas Delete key). */
  onDeleteResource?: (kind: string, name: string) => void;
  /** Rewrites the Application's `targets` (drag-to-wire). Read-only when absent. */
  onUpdateApplicationTargets?: (targets: string[]) => void;
  /** Opens the create-resource flow (Application canvas action). */
  onCreateResource?: () => void;
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
  applicationModel,
  viewportKey,
  canvasViewport,
  onCanvasViewportChange,
  selectedResource,
  onDeleteResource,
  onUpdateApplicationTargets,
  onCreateResource,
  hideHeader,
}: PickCanvasProps) {
  if (topology === MODULE_OVERVIEW_TOPOLOGY) {
    if (!applicationModel) {
      return (
        <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
          <span className="text-sm text-zinc-400 dark:text-zinc-600">Analyzing module…</span>
        </div>
      );
    }
    return (
      <ApplicationTopologyCanvas
        model={applicationModel}
        viewportKey={viewportKey ?? ""}
        viewport={canvasViewport}
        onViewportChange={onCanvasViewportChange}
        selectedResource={selectedResource}
        onDeleteResource={onDeleteResource}
        onSelectResource={onSelectResource}
        onTargetsChange={onUpdateApplicationTargets}
        onCreateResource={onCreateResource}
        onBackgroundClick={onBackgroundClick}
      />
    );
  }

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
