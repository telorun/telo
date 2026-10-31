/**
 * Where a REGION of a declaration of the union stands at one witness — the
 * unit a relation site's key is normalized in, never its whole declaration.
 *
 * A region is named by its root: union keys (each choice transparent) or the
 * keys it is projected at. Locating it walks only the way to it: the options
 * taken on that way (what its existence rests on), the earlier list items
 * deciding its projected index, where it is written, and the `kind` of every
 * object on the way (what an inline declaration above it is judged by).
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { relocatePath } from "./choice-expansion.js";
import {
  isAlternatives,
  takenAt,
  type AlternativeOption,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type PlaceMapping,
  type Witness,
} from "./conditioned-expansion.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { isAtOrAbove } from "./relation-sites.js";
import { scopeMemberOf } from "./scope-members.js";
import { parseKeys, pathText } from "./template-expansion.js";

type Keys = readonly (string | number)[];

/** A region root of a declaration at one witness. */
export interface UnionPlace {
  /** Whether the root is there at the witness. */
  readonly present: boolean;
  /** The union node at the root, every choice on the way settled. */
  readonly node: unknown;
  readonly unionKeys: Keys;
  /** Its projected keys. */
  readonly at: Keys;
  /** Where it is written in the holder document. */
  readonly written: Keys;
  /** The options taken on the way, innermost last. */
  readonly options: readonly AlternativeOption[];
  /** The conjunction of their conditions: where the root exists. */
  readonly path: Condition;
  /** The conditions of the earlier list items deciding its projected index. */
  readonly position: Condition;
  /** The identity of every declaration on the way — the declaration itself at
   *  depth 0, an inline one or a scope member beneath — the root's own
   *  included, by depth: what it is normalized and judged as. */
  readonly identities: ReadonlyMap<number, { readonly kind: unknown; readonly metadata: unknown }>;
  /** What each object on the way holds beside the way, by depth, each member
   *  shallow ({@link shallowMember}): what a union branch on the way is
   *  selected by. */
  readonly enclosing: ReadonlyMap<number, Record<string, unknown>>;
}

/**
 * What a CARVED place holds in a region: a place another site or instance
 * judges, beneath a region a key reads. It carries no content and no presence
 * — it stands at the place's union position whatever the witness takes there —
 * so what the key needs of the place enters only as a declared read.
 */
export const CARVED_PLACE = "$site";

/** A member as an enclosing object shows it: a scalar itself, an object or an
 *  expression an empty object, a list an empty list — its kind and, for a
 *  scalar, its value, which is all a union branch is selected by. */
export function shallowMember(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (value !== null && typeof value === "object") return {};
  return value;
}

/** The option of a choice the witness takes there. */
export function optionAt(union: ConditionedExpansion, value: unknown, witness: Witness): AlternativeOption | undefined {
  if (!isAlternatives(value)) return undefined;
  return value.options.find((option) =>
    takenAt(union.space, option.condition, option.path, witness.assignment, witness.forcing),
  );
}

/** The projected `kind` and `metadata` of an object of the union holding a
 *  `kind`. */
function identityOf(
  union: ConditionedExpansion,
  value: unknown,
  witness: Witness,
): { kind: unknown; metadata: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === undefined) return undefined;
  const project = (field: unknown) => union.project(field, witness.assignment, witness.forcing).value;
  return { kind: project(record.kind), metadata: record.metadata === undefined ? undefined : project(record.metadata) };
}

/**
 * Walk to a region root, by union keys (`byUnion`) or by projected keys. The
 * last key's node is left as the union holds it beneath the choices settled
 * on the way.
 */
