import type { AnalysisDiagnostic } from "@telorun/analyzer";

export interface RegistryServer {
  id: string;
  url: string;
  label?: string;
  enabled: boolean;
}

export interface AppSettings {
  registryServers: RegistryServer[];
}

export interface AvailableKind {
  fullKind: string;
  alias: string;
  kindName: string;
  capability: string;
  topology?: string;
  schema: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  registryServers: [
    { id: "default", url: "https://registry.telo.run", label: "Official Registry", enabled: true },
  ],
};

export interface ParsedManifest {
  filePath: string;
  metadata: { name: string; version?: string; description?: string };
  targets: string[];
  imports: ParsedImport[];
  resources: ParsedResource[];
  include?: string[];
}

export type ImportKind = "submodule" | "remote" | "external";

export interface ParsedImport {
  name: string; // metadata.name (alias)
  source: string; // raw source field
  importKind: ImportKind;
  resolvedPath?: string; // absolute path, populated for submodule imports
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

export interface ParsedResource {
  kind: string;
  name: string;
  module?: string;
  fields: Record<string, unknown>;
  sourceFile?: string;
}

export interface Application {
  rootPath: string;
  modules: Map<string, ParsedManifest>; // keyed by absolute filePath
  importGraph: Map<string, Set<string>>; // filePath → submodule filePaths
  importedBy: Map<string, Set<string>>; // reverse index
}

export interface EditorState {
  application: Application | null;
  activeModulePath: string | null;
  navigationStack: NavigationEntry[];
  selectedResource: { kind: string; name: string } | null;
  panelStack: PanelEntry[];
  diagnosticsByResource: Map<string, Map<string, AnalysisDiagnostic[]>>;
}

export type NavigationEntry =
  | { type: "module"; filePath: string; graphContext: { kind: string; name: string } | null }
  | { type: "scope"; resource: { kind: string; name: string }; fieldPath: string[] };

export type PanelEntry =
  | { type: "resource"; kind: string; name: string }
  | { type: "item"; fieldPath: string[]; label: string };

export interface Selection {
  resource: { kind: string; name: string };
  /** JSON pointer into the resource fields, e.g. "/steps/0" or "/entries/2/handler" */
  pointer: string;
  schema: Record<string, unknown>;
}
