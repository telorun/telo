import type { AnalysisRegistry } from "@telorun/analyzer";
import type { ImportableLibrary } from "../../loader";
import type {
  DeploymentEnvironment,
  ModuleDocument,
  ModuleViewData,
  Selection,
  SourceRevealRequest,
} from "../../model";
import type { RefWrite } from "./topology/application-canvas-model";
import type { TopologyHostState } from "./topology/topology-view";

/** Common props interface passed to every view. Views use what they need. */
export interface ViewProps {
  /** True while the module cannot be edited — see `readOnlyReason` for why.
   *  Every edit surface renders read-only/blocked; agent writes are also
   *  rejected at the persist chokepoint, but the views must make it visible. */
  readOnly: boolean;
  /** Why editing is disabled: `"agent"` while the authoring agent holds the
   *  workspace (a turn is in flight), `"remote"` for a module opened from a
   *  registry/OCI source. Null when the module is editable. */
  readOnlyReason: "agent" | "remote" | null;
  viewData: ModuleViewData;
  /** Analysis registry for the active module's closure — supplies the field
   *  maps / capability lookups the overview graph needs. Null before the first
   *  analysis pass completes for the module. */
  registry: AnalysisRegistry | null;
  selectedResource: { kind: string; name: string } | null;
  /** Active pointer-scoped selection (e.g. an edge's inputs or a node's in/out
   *  type field). When set, a sub-part of a resource is focused — not the whole
   *  node — so the canvas drops the node-level highlight. */
  selection: Selection | null;
  onSelectResource: (kind: string, name: string) => void;
  /** Navigate the topology view to a resource — from another tab, which knows
   *  the name but not the route through the containment tree. Switches to the
   *  topology view and leaves the route for the host to resolve. */
  onNavigateResource: (kind: string, name: string) => void;
  /** Opens a module by its workspace key / resolved import path as the active
   *  module tab — e.g. clicking an import to view the imported library. A remote
   *  (non-workspace) module opens read-only. */
  onOpenModule: (filePath: string) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  /** Removes a resource from the active module (overview-canvas Delete key). */
  onDeleteResource: (kind: string, name: string) => void;
  /** Applies reference writes from the overview graph (drag-to-wire, edge
   *  deletion, picker selection) — set or clear a ref slot at a concrete path on
   *  any resource, the Application root's `targets` included. */
  onWriteRef: (writes: RefWrite[]) => void;
  /** Creates a resource of `createKind` and writes `buildFields(newName)` back
   *  to `target` in ONE workspace mutation — what a ref picker does when the
   *  slot's kind has no instance yet. Atomic because two mutations would race:
   *  the create re-renders the panel, resetting its pending edit, and the second
   *  persist would read a workspace snapshot taken before the first. */
  onCreateAndLink: (
    target: { kind: string; name: string },
    createKind: string,
    buildFields: (newName: string) => Record<string, unknown>,
  ) => void;
  /** Renames one mapping key inside a resource's fields, in place. Its own
   *  operation because a re-keyed entry cannot be expressed as a field diff
   *  without moving the entry and re-serializing its value. */
  onRenameField: (
    target: { kind: string; name: string },
    pointer: string,
    newKey: string,
  ) => void;
  /** Reorders one item of a sequence field in place. Its own operation for the
   *  same reason `onRenameField` is: a field diff is positional, so a reorder
   *  would rewrite every entry it passed over and strip what the author
   *  attached to the moved one. */
  onMoveField: (
    target: { kind: string; name: string },
    pointer: string,
    toIndex: number,
  ) => void;
  /** Moves one item of a sequence field into a DIFFERENT sequence of the same
   *  resource — a step dragged from one branch into another. `onMoveField`
   *  cannot express it: a reorder stays inside one sequence, which is the right
   *  scope for a reorder and the wrong one for a step changing branches. */
  onRelocateField: (
    target: { kind: string; name: string },
    pointer: string,
    toPointer: string,
    toIndex: number,
  ) => void;
  /** Removes one item of a sequence field. Same family as `onRenameField` and
   *  `onMoveField` — an in-place structural edit a field diff cannot express. */
  onRemoveField: (target: { kind: string; name: string }, pointer: string) => void;
  /** Opens the create-resource flow. Surfaced as a canvas action. */
  onCreateResource: () => void;
  /** Creates an empty resource of `kind` under a generated name and focuses it.
   *  The kind-first half of `onCreateResource`: where the surface already names
   *  the kind, the modal's only remaining question is a name it can derive. */
  onCreateResourceOfKind: (kind: string) => void;
  /** Telo hub base URL (from settings) — powers the Imports view's add-import
   *  module search and its version lookups (`/module/versions`), the editor's
   *  only version source: a browser cannot enumerate OCI tags itself. Undefined
   *  resolves to the public default. */
  hubUrl: string | undefined;
  /** Static manifest-cache base URL (from settings) — where the Imports view
   *  reads a candidate version's own `telo.yaml` to find out whether this telo
   *  can host it. Undefined resolves to the public default. */
  manifestCacheUrl: string | undefined;
  /** Adds an import to the active module (Imports view). */
  onAddImport: (source: string, alias: string) => Promise<void>;
  /** Workspace-local libraries the active module can import directly, offered
   *  as a side dropdown on the Imports view's "Add import" button. Empty when
   *  none are importable — the dropdown is then hidden. */
  importableLibraries: ImportableLibrary[];
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
  /** Moves a resource declared INLINE at `pointer` into its own document under
   *  `name`, leaving a reference behind. Its own operation, not a field write:
   *  it adds a document and rewrites a slot in ONE mutation, and a half-applied
   *  one is either a resource declared twice or a slot pointing at nothing. */
  onExtractInline: (
    host: { kind: string; name: string },
    pointer: string,
    name: string,
  ) => void;
  /** The inverse: folds the resource referenced at `pointer` back into that
   *  slot and removes its document. One mutation for the same reason, and
   *  refused — with its reason — when anything else still names the resource. */
  onInlineReference: (host: { kind: string; name: string }, pointer: string) => void;
  /** Deployment config for the active Application. For Libraries this is still
   *  populated (with a fresh ephemeral environment) but the Deployment tab is
   *  hidden so it goes unused. */
  deployment: {
    activeEnvironment: DeploymentEnvironment;
    onSetEnvVars: (env: Record<string, string>) => void;
  };
  /** When set, SourceView opens the given tab and reveals the range. The
   *  nonce lets repeated clicks on the same diagnostic re-fire the reveal
   *  effect; SourceView tracks the last-consumed nonce internally. */
  revealRequest: SourceRevealRequest | null;
  /** Where the user is in the active module's topology, which view they picked,
   *  and the per-view state + viewport the host persists on their behalf. Only
   *  the topology view reads it. */
  topology: TopologyHostState;
}