function walkTo(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  keys: Keys,
  witness: Witness,
  byUnion: boolean,
): UnionPlace {
  const { space } = union;
  let node: unknown = declaration.manifest;
  let written: Keys = declaration.at;
  // Beneath an exact option every place is written at the option itself.
  let exact = false;
  let path = declaration.condition;
  let position = TRUE;
  const options: AlternativeOption[] = [];
  const unionKeys: (string | number)[] = [];
  const at: (string | number)[] = [];
  const identities = new Map<number, { kind: unknown; metadata: unknown }>();
  const enclosing = new Map<number, Record<string, unknown>>();
  const absent = (): UnionPlace => ({
    present: false,
    node: undefined,
    unionKeys,
    at,
    written,
    options,
    path,
    position,
    identities,
    enclosing,
  });
  /** The members of the object at `node` beside `key`, each settled at the
   *  witness and shallow. */
  const besideTheWay = (key: string | number): Record<string, unknown> => {
    const members: Record<string, unknown> = {};
    for (const [member, field] of Object.entries(node as Record<string, unknown>)) {
      if (member === String(key)) continue;
      let value = field;
      let present = true;
      while (isAlternatives(value)) {
        const option = optionAt(union, value, witness);
        if (!option?.present) {
          present = false;
          break;
        }
        value = option.value;
      }
      if (present) members[member] = shallowMember(value);
    }
    return members;
  };
  /** Settle the choices at `node`; false where the place is not there. */
  const settle = (): boolean => {
    while (isAlternatives(node)) {
      const option = optionAt(union, node, witness);
      if (!option) return false;
      options.push(option);
      path = space.and(path, option.condition);
      if (!option.present) return false;
      if (!exact) written = option.at;
      if (option.exact) exact = true;
      node = option.value;
    }
    return true;
  };
  for (const key of keys) {
    if (!settle()) return absent();
    const identity = identityOf(union, node, witness);
    if (identity) identities.set(at.length, identity);
    if (node !== null && typeof node === "object" && !Array.isArray(node)) enclosing.set(at.length, besideTheWay(key));
    if (Array.isArray(node) && typeof key === "number") {
      let index: number | undefined;
      let projected = 0;
      if (byUnion) {
        index = key;
        for (let i = 0; i < key; i++) {
          let item: unknown = node[i];
          let present = true;
          while (isAlternatives(item)) {
            const option = optionAt(union, item, witness);
            position = space.and(position, option?.condition ?? FALSE);
            present = !!option?.present;
            if (!present) break;
            item = option!.value;
          }
          if (present) projected++;
        }
      } else {
        for (let i = 0; i < node.length; i++) {
          let item: unknown = node[i];
          let present = true;
          let held = TRUE;
          while (isAlternatives(item)) {
            const option = optionAt(union, item, witness);
            held = space.and(held, option?.condition ?? FALSE);
            present = !!option?.present;
            if (!present) break;
            item = option!.value;
          }
          if (projected === key && present) {
            index = i;
            break;
          }
          position = space.and(position, held);
          if (present) projected++;
        }
        if (index === undefined) return absent();
      }
      if (index >= node.length) return absent();
      unionKeys.push(index);
      at.push(byUnion ? projected : key);
      if (!exact) written = [...written, index];
      node = node[index];
      continue;
    }
    if (node === null || typeof node !== "object" || Array.isArray(node)) return absent();
    const next = (node as Record<string, unknown>)[key as string];
    if (next === undefined) return absent();
    unionKeys.push(key);
    at.push(key);
    if (!exact) written = [...written, key];
    node = next;
  }
  if (!settle()) return absent();
  const identity = identityOf(union, node, witness);
  if (identity) identities.set(at.length, identity);
  return { present: true, node, unionKeys, at, written, options, path, position, identities, enclosing };
}

/**
 * The scope fields declared on the way to a region root — the declaration's
 * own, and each declaration's on the way down to the root itself — by
 * projected keys: whose members normalizing the region reads beside it, since
 * an inline declaration extraction draws out joins its holder's scope and a
 * `!ref` in a scope's region names the scope's members first.
 */
