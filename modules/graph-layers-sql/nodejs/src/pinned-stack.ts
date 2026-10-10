/**
 * A pinned stack, as arithmetic over lists: no statement is issued here.
 *
 * A layer's BASE LIST is its direct pins in position order, each a layer at one
 * of its revisions. Its STACK is each pin in that order followed by that pin's
 * own stack at the pinned revision; a layer reached more than once has one
 * place, the lowest of them, so every layer outranks the layers it is built on.
 * Layers are internal ids throughout.
 */

/** One layer read at one of its revisions. */
export interface Pin {
  readonly layer: string;
  readonly revision: bigint;
}

export type ComposedStack =
  | { readonly stack: readonly Pin[] }
  /** One layer reached at two revisions. */
  | { readonly conflict: { readonly layer: string; readonly revisions: readonly bigint[] } };

/**
 * The stack made of each pin followed by what lies beneath it, in order.
 * `parts[i]` is the i-th direct pin and then its own stack.
 */
export function composeStack(parts: readonly (readonly Pin[])[]): ComposedStack {
  const reached = parts.flat();
  const revisions = new Map<string, bigint>();
  for (const pin of reached) {
    const seen = revisions.get(pin.layer);
    if (seen !== undefined && seen !== pin.revision) {
      const [lower, higher] = seen < pin.revision ? [seen, pin.revision] : [pin.revision, seen];
      return { conflict: { layer: pin.layer, revisions: [lower, higher] } };
    }
    revisions.set(pin.layer, pin.revision);
  }
  const last = new Map<string, number>();
  reached.forEach((pin, index) => last.set(pin.layer, index));
  return { stack: reached.filter((pin, index) => last.get(pin.layer) === index) };
}

export function sameBaseList(a: readonly Pin[], b: readonly Pin[]): boolean {
  return (
    a.length === b.length &&
    a.every((pin, index) => pin.layer === b[index].layer && pin.revision === b[index].revision)
  );
}

/** One pin to set: `position` omitted keeps an already-pinned layer's place
 *  and appends a new one. */
export interface PinMove extends Pin {
  readonly position?: number;
}

/** A base list with several pins set, applied in order as one move. */
export function placePins(current: readonly Pin[], moves: readonly PinMove[]): Pin[] {
  const list = current.map((pin) => ({ layer: pin.layer, revision: pin.revision }));
  for (const move of moves) {
    const pin = { layer: move.layer, revision: move.revision };
    const index = list.findIndex((each) => each.layer === move.layer);
    if (move.position === undefined) {
      if (index >= 0) list[index] = pin;
      else list.push(pin);
      continue;
    }
    if (index >= 0) list.splice(index, 1);
    list.splice(Math.min(move.position, list.length), 0, pin);
  }
  return list;
}

/**
 * A draft's own changes to its base list, re-applied onto the list the layer
 * has now. `parent` is the list the draft began from, `draft` the draft's and
 * `head` the layer's current one.
 *
 * An entry the draft pinned, unpinned or moved to another revision stands as
 * the draft has it; every other entry is the head's. Positions follow the
 * head, except that a layer the draft added keeps the draft's place — and all
 * of the draft's places stand when the draft reordered the layers it kept.
 */
export function mergeBaseLists(
  parent: readonly Pin[],
  draft: readonly Pin[],
  head: readonly Pin[],
): Pin[] {
  const index = (list: readonly Pin[]) => new Map(list.map((pin, at) => [pin.layer, at]));
  const [inParent, inDraft, inHead] = [index(parent), index(draft), index(head)];
  const changedByDraft = (layer: string): boolean => {
    const before = inParent.get(layer);
    const now = inDraft.get(layer);
    if (before === undefined || now === undefined) return before !== now;
    return parent[before].revision !== draft[now].revision;
  };
  const kept = (list: readonly Pin[], other: ReadonlyMap<string, number>) =>
    list.filter((pin) => other.has(pin.layer)).map((pin) => pin.layer);
  const reordered = kept(parent, inDraft).join("\n") !== kept(draft, inParent).join("\n");

  const placed: { pin: Pin; position: number; fromDraft: boolean; atDraft?: number }[] = [];
  for (const layer of new Set([...draft, ...head].map((pin) => pin.layer))) {
    const [atDraft, atHead] = [inDraft.get(layer), inHead.get(layer)];
    let pin: Pin | undefined;
    if (changedByDraft(layer)) pin = atDraft === undefined ? undefined : draft[atDraft];
    else pin = atHead === undefined ? undefined : head[atHead];
    if (!pin) continue;
    const draftPlaces = atDraft !== undefined && (reordered || !inParent.has(layer) || atHead === undefined);
    placed.push({
      pin,
      position: draftPlaces ? atDraft! : atHead!,
      fromDraft: draftPlaces,
      ...(atDraft === undefined ? {} : { atDraft }),
    });
  }
  // Two entries claiming one position stand as the draft ordered them when it
  // holds both, and otherwise the draft's own comes first.
  placed.sort(
    (a, b) =>
      a.position - b.position ||
      (a.atDraft !== undefined && b.atDraft !== undefined
        ? a.atDraft - b.atDraft
        : Number(b.fromDraft) - Number(a.fromDraft)),
  );
  return placed.map((each) => each.pin);
}
