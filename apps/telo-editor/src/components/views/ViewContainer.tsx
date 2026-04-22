import type { ModuleKind, ViewId } from "../../model";
import { DeploymentView } from "./deployment/DeploymentView";
import { InventoryView } from "./inventory/InventoryView";
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
  { id: "topology", label: "Topology" },
  { id: "inventory", label: "Inventory" },
  { id: "deployment", label: "Deployment", applicationOnly: true },
  { id: "source", label: "Source" },
];

function isTabVisible(tab: TabEntry, kind: ModuleKind): boolean {
  if (tab.applicationOnly && kind !== "Application") return false;
  return true;
}

export function ViewContainer({ activeView, onChangeView, viewProps }: ViewContainerProps) {
  const kind = viewProps.viewData.manifest.kind;
  const visibleTabs = VIEW_TABS.filter((t) => isTabVisible(t, kind));
  // If the active view is hidden (e.g. "deployment" while viewing a Library),
  // render nothing — Editor is expected to reset activeView when this happens,
  // but we guard here so a stale state doesn't crash the canvas.
  const renderedView = visibleTabs.some((t) => t.id === activeView) ? activeView : null;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChangeView(tab.id)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              activeView === tab.id
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {renderedView === "topology" && <TopologyView {...viewProps} />}
        {renderedView === "inventory" && <InventoryView {...viewProps} />}
        {renderedView === "source" && <SourceView {...viewProps} />}
        {renderedView === "deployment" && (
          <DeploymentView
            environment={viewProps.deployment.activeEnvironment}
            onSetEnvVars={viewProps.deployment.onSetEnvVars}
            onSetPorts={viewProps.deployment.onSetPorts}
          />
        )}
      </div>
    </div>
  );
}