export function scopePlacesOf(
  place: Pick<UnionPlace, "at" | "identities">,
  scopeFields: (holder: { readonly kind: unknown; readonly metadata: unknown }) => readonly string[],
): Keys[] {
  const out: Keys[] = [];
  for (let depth = 0; depth <= place.at.length; depth++) {
    const holder = place.identities.get(depth);
    if (!holder) continue;
    for (const field of scopeFields(holder)) out.push([...place.at.slice(0, depth), field]);
  }
  return out;
}

/**
 * The members of the scopes declared on the way to the region roots `roots`
 * that a region holds as their identities: each member present at the witness
 * that no root is at, above or beneath — a member on the way to a root is held
 * as the way, one a root lies in as that root holds it. A scope a root holds is
 * that root's.
 */
export function scopeMemberPlaces(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  roots: readonly Pick<UnionPlace, "at" | "identities">[],
  witness: Witness,
  scopeFields: (holder: { readonly kind: unknown; readonly metadata: unknown }) => readonly string[],
): UnionPlace[] {
  const out: UnionPlace[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const keys of scopePlacesOf(root, scopeFields)) {
      if (roots.some((other) => isAtOrAbove(other.at, keys))) continue;
      const scope = placeByProjectedKeys(union, declaration, keys, witness);
      if (!scope.present || !Array.isArray(scope.node)) continue;
      for (let i = 0; i < scope.node.length; i++) {
        const member = placeByUnionKeys(union, declaration, [...scope.unionKeys, i], witness);
        if (!member.present) continue;
        if (roots.some((other) => isAtOrAbove(member.at, other.at) || isAtOrAbove(other.at, member.at))) continue;
        const text = JSON.stringify(member.unionKeys);
        if (seen.has(text)) continue;
        seen.add(text);
        out.push(member);
      }
    }
  }
  return out;
}

/** What a region holds of a scope member it holds as its identity: its
 *  `kind` and `metadata` as the witness projects them, with where each of
 *  their positions is written. */
export function memberIdentity(
  union: ConditionedExpansion,
  member: UnionPlace,
  witness: Witness,
): { readonly value: Record<string, unknown>; readonly mappings: PlaceMapping[] } {
  const value: Record<string, unknown> = {};
  const mappings: PlaceMapping[] = [];
  const node = member.node as Record<string, unknown> | null;
  for (const field of ["kind", "metadata"]) {
    const written = node && typeof node === "object" ? node[field] : undefined;
    if (written === undefined) continue;
    const projected = union.project(written, witness.assignment, witness.forcing);
    if (!projected.present) continue;
    value[field] = projected.value;
    mappings.push(...projected.places.mappings.map((m) => ({ ...m, from: [field, ...m.from] })));
  }
  return { value, mappings };
}

/** The region whose root is at `unionKeys` of `declaration`, at `witness`. */
export function placeByUnionKeys(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  unionKeys: Keys,
  witness: Witness,
): UnionPlace {
  return walkTo(union, declaration, unionKeys, witness, true);
}

/** The region whose root is projected at `keys` of `declaration`, at `witness`. */
export function placeByProjectedKeys(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  keys: Keys,
  witness: Witness,
): UnionPlace {
  return walkTo(union, declaration, keys, witness, false);
}

/** The regions no other region holds: one beneath another, or written twice,
 *  is the other's. */
function heldRegions<T extends { readonly place: Pick<UnionPlace, "at"> }>(regions: readonly T[]): T[] {
  return regions.filter(
    (region, i) =>
      !regions.some(
        (other, j) =>
          j !== i &&
          isAtOrAbove(other.place.at, region.place.at) &&
          (other.place.at.length < region.place.at.length || j < i),
      ),
  );
}

/**
 * A manifest holding only some regions: the declaration's `kind` and
 * `metadata`, the way to each region's root (each declaration on it keeping
 * its `kind` and `metadata`, a list holding a region at its projected index
 * alone) and each region's content. A region beneath another is held by it.
 */
