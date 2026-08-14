/** The selector half of a migration: what a rule MATCHES, as data.
 *
 *  A patch addresses a known location; a migration has to find *every*
 *  occurrence of a legacy spelling, so selection is the half a plain patch
 *  format has none of. It is declarative for the same reason the operations
 *  are: an entry travels to a Rust and a Go kernel, and a predicate expressed
 *  in one language would mean one artifact is read two ways — invisibly, since
 *  a migration that succeeds is silent.
 *
 *  **Containment is POSITIVE and required.** A rule states which document kinds
 *  it may touch (`inKind`) and which region of those documents it may reach
 *  into (`under`); nothing outside is reachable. The alternative — walk
 *  everything and subtract — cannot be made sound, because the set to subtract
 *  is unbounded: a `Run.Value` value, an `Assert.Equals` expected, any kind
 *  whose config carries a user JSON blob can hold something shaped like the
 *  node a rule looks for, and forgetting one corrupts a manifest with no
 *  diagnostic. A denylist also cannot express the guarantee the module surface
 *  is promised to carry — *a dependency can rename its own field and provably
 *  nothing else* — which is a statement about what a rule may reach, so it has
 *  to be said positively. `notUnder` remains for subtracting inside a region a
 *  rule legitimately reaches, which is a narrowing, not the containment itself.
 *
 *  **`under` is ANCHORED at the document root**, not a set of key names to look
 *  for anywhere on the path. Anchoring is what makes the containment claim
 *  true: a `Telo.Definition`'s `resources:` template body carries other kinds'
 *  configuration, and any of it may hold a key spelled `schema` over data that
 *  merely looks like a schema — so "some segment of the path is `schema`" would
 *  reach the very user JSON blob the positive form exists to keep out, and
 *  would delete from it silently. Anchored, `under` names top-level document
 *  keys and a region is a genuine subtree.
 *
 *  The vocabulary is closed, which is what makes it a trust boundary once
 *  module-shipped entries are aggregated beside core ones. An unrecognized key
 *  is refused rather than ignored — a selector that silently matches wider than
 *  it reads is the one failure this cannot tolerate. */

import type { MigrationPath } from "./types.js";

export interface MigrationMatch {
  /** The mapping key this rule rewrites. */
  readonly key: string;
  /** Document `kind:` values this rule may match in. Required and non-empty:
   *  a rule that does not say which documents it touches cannot be reasoned
   *  about, and is exactly the rule that reaches into a resource's config. */
  readonly inKind: readonly string[];
  /** The region of the document this rule may reach, named by TOP-LEVEL
   *  document keys: the matched node must be AT or BELOW one of them. Required
   *  and non-empty, for the same reason as `inKind`.
   *
   *  Anchored at the root rather than matched anywhere on the path — see the
   *  file header; an unanchored `under` reaches into a nested resource's own
   *  configuration and is not containment at all.
   *
   *  At-or-below rather than strictly-below so the vocabulary is complete — a
   *  rule that rewrites a top-level key names that key, instead of the region
   *  being unreachable and the grammar needing a second spelling for the
   *  document root. */
  readonly under: readonly string[];
  /** The value must deep-equal this. Mutually exclusive with `valueOneOf`. */
  readonly value?: unknown;
  /** The value must be one of these. Matching against the KNOWN legacy values
   *  rather than any value is what leaves an unrecognized one alone for the
   *  ordinary validator to report, instead of silently rewriting it. */
  readonly valueOneOf?: readonly unknown[];
  /** A key that must be present in the same mapping. The matched key is often
   *  stale only *because* of what sits beside it. */
  readonly withSibling?: string;
  /** Ancestor keys that disqualify a match inside the region `under` allows.
   *  The data-bearing JSON Schema keywords (`const`, `default`, `enum`,
   *  `examples`) hold values that may look like schemas. */
  readonly notUnder?: readonly string[];
}

