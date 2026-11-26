/**
 * Resources the reader has just deleted, kept off the canvas until the engine's
 * next view model catches up — which takes seconds, long enough for a deleted
 * box to sit there looking undeleted.
 */
export interface JustDeleted {
  kind: string;
  name: string;
  /** The document was seen without it — so seeing it again means an undo. */
  gone: boolean;
  /** The delete handler has returned. */
  settled: boolean;
}

export type JustDeletedSet = ReadonlyMap<string, JustDeleted>;

export interface DeletionWorld {
  /** Node ids of the latest view model. */
  graphIds: ReadonlySet<string>;
  /** Whether the module's document declares the resource now. */
  declared: (kind: string, name: string) => boolean;
}

/**
 * Drops each entry that has served its purpose: the model no longer holds the
 * node, the document holds the resource again after losing it (undo), or the
 * delete returned and the document still holds it (the delete did nothing).
 * Returns the same map when nothing changed.
 */
export function reconcileJustDeleted(held: JustDeletedSet, world: DeletionWorld): JustDeletedSet {
  let next: Map<string, JustDeleted> | null = null;
  const edit = () => (next ??= new Map(held));
  for (const [id, entry] of held) {
    if (!world.graphIds.has(id)) {
      edit().delete(id);
      continue;
    }
    const declared = world.declared(entry.kind, entry.name);
    if (declared && (entry.gone || entry.settled)) edit().delete(id);
    else if (!declared && !entry.gone) edit().set(id, { ...entry, gone: true });
  }
  return next ?? held;
}