export function regionSkeleton(
  identity: { kind: unknown; metadata: unknown },
  regions: readonly {
    readonly place: Pick<UnionPlace, "at" | "identities"> & { readonly enclosing?: UnionPlace["enclosing"] };
    readonly content: unknown;
  }[],
): ResourceManifest {
  const whole = regions.find((region) => region.place.at.length === 0);
  if (whole) return whole.content as ResourceManifest;
  const root: Record<string, unknown> = { kind: identity.kind, metadata: identity.metadata };
  const beside = (holder: Record<string | number, unknown>, members: Record<string, unknown> | undefined) => {
    for (const [member, value] of Object.entries(members ?? {})) if (!(member in holder)) holder[member] = value;
  };
  for (const { place, content } of heldRegions(regions)) {
    let holder: Record<string | number, unknown> = root;
    beside(root, place.enclosing?.get(0));
    place.at.forEach((key, depth) => {
      if (depth === place.at.length - 1) {
        holder[key as string] = content;
        return;
      }
      const nextKey = place.at[depth + 1]!;
      let next = holder[key as string] as Record<string | number, unknown> | undefined;
      if (next === undefined || next === null || typeof next !== "object" || isEmptyPlaceholder(next)) {
        next = typeof nextKey === "number" ? ([] as unknown as Record<number, unknown>) : {};
        const declared = place.identities.get(depth + 1);
        if (declared && typeof nextKey !== "number") {
          next.kind = declared.kind;
          if (declared.metadata !== undefined) next.metadata = declared.metadata;
        }
        holder[key as string] = next;
      }
      if (typeof nextKey !== "number") beside(next, place.enclosing?.get(depth + 1));
      holder = next;
    });
  }
  return root as ResourceManifest;
}

/** A shallow member standing for an object or list of the way. */
function isEmptyPlaceholder(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/** The mappings moving the projected positions of some regions to where they
 *  are written: their declaration's root mapping, each region's own root, and
 *  those inside each. */
export function regionMappings(
  declarationRoot: readonly PlaceMapping[],
  regions: readonly {
    readonly place: Pick<UnionPlace, "at" | "written"> & { readonly options?: readonly AlternativeOption[] };
    readonly inner: readonly PlaceMapping[];
  }[],
): PlaceMapping[] {
  const whole = regions.find((region) => region.place.at.length === 0);
  if (whole) return [...declarationRoot, ...whole.inner];
  const out: PlaceMapping[] = [...declarationRoot];
  for (const { place, inner } of heldRegions(regions)) {
    // A region inside a value written in another declaration is written at
    // that value itself, whatever it holds.
    if (place.options?.some((option) => option.exact)) {
      out.push({ from: place.at, to: place.written, exact: true });
      continue;
    }
    out.push({ from: place.at, to: place.written }, ...inner.map((m) => ({ ...m, from: [...place.at, ...m.from] })));
  }
  return out;
}

/** The value at `keys` beneath `root`. */
export function valueAtKeys(root: unknown, keys: Keys): unknown {
  let node = root;
  for (const key of keys) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key as string];
  }
  return node;
}

/** Every concrete place at or beneath `keys` of `value`. */
function placesBeneath(value: unknown, keys: Keys, into: Keys[]): void {
  into.push(keys);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => placesBeneath(item, [...keys, i], into));
    return;
  }
  for (const [key, field] of Object.entries(value)) placesBeneath(field, [...keys, key], into);
}

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint"
      ? { $bigint: v.toString() }
      : v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
        : v,
  );

/** The names of the declarations extraction drew out of the region at `at`:
 *  those written beneath it, and what extraction drew out of those. */
