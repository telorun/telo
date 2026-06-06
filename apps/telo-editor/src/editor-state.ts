import { isWorkspaceModule } from "./loader";
import type { EditorState, Workspace } from "./model";

export const INITIAL_STATE: EditorState = {
  workspace: null,
  activeModulePath: null,
  openTabs: [],
  activeTabId: null,
  expandedDirs: [],
  activeView: "topology",
  graphContext: null,
  selectedResource: null,
  panelStack: [],
  diagnostics: {
    byResource: new Map(),
    byFile: new Map(),
    registryByFile: new Map(),
  },
  sourceRevealRequest: null,
  deploymentsByApp: {},
  viewportByModule: {},
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

/** The canvas focus a module lands on when opened — its overview graph, rooted
 *  at the synthesized `Telo.Application` / `Telo.Library` node. */
export function defaultGraphContext(
  workspace: Workspace | null,
  modulePath: string | null,
): { kind: string; name: string } | null {
  if (!workspace || !modulePath) return null;
  const module = workspace.modules.get(modulePath);
  if (!module) return null;
  const kind = module.kind === "Application" ? "Telo.Application" : "Telo.Library";
  return { kind, name: module.metadata.name };
}