export const MATCH_KEYS = [
  "key",
  "inKind",
  "under",
  "value",
  "valueOneOf",
  "withSibling",
  "notUnder",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON values — what `value` / `valueOneOf` compare
 *  with, so a match on `true` never also matches `"true"`.
 *
 *  Exported because the PATCHER asks the same question in the other direction:
 *  "is the value already what this would write". Both answers have to come from
 *  one rule, or a rule could match a spelling the patch then declares current. */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((k) => Object.hasOwn(b, k) && deepEquals(a[k], b[k]));
  }
  return false;
}

function requireStringList(describe: string, raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
    throw new Error(`${describe}: 'match.${key}' must be a non-empty sequence of strings`);
  }
  return value as string[];
}

/** Read a rule's `match` block, refusing anything the vocabulary does not
 *  define. `describe` names the entry and rule so a failure says which. */
export function readMigrationMatch(describe: string, raw: unknown): MigrationMatch {
  if (!isPlainObject(raw)) throw new Error(`${describe}: 'match' must be a mapping`);

  for (const key of Object.keys(raw)) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${describe}: 'match' has no key '${key}'. Known keys: ${MATCH_KEYS.join(", ")}.`,
      );
    }
  }
  if (typeof raw.key !== "string" || raw.key.length === 0) {
    throw new Error(`${describe}: 'match.key' must be a non-empty string`);
  }
  if (Object.hasOwn(raw, "value") && Object.hasOwn(raw, "valueOneOf")) {
    throw new Error(`${describe}: 'match' takes at most one of 'value' or 'valueOneOf'`);
  }
  if (Object.hasOwn(raw, "valueOneOf") && !Array.isArray(raw.valueOneOf)) {
    throw new Error(`${describe}: 'match.valueOneOf' must be a sequence`);
  }
  if (Object.hasOwn(raw, "withSibling") && typeof raw.withSibling !== "string") {
    throw new Error(`${describe}: 'match.withSibling' must be a string`);
  }
  if (
    Object.hasOwn(raw, "notUnder") &&
    (!Array.isArray(raw.notUnder) || raw.notUnder.some((k) => typeof k !== "string"))
  ) {
    throw new Error(`${describe}: 'match.notUnder' must be a sequence of strings`);
  }

  const match: {
    key: string;
    inKind: readonly string[];
    under: readonly string[];
    value?: unknown;
    valueOneOf?: readonly unknown[];
    withSibling?: string;
    notUnder?: readonly string[];
  } = {
    key: raw.key,
    inKind: requireStringList(describe, raw, "inKind"),
    under: requireStringList(describe, raw, "under"),
  };
  if (Object.hasOwn(raw, "value")) match.value = raw.value;
  if (Object.hasOwn(raw, "valueOneOf")) match.valueOneOf = raw.valueOneOf as unknown[];
  if (Object.hasOwn(raw, "withSibling")) match.withSibling = raw.withSibling as string;
  if (Object.hasOwn(raw, "notUnder")) match.notUnder = raw.notUnder as string[];
  return match;
}

/** One candidate site: a mapping entry whose key some rule is interested in. */
interface MatchSite {
  readonly path: MigrationPath;
  readonly value: unknown;
  readonly parent: Record<string, unknown>;
}

/** Every candidate site in one document, keyed by mapping key.
 *
 *  Built ONCE per document and shared by every rule that can apply to it,
 *  because the walk is the expensive part and it does not depend on the rule —
 *  this is on the kernel's boot path for every file in the graph, so a walk per
 *  rule would scale the cost of loading any manifest with the size of the
 *  migration set.
 *
 *  The walk is bounded by the same containment the rules declare: `roots` is
 *  the union of the applicable rules' `under`, so a region no rule can reach is
 *  never descended into and a document no rule can match is never walked at
 *  all. Only keys some rule asked for allocate a path array. */
export type MatchIndex = ReadonlyMap<string, readonly MatchSite[]>;

/**
 * Index `document`'s candidate sites for `keys`, descending only into the
 * top-level regions named by `roots`.
 *
 * The caller has already gated on `inKind` — see `selectMatches`, which repeats
 * the check because it holds the individual rule.
 */
export function buildMatchIndex(
  document: unknown,
  keys: ReadonlySet<string>,
  roots: ReadonlySet<string>,
): MatchIndex {
  const index = new Map<string, MatchSite[]>();
  if (keys.size === 0 || roots.size === 0 || !isPlainObject(document)) return index;

  // A mutable stack, materialized into an array only when a site is recorded.
  const stack: (string | number)[] = [];

  const record = (key: string, value: unknown, parent: Record<string, unknown>): void => {
    const bucket = index.get(key) ?? [];
    bucket.push({ path: [...stack], value, parent });
    index.set(key, bucket);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push(i);
        walk(node[i]);
        stack.pop();
      }
      return;
    }
    if (!isPlainObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      stack.push(key);
      if (keys.has(key)) record(key, value, node);
      walk(value);
      stack.pop();
    }
  };

  // Anchored containment, enforced by where the walk STARTS: everything the
  // index holds is at or below a top-level key some rule named.
  for (const [key, value] of Object.entries(document)) {
    if (!roots.has(key)) continue;
    stack.push(key);
    if (keys.has(key)) record(key, value, document);
    walk(value);
    stack.pop();
  }
  return index;
}

/** The rules in `entries` that may match a document of `kind`, with the key and
 *  root sets their shared index needs. Empty rules mean the document is not
 *  walked at all. */
export function applicableRules<T extends { readonly match: MigrationMatch }>(
  rules: Iterable<T>,
  kind: unknown,
): { rules: T[]; keys: Set<string>; roots: Set<string> } {
  const applicable: T[] = [];
  const keys = new Set<string>();
  const roots = new Set<string>();
  if (typeof kind !== "string") return { rules: applicable, keys, roots };
  for (const rule of rules) {
    if (!rule.match.inKind.includes(kind)) continue;
    applicable.push(rule);
    keys.add(rule.match.key);
    for (const root of rule.match.under) roots.add(root);
  }
  return { rules: applicable, keys, roots };
}

function valueMatches(match: MigrationMatch, value: unknown): boolean {
  if (Object.hasOwn(match, "value")) return deepEquals(match.value, value);
  if (match.valueOneOf) return match.valueOneOf.some((candidate) => deepEquals(candidate, value));
  return true;
}

/** The sites in `index` this match selects, in document order. */
export function selectMatches(
  index: MatchIndex,
  document: unknown,
  match: MigrationMatch,
): MigrationPath[] {
  const kind = isPlainObject(document) ? document.kind : undefined;
  if (typeof kind !== "string" || !match.inKind.includes(kind)) return [];

  const sites = index.get(match.key);
  if (!sites) return [];

  const out: MigrationPath[] = [];
  for (const site of sites) {
    // The index may be shared with rules naming other regions, so the anchor is
    // re-checked per rule. A numeric first segment cannot occur — a document is
    // a mapping — but the guard keeps the containment claim independent of that.
    const anchor = site.path[0];
    if (typeof anchor !== "string" || !match.under.includes(anchor)) continue;
    // `notUnder` subtracts within the region, so it reads the whole path. A
    // numeric segment never equals a key name, so the raw path is enough.
    if (match.notUnder?.some((segment) => site.path.includes(segment))) continue;
    if (!valueMatches(match, site.value)) continue;
    if (match.withSibling !== undefined && !Object.hasOwn(site.parent, match.withSibling)) continue;
    out.push(site.path);
  }
  return out;
}

/** Convenience for a single match against a document — builds a one-rule index.
 *  The driver uses `applicableRules` + `buildMatchIndex` + `selectMatches` so
 *  one walk serves every rule that can reach the document. */
export function findMatches(document: unknown, match: MigrationMatch): MigrationPath[] {
  const index = buildMatchIndex(document, new Set([match.key]), new Set(match.under));
  return selectMatches(index, document, match);
}
