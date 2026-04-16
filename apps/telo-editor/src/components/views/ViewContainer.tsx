import type { ViewId } from "../../model";
import { InventoryView } from "./inventory/InventoryView";
import { SourceView } from "./source/SourceView";
import { TopologyView } from "./topology/TopologyView";
import type { ViewProps } from "./types";

interface ViewContainerProps {
  activeView: ViewId;
  onChangeView: (view: ViewId) => void;
  viewProps: ViewProps;
}

const VIEW_TABS: { id: ViewId; label: string }[] = [
  { id: "topology", label: "Topology" },
  { id: "inventory", label: "Inventory" },
  { id: "source", label: "Source" },
];

export function ViewContainer({ activeView, onChangeView, viewProps }: ViewContainerProps) {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* View tab bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        {VIEW_TABS.map((tab) => (
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

      {/* Active view */}
      <div className="flex flex-1 overflow-hidden">
        {activeView === "topology" && <TopologyView {...viewProps} />}
        {activeView === "inventory" && <InventoryView {...viewProps} />}
        {activeView === "source" && <SourceView {...viewProps} />}
      </div>
    </div>
  );
}