function extractedWithin(manifests: readonly ResourceManifest[], at: Keys): Map<string, string> {
  const out = new Map<string, string>();
  const parents = new Set<string>();
  let grown = true;
  const origins = manifests.slice(1).map((m) => ({
    m,
    origin: (m.metadata as { xTeloOrigin?: { parentName?: string; pathFromParent?: string; keysFromParent?: Keys } })
      ?.xTeloOrigin,
  }));
  const rootName = manifests[0]?.metadata?.name;
  while (grown) {
    grown = false;
    for (const { m, origin } of origins) {
      const name = m.metadata?.name as string;
      if (!origin || out.has(name)) continue;
      const keys = origin.keysFromParent ?? parseKeys(origin.pathFromParent ?? "");
      const under = origin.parentName === rootName ? isAtOrAbove(at, keys) : parents.has(origin.parentName ?? "");
      if (!under) continue;
      out.set(name, stableJson(m));
      parents.add(name);
      grown = true;
    }
  }
  return out;
}

/**
 * Where a region normalized on its own differs from its declaration
 * normalized whole, restricted to the region: the content at its root (stamps
 * included), the declarations extraction drew out of it, where each of its
 * positions is written, and the members of the scopes declared on the way
 * beside it, by identity. Empty when they agree.
 */
export function regionParity(
  whole: { readonly manifests: readonly ResourceManifest[]; readonly mappings: readonly PlaceMapping[] },
  region: { readonly manifests: readonly ResourceManifest[]; readonly mappings: readonly PlaceMapping[] },
  at: Keys,
): string[] {
  const out: string[] = [];
  const at0 = pathText(at);
  const wholeValue = valueAtKeys(whole.manifests[0], at);
  const regionValue = valueAtKeys(region.manifests[0], at);
  if (stableJson(wholeValue) !== stableJson(regionValue)) out.push(`content at '${at0}'`);
  const wholeExtracted = extractedWithin(whole.manifests, at);
  const regionExtracted = extractedWithin(region.manifests, at);
  for (const [name, content] of wholeExtracted) {
    if (regionExtracted.get(name) !== content) out.push(`extracted '${name}' under '${at0}'`);
  }
  for (const name of regionExtracted.keys()) {
    if (!wholeExtracted.has(name)) out.push(`extracted '${name}' under '${at0}' only in the region`);
  }
  const places: Keys[] = [];
  placesBeneath(wholeValue, at, places);
  for (const keys of places) {
    const path = pathText(keys);
    const a = relocatePath(path, whole.mappings);
    const b = relocatePath(path, region.mappings);
    if (a !== b) out.push(`place '${path}' written at '${a}', the region says '${b}'`);
  }
  // The members of the scopes declared on the way, beside it: by identity.
  const wholeMembers = membersBeside(whole.manifests, at);
  const regionMembers = membersBeside(region.manifests, at);
  for (const [place, identity] of wholeMembers) {
    const held = regionMembers.get(place);
    if (held === undefined) out.push(`scope member at '${place}' beside '${at0}' only in the whole`);
    else if (held !== identity) out.push(`scope member at '${place}' beside '${at0}' differs in identity`);
  }
  for (const place of regionMembers.keys()) {
    if (!wholeMembers.has(place)) out.push(`scope member at '${place}' beside '${at0}' only in the region`);
  }
  return out;
}

/** The members of the scopes declared on the way to `at` that are neither on
 *  the way nor beneath it, each by its place: its `kind` and `metadata`, the
 *  analysis's token for it aside. */
function membersBeside(manifests: readonly ResourceManifest[], at: Keys): Map<string, string> {
  const out = new Map<string, string>();
  for (const [manifest, position] of positionsOf(manifests)) {
    const member = scopeMemberOf(manifest);
    if (!member) continue;
    const holder = position.slice(0, position.length - member.scope.keys.length - 1);
    if (!isAtOrAbove(holder, at) || isAtOrAbove(position, at) || isAtOrAbove(at, position)) continue;
    const metadata: Record<string, unknown> = { ...(manifest.metadata ?? {}) };
    delete metadata.source;
    out.set(pathText(position), stableJson({ kind: manifest.kind, metadata }));
  }
  return out;
}

