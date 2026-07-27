import type { AvailableKind } from "../model";

export interface KindGroup {
  key: string;
  /** The contract every kind in the group implements, or the import alias the
   *  kinds came from when they implement none. */
  label: string;
  contract: boolean;
  kinds: AvailableKind[];
}

/** Groups the resource picker by contract first, import alias otherwise.
 *
 *  The contract is the axis an author actually chooses along: with `Cache`,
 *  `CacheRedis` and `CacheMemory` imported, the question is never "which of
 *  these nine kinds" but "which backend of `Cache.Store`". Kinds implementing
 *  no contract have nothing to nest under, so they group by where they came
 *  from — the only other thing the author already knows about them. */
export function groupKinds(kinds: AvailableKind[]): KindGroup[] {
  const groups = new Map<string, KindGroup>();
  for (const kind of kinds) {
    const key = kind.contract ?? kind.alias;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: key, contract: kind.contract != null, kinds: [] };
      groups.set(key, group);
    }
    group.kinds.push(kind);
  }
  for (const group of groups.values()) {
    group.kinds.sort((a, b) => a.fullKind.localeCompare(b.fullKind));
  }
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/** The category chips to offer: whatever the reachable kinds declare, an open
 *  vocabulary derived from the data rather than a list held here.
 *
 *  Categories are authored DISPLAY LABELS, matched case-insensitively so `AI`
 *  and `ai` written by two modules don't become two chips; the first spelling
 *  seen wins. No slug rule is involved — a category never crosses an authorship
 *  boundary here, it only groups kinds already in one workspace. */
export function categoryLabels(kinds: AvailableKind[]): string[] {
  const seen = new Map<string, string>();
  for (const kind of kinds) {
    for (const label of kind.categories) {
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/** The kinds under one category chip, matched the same case-insensitive way the
 *  chips were built. An empty label means "no filter". */
export function filterByCategory(kinds: AvailableKind[], label: string | null): AvailableKind[] {
  if (!label) return kinds;
  const wanted = label.toLowerCase();
  return kinds.filter((kind) => kind.categories.some((c) => c.toLowerCase() === wanted));
}
