import type { AnalysisRegistry } from "@telorun/analyzer";
import type {
  CanvasViewport,
  DeploymentEnvironment,
  ModuleDocument,
  ModuleViewData,
  PortMapping,
  RegistryServer,
  Selection,
  SourceRevealRequest,
} from "../../model";
import type { RefWrite } from "./topology/application-canvas-model";

/** Common props interface passed to every view. Views use what they need. */
export interface ViewProps {
  viewData: ModuleViewData;
  /** Analysis registry for the active module's closure — supplies the field
   *  maps / capability lookups the overview graph needs. Null before the first
   *  analysis pass completes for the module. */
  registry: AnalysisRegistry | null;
  selectedResource: { kind: string; name: string } | null;
  /** The "canvas focus" resource — last resource the user worked with in a canvas view. */
  graphContext: { kind: string; name: string } | null;
  onSelectResource: (kind: string, name: string) => void;
  onNavigateResource: (kind: string, name: string) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  /** Removes a resource from the active module (overview-canvas Delete key). */
  onDeleteResource: (kind: string, name: string) => void;
  /** Applies reference writes from the overview graph (drag-to-wire, edge
   *  deletion, picker selection) — set or clear a ref slot at a concrete path on
   *  any resource, the Application root's `targets` included. */
  onWriteRef: (writes: RefWrite[]) => void;
  /** Opens the create-resource flow. Surfaced as a canvas action. */
  onCreateResource: () => void;
  /** Registry servers — supplies the Imports view's add-import search and the
   *  upgrade dropdown's version lookups. */
  registryServers: RegistryServer[];
  /** Adds an import to the active module (Imports view). */
  onAddImport: (source: string, alias: string) => Promise<void>;
  /** Removes an import from the active module (Imports view). */
  onRemoveImport: (name: string) => void;
  /** Re-points an import at a new source/version (Imports view upgrade). */
  onUpgradeImport: (name: string, newSource: string) => Promise<void>;
  /** Re-points many imports in one persist cycle (Imports view "Upgrade all"). */
  onUpgradeAllImports: (updates: { name: string; newSource: string }[]) => Promise<void>;
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
    onSetPorts: (ports: PortMapping[]) => void;
  };
  /** When set, SourceView opens the given tab and reveals the range. The
   *  nonce lets repeated clicks on the same diagnostic re-fire the reveal
   *  effect; SourceView tracks the last-consumed nonce internally. */
  revealRequest: SourceRevealRequest | null;
  /** Saved overview-canvas viewport for the active module, or null to fit on
   *  first view. */
  canvasViewport: CanvasViewport | null;
  /** Persists the active module's overview-canvas viewport after pan/zoom. */
  onCanvasViewportChange: (viewport: CanvasViewport) => void;
}
