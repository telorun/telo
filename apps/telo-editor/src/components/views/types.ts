import type { ModuleViewData, ParsedManifest, Selection } from "../../model";

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
  /** Replace the active module's manifest wholesale (used by source editing). */
  onReplaceManifest: (manifest: ParsedManifest) => void;
}
