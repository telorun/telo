import type { ManifestSource } from "@telorun/analyzer";
import {
  addImportViaAst,
  classifyImport,
  createRegistryAdapters,
  noopAdapter,
  removeImportViaAst,
  upgradeImportViaAst,
} from "../loader";
import type { AppSettings, EditorState, Workspace } from "../model";

export interface ImportOps {
  handleAddImport(source: string, alias: string): Promise<void>;
  handleRemoveImport(name: string): Promise<void>;
  handleUpgradeImport(name: string, newSource: string): Promise<void>;
  handleUpgradeAllImports(updates: { name: string; newSource: string }[]): Promise<void>;
}

export interface UseImportOpsParams {
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  settings: AppSettings;
  manifestAdapterRef: React.RefObject<ManifestSource | null>;
  /** Persists the mutated module to disk and returns the workspace to commit. */
  persistModule: (workspace: Workspace, filePath: string) => Promise<Workspace>;
}

/** The import-authoring handlers for the active module — add, remove, upgrade
 *  one, upgrade many. Each shares the same scaffold: guard on an open module,
 *  run an AST mutation, persist, and commit the resulting workspace. */
export function useImportOps({
  state,
  setState,
  settings,
  manifestAdapterRef,
  persistModule,
}: UseImportOpsParams): ImportOps {
  // Runs `mutate` against the active module, persists the result, and commits
  // it. A no-op when no module is active. The mutation receives the manifest
  // adapter and the registry adapters so it can resolve newly-referenced
  // imports against the configured registries.
  async function applyToActiveModule(
    mutate: (
      workspace: Workspace,
      modulePath: string,
      manifestAdapter: ManifestSource,
      registryAdapters: ManifestSource[],
    ) => Promise<Workspace>,
  ): Promise<void> {
    if (!state.workspace || !state.activeModulePath) return;
    const modulePath = state.activeModulePath;
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await mutate(
      state.workspace,
      modulePath,
      adapter,
      createRegistryAdapters(settings),
    );
    const persisted = await persistModule(updated, modulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  async function handleAddImport(source: string, alias: string) {
    await applyToActiveModule((ws, path, adapter, registry) =>
      addImportViaAst(
        ws,
        path,
        { name: alias, source, importKind: classifyImport(source) },
        adapter,
        registry,
      ),
    );
  }

  async function handleRemoveImport(name: string) {
    await applyToActiveModule((ws, path, adapter, registry) =>
      removeImportViaAst(ws, path, name, adapter, registry),
    );
  }

  async function handleUpgradeImport(name: string, newSource: string) {
    await applyToActiveModule((ws, path, adapter, registry) =>
      upgradeImportViaAst(ws, path, name, newSource, adapter, registry),
    );
  }

  async function handleUpgradeAllImports(updates: { name: string; newSource: string }[]) {
    if (updates.length === 0) return;
    await applyToActiveModule(async (ws, path, adapter, registry) => {
      let workspace = ws;
      for (const { name, newSource } of updates) {
        workspace = await upgradeImportViaAst(workspace, path, name, newSource, adapter, registry);
      }
      return workspace;
    });
  }

  return { handleAddImport, handleRemoveImport, handleUpgradeImport, handleUpgradeAllImports };
}
