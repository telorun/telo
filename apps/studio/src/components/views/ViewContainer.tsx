import { Lock } from "lucide-react";
import { getModuleFiles, summarizeFiles } from "../../diagnostics-aggregate";
import type { ModuleKind, ViewId } from "../../model";
import { RunBar, RunDock, useRun } from "../../run";
import { DiagnosticBadge } from "../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../diagnostics/DiagnosticsContext";
import { OutlineView } from "./outline/OutlineView";
import { RunConfigView } from "./run/RunConfigView";
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
  { id: "outline", label: "Outline" },
  { id: "run", label: "Run", applicationOnly: true },
  { id: "source", label: "Source" },
];

function isTabVisible(tab: TabEntry, kind: ModuleKind): boolean {
  if (tab.applicationOnly && kind !== "Application") return false;
  return true;
}

/** Views that are edit surfaces: while the agent holds the workspace they get a
 *  pointer-blocking overlay. The Outline only lists and navigates, so it stays
 *  interactive, and Source handles its own Monaco read-only mode. */
const OVERLAY_LOCKED_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>(["topology", "run"]);

export function ViewContainer({ activeView, onChangeView, viewProps }: ViewContainerProps) {
  const kind = viewProps.viewData.manifest.kind;
  const visibleTabs = VIEW_TABS.filter((t) => isTabVisible(t, kind));
  // Module-wide rollup surfaced on the Source tab — the same dot + count the
  // sidebar shows per module, since Source is where you go to fix diagnostics.
  const diagState = useDiagnosticsState();
  const sourceSummary = summarizeFiles(diagState, getModuleFiles(viewProps.viewData.manifest));
  // If the active view is hidden (e.g. "run" while viewing a Library), render
  // nothing — Editor is expected to reset activeView when this happens, but we
  // guard here so a stale state doesn't crash the canvas.
  const renderedView = visibleTabs.some((t) => t.id === activeView) ? activeView : null;

  const { dockFillsPane } = useRun();
  const appPath = viewProps.run.appPath;
  // A maximized dock takes the whole pane; the view strip above it stays, so the
  // module — and the way back — never leave the screen. Whether it does is the
  // run context's answer, not this component's: the dock renders nothing when
  // the app has nothing to show, and hiding the views against a second reading
  // of "maximized" is what left the pane blank after a Clear.
  const dockMaximized = appPath !== null && dockFillsPane(appPath);
  const openRunTab = () => onChangeView("run");

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
        {appPath && (
          <>
            <div className="flex-1" />
            <RunBar
              appPath={appPath}
              runnerName={viewProps.run.runnerName}
              onRun={viewProps.run.onRun}
              onRunWatch={viewProps.run.onRunWatch}
              canWatch={viewProps.run.canWatch}
              onOpenSettings={viewProps.run.onOpenSettings}
            />
          </>
        )}
      </div>

      {/* Remote modules get their own banner above the view tabs (Editor), so
       *  only the agent lock is announced here. */}
      {viewProps.readOnlyReason === "agent" && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <Lock className="size-3 shrink-0" />
          Editing is paused while the agent is working.
        </div>
      )}

      <div className={`relative flex-1 overflow-hidden ${dockMaximized ? "hidden" : "flex"}`}>
        {renderedView === "topology" && <TopologyView {...viewProps} />}
        {renderedView === "outline" && <OutlineView {...viewProps} />}
        {renderedView === "source" && <SourceView {...viewProps} />}
        {renderedView === "run" && (
          <RunConfigView
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

      {appPath && <RunDock appPath={appPath} onOpenConfig={openRunTab} />}
    </div>
  );
}