/**
 * Where each manifest a normalization produced stands in the declaration it
 * was produced from, by projected keys: the declaration's own at the root,
 * what extraction drew out at its place in its parent — even where it joined a
 * scope beside its parent — and a scope member at its place in its holder's
 * scope. A manifest whose place cannot be traced is
 * left out.
 */
export function positionsOf(manifests: readonly ResourceManifest[]): Map<ResourceManifest, Keys> {
  const out = new Map<ResourceManifest, Keys>();
  if (manifests.length === 0) return out;
  out.set(manifests[0]!, []);
  let grown = true;
  while (grown) {
    grown = false;
    for (const m of manifests) {
      if (out.has(m)) continue;
      const origin = (m.metadata as { xTeloOrigin?: { parentKind?: string; parentName?: string; pathFromParent?: string; keysFromParent?: Keys } })
        ?.xTeloOrigin;
      if (origin) {
        const parent = manifests.find((p) => out.has(p) && p.metadata?.name === origin.parentName && p.kind === origin.parentKind);
        if (!parent) continue;
        out.set(m, [...out.get(parent)!, ...(origin.keysFromParent ?? parseKeys(origin.pathFromParent ?? ""))]);
        grown = true;
        continue;
      }
      const member = scopeMemberOf(m);
      if (!member) continue;
      const holder = out.get(member.holder);
      if (!holder) continue;
      out.set(m, [...holder, ...member.scope.keys, member.scope.declarations.indexOf(member.declaration)]);
      grown = true;
    }
  }
  return out;
}

/** The manifest of a normalization holding the place at `keys` of its
 *  declaration — the deepest standing at or above it — and the place's keys in
 *  it. */
export function manifestHolding(
  positions: ReadonlyMap<ResourceManifest, Keys>,
  keys: Keys,
): { manifest: ResourceManifest; keys: Keys } | undefined {
  let best: { manifest: ResourceManifest; keys: Keys } | undefined;
  let depth = -1;
  for (const [manifest, at] of positions) {
    if (!isAtOrAbove(at, keys) || at.length <= depth) continue;
    depth = at.length;
    best = { manifest, keys: keys.slice(at.length) };
  }
  return best;
}

/**
 * A value of the union with the content of every option it holds kept, for a
 * walk that FINDS places — never one that judges them: a choice between
 * objects is the union of its options (`anyOf`), a choice among other values
 * expands the object holding it into one variant per option, and a choice in a
 * list contributes every option as an item. Each option's content is reached
 * by some variant; no variant is a configuration's.
 */
export function everyOptionOf(value: unknown): unknown {
  if (isAlternatives(value)) {
    const present = value.options.filter((option) => option.present).map((option) => everyOptionOf(option.value));
    return present.length === 1 ? present[0] : { anyOf: present };
  }
  if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      isAlternatives(item)
        ? item.options.filter((option) => option.present).map((option) => everyOptionOf(option.value))
        : [everyOptionOf(item)],
    );
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const fixed: Record<string, unknown> = {};
  const scalarChoices: [string, readonly AlternativeOption[]][] = [];
  for (const [key, field] of Object.entries(value)) {
    if (!isAlternatives(field)) {
      fixed[key] = everyOptionOf(field);
      continue;
    }
    const present = field.options.filter((option) => option.present);
    if (present.length > 0 && present.every((option) => isPlainRecord(option.value))) {
      fixed[key] = everyOptionOf(field);
      continue;
    }
    scalarChoices.push([key, field.options]);
  }
  if (scalarChoices.length === 0) return fixed;
  const variants: Record<string, unknown>[] = [];
  for (const [key, options] of scalarChoices) {
    for (const option of options) {
      variants.push(option.present ? { ...fixed, [key]: everyOptionOf(option.value) } : fixed);
    }
  }
  return variants.length === 1 ? variants[0] : { anyOf: variants };
}

function isPlainRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

