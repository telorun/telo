import type {
  DeploymentEnvironment,
  ModuleDocument,
  ModuleViewData,
  Selection,
} from "../../model";

/** Common props interface passed to every view. Views use what they need. */
export interface ViewProps {
  viewData: ModuleViewData;
  selectedResource: { kind: string; name: string } | null;
  /** The "canvas focus" resource — last resource the user worked with in a canvas view. */
  graphContext: { kind: string; name: string } | null;
  onSelectResource: (kind: string, name: string) => void;
  onNavigateResource: (kind: string, name: string) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelect: (selection: Selection) => void;
  onClearSelection: () => void;
  /** Commit a source-view edit for one specific file in the active module.
   *  The caller has already parsed `text` into a `ModuleDocument` (SourceView
   *  needs the parsed form to show error markers) — passing it through
   *  avoids a second parse in Editor. Per-file granularity is required for
   *  multi-file modules: edits to a partial must land on the partial, not
   *  the owner. */
  onSourceEdit: (filePath: string, moduleDoc: ModuleDocument) => void;
  /** Deployment config for the active Application. For Libraries this is still
   *  populated (with a fresh ephemeral environment) but the Deployment tab is
   *  hidden so it goes unused. */
  deployment: {
    activeEnvironment: DeploymentEnvironment;
    onSetEnvVars: (env: Record<string, string>) => void;
  };
}
