import { isWorkspaceModule } from "./loader";
import type { EditorState, Workspace } from "./model";

export const INITIAL_STATE: EditorState = {
  workspace: null,
  activeModulePath: null,
  openTabs: [],
  activeTabId: null,
  expandedDirs: [],
  activeView: "topology",
  selectedResource: null,
  panelStack: [],
  diagnostics: {
    byResource: new Map(),
    byFile: new Map(),
    registryByFile: new Map(),
    graphByFile: new Map(),
    analysisByFile: new Map(),
    moduleGraphByFile: new Map(),
  },
  sourceRevealRequest: null,
  deploymentsByApp: {},
  viewportByModule: {},
  topologyByModule: {},
};

export function pickInitialActiveModule(workspace: Workspace): string | null {
  const entries = [...workspace.modules.entries()].filter(([path]) =>
    isWorkspaceModule(workspace, path),
  );
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const app = entries.find(([, m]) => m.kind === "Application");
  if (app) return app[0];
  const lib = entries.find(([, m]) => m.kind === "Library");
  if (lib) return lib[0];
  return null;
}
