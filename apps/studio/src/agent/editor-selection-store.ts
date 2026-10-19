import { sameSelection, type EditorSelection } from "./editor-selection";

/**
 * The live editor selection, held outside React state. An editor reports on
 * every change of its selection — each step of a drag — and a state change in
 * the agent provider re-renders every consumer of the agent context, the
 * editor itself included; only a subscriber (the composer's chip) re-renders
 * here.
 */
export interface EditorSelectionStore {
  current(): EditorSelection | null;
  /** `source` names the editor, so one editor's empty selection does not drop
   *  another's. */
  set(source: string, selection: EditorSelection | null): void;
  drop(): void;
  subscribe(listener: () => void): () => void;
}

export function createEditorSelectionStore(): EditorSelectionStore {
  let held: { source: string; selection: EditorSelection } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    current: () => held?.selection ?? null,
    set(source, selection) {
      const unchanged =
        selection === null
          ? held?.source !== source
          : held?.source === source && sameSelection(held.selection, selection);
      if (unchanged) return;
      held = selection === null ? null : { source, selection };
      notify();
    },
    drop() {
      if (held === null) return;
      held = null;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
