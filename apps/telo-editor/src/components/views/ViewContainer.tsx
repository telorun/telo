import { Lock } from "lucide-react";
import { getModuleFiles, summarizeFiles } from "../../diagnostics-aggregate";
import type { ModuleKind, ViewId } from "../../model";
import { DiagnosticBadge } from "../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../diagnostics/DiagnosticsContext";
import { DefinitionsView } from "./definitions/DefinitionsView";
import { DeploymentView } from "./deployment/DeploymentView";
import { ImportsView } from "./imports/ImportsView";
import { KindsView } from "./kinds/KindsView";
import { ResourcesView } from "./resources/ResourcesView";
import { SourceView } from "./source/SourceView";
import { TopologyView } from "./topology/TopologyView";
import type { ViewProps } from "./types";

interface ViewContainerProps {
  activeView: ViewId;
  onChangeView: (view: ViewId) => void;
  viewProps: ViewProps;
}

interface TabEntry {
  id: ViewId;
  label: string;
  /** If true, hidden when the active module is a Library. */
  applicationOnly?: boolean;
}

const VIEW_TABS: TabEntry[] = [
  { id: "topology", label: "Graph" },
  { id: "imports", label: "Imports" },
  { id: "definitions", label: "Definitions" },
  { id: "resources", label: "Resources" },
  { id: "kinds", label: "Kinds" },
  { id: "deployment", label: "Deployment", applicationOnly: true },
  { id: "source", label: "Source" },
];

function isTabVisible(tab: TabEntry, kind: ModuleKind): boolean {
  if (tab.applicationOnly && kind !== "Application") return false;
  return true;
}

/** Views that are edit surfaces: while the agent holds the workspace they get a
 *  pointer-blocking overlay. Browse-only views (resources/definitions/kinds)
 *  stay interactive, and Source handles its own Monaco read-only mode. */
const OVERLAY_LOCKED_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>([
  "topology",
  "imports",
  "deployment",
]);

export function ViewContainer({ activeView, onChangeView, viewProps }: ViewContainerProps) {
  const kind = viewProps.viewData.manifest.kind;
  const visibleTabs = VIEW_TABS.filter((t) => isTabVisible(t, kind));
  // Module-wide rollup surfaced on the Source tab — the same dot + count the
  // sidebar shows per module, since Source is where you go to fix diagnostics.
  const diagState = useDiagnosticsState();
  const sourceSummary = summarizeFiles(diagState, getModuleFiles(viewProps.viewData.manifest));
  // If the active view is hidden (e.g. "deployment" while viewing a Library),
  // render nothing — Editor is expected to reset activeView when this happens,
  // but we guard here so a stale state doesn't crash the canvas.
  const renderedView = visibleTabs.some((t) => t.id === activeView) ? activeView : null;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        {visibleTabs.map((tab) => (
          <div key={tab.id} className="flex items-center">
            <button
              onClick={() => onChangeView(tab.id)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                activeView === tab.id
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
            {tab.id === "source" && <DiagnosticBadge summary={sourceSummary} size="sm" />}
          </div>
        ))}
      </div>

      {viewProps.readOnly && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <Lock className="size-3 shrink-0" />
          Editing is paused while the agent is working.
        </div>
      )}

      <div className="relative flex flex-1 overflow-hidden">
        {renderedView === "topology" && <TopologyView {...viewProps} />}
        {renderedView === "imports" && <ImportsView {...viewProps} />}
        {renderedView === "definitions" && <DefinitionsView {...viewProps} />}
        {renderedView === "resources" && <ResourcesView {...viewProps} />}
        {renderedView === "kinds" && <KindsView {...viewProps} />}
        {renderedView === "source" && <SourceView {...viewProps} />}
        {renderedView === "deployment" && (
          <DeploymentView
            manifest={viewProps.viewData.manifest}
            environment={viewProps.deployment.activeEnvironment}
            onSetEnvVars={viewProps.deployment.onSetEnvVars}
          />
        )}
        {viewProps.readOnly && renderedView && OVERLAY_LOCKED_VIEWS.has(renderedView) && (
          <div
            aria-hidden
            className="absolute inset-0 z-10 cursor-not-allowed bg-white/40 dark:bg-zinc-950/40"
          />
        )}
      </div>
    </div>
  );
}
