/**
 * The `peers:` / `entry` bindings of a referrer rule — a rule's view of the
 * SIBLING declarations a referrer lists beside the one that reached it.
 *
 * A rename marker is wrong only in relation to the *other* declarations a schema
 * lists, and an enum a column names is unlisted only in relation to the same set.
 * A resource rule sees one resource; a referrer rule sees a pair joined by one
 * reference; neither can state a relation between siblings. This is the binding
 * that can: a JSON Pointer naming a collection OF THE REFERRER, resolved.
 *
 * Four decisions carry the design:
 *
 * - **The FIELD MAP decides what is a reference, never the value's shape.** A
 *   `{kind, name}` object is what a resolved `!ref` looks like, but it is also
 *   author data that happens to carry two common keys — and sniffing for it would
 *   either resolve such data to an unrelated manifest or abort the binding as
 *   unresolved. The referrer kind's ref-slot paths are the authority, and the
 *   caller already holds them.
 * - **Entries bind AS WRITTEN, with the references inside them resolved one
 *   level.** A collection's items are not always references — a server's
 *   `mounts:` holds `{mount, prefix}` — so a peer is the declaration where the
 *   entry is a bare `!ref`, and the declaration with its siblings beside it where
 *   it is not. One level only: references inside a resolved declaration stay
 *   references, since a self-referencing foreign key and a mutual pair are both
 *   cycles.
 * - **`self` is excluded by SLOT PATH, not by identity** — exact, cheap, and
 *   correct when the same resource is listed twice. An ARRAY collection excludes
 *   by index and a MAP collection by key, because the concrete path spells them
 *   differently (`tables[2]` versus `tables.orders`) and reading only the first
 *   left every entry of a map judging itself. A `peers:` naming a collection
 *   *other* than the one that reached me excludes nothing, because nothing there
 *   is me.
 * - **A collection is resolved ONCE per referrer and pointer.** A rule evaluates
 *   per entry, so re-resolving and re-cloning the whole collection each time is
 *   quadratic in the number of entries — at the editor's keystroke-time analysis,
 *   and with the rule budget then reporting a correct rule as a defective one.
 *
 * A bound element is scanned for `!cel` here, where it is known to be a
 * declaration. The evaluator's own scan cannot do it: `findDynamicLeaf` stops at
 * any nested `{kind}` object — the guard that keeps an inline resource's
 * expressions out of an enclosing rule's verdict — and every resolved peer is
 * exactly that shape, so the whole peer set was exempt and a duplicate hidden
 * behind an expression compared against a sentinel and silently held. See
 * `dynamicInDeclaration` for how far the scan reaches and why it stops there.
 * Both halves classify through `dynamicNode`, so a `!ref` is a reference here
 * and a reference there rather than an expression to one of them.
 *
 * **One unresolvable peer fails the whole binding**, rather than binding what
 * resolved and dropping the rest. A peer rule's condition is characteristically
 * an existential or a universal over the set (`peers.exists(…)`,
 * `peers.all(…)`), and a partial set answers both of those WRONGLY and silently:
 * dropping the one peer a duplicate check was about turns a violation into a
 * pass. A skip is reported and names the reference that did not resolve; a
 * verdict over a set quietly missing a member is not.
 *
 * Peers-by-kind was rejected rather than deferred: a binding over "every resource
 * of this kind in the analysis" needs no resolution and is unsound, because a
 * physical name is scoped by its namespace and two schema resources over one
 * connection would report a conflict between objects that never meet. The
 * reference collection is what defines the scope.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isRefEntry } from "./reference-field-map.js";
import {
  dynamicNode,
  findDynamicLeaf,
  pointerToPath,
  resolvePointer,
  type DynamicLeaf,
} from "./resource-rule.js";
import { isIterableSchema, schemaAtPointer } from "./validate-resource-rules.js";

/**
 * The half of a definition registry both halves below need.
 *
 * Structural, the `ProjectionScope` precedent: a resolver rather than the
 * concrete registry, so this module keeps its own dependencies to the annotation
 * readers and a second host can supply its own.
 */
export interface PeerBinderRegistry {
  effectiveSchema(kind: string): Record<string, any> | undefined;
  resolve(kind: string): { kind?: string } | undefined;
  getByExtends(kind: string): { metadata: { module?: string; name?: unknown } }[];
  getFieldMap(kind: string): Iterable<[string, any]> | undefined;
  getFieldMapForKind(kind: string, aliases: PeerAliasScope): Iterable<[string, any]> | undefined;
}

/** The alias scope a reference is resolved in: `moduleForAlias` for the
 *  declaration lookup, `resolveKind` for the field map it is handed to. */
export interface PeerAliasScope {
  moduleForAlias(alias: string): string | undefined;
  resolveKind(kind: string): string | undefined;
}

/** What a rule sees for one entry of a referrer's collection. */
export interface PeerBinding {
  /** The collection's other entries, references resolved one level. */
  readonly peers: unknown[];
  /** The referrer's own entry that reached `self`, resolved the same way. Where
   *  the entry is a bare reference this IS the referenced declaration. */
  readonly entry: unknown;
}

/** Why a binding could not be produced — reported rather than dropped, because a
 *  check whose coverage varies invisibly reads as passing. */
export interface PeerBindingFailure {
  /**
   * - `unresolved` — a reference names a declaration this analysis has not
   *   loaded, so the entry would bind to nothing.
   * - `no-collection` — the pointer resolves to something that is not a
   *   collection, absent included.
   * - `dynamic` — a value inside a bound declaration holds a `!cel`, so the
   *   comparison would run against a placeholder.
   * - `unknown-shape` — the referrer's kind is not resolvable here, so which of
   *   its paths hold references is not known.
   */
  readonly reason: "unresolved" | "no-collection" | "dynamic" | "unknown-shape";
  /** Where, in the referrer, for the diagnostic. */
  readonly at: string;
  /** For `dynamic`: the noun phrase naming what sits there, quoted verbatim by
   *  the diagnostic. A `!ref` is never one — it names a declaration, which is
   *  the value a peer rule compares. */
  readonly what?: string;
}

export type PeerBindingResult =
  | { readonly ok: true; readonly binding: PeerBinding }
  | { readonly ok: false; readonly failure: PeerBindingFailure };

/** A reference as it reaches evaluation: the `{kind, name, alias?}` shape Phase
 *  2.5 rewrites a `!ref` into, or the sentinel itself where that pass has not
 *  run (a round-trip view). Both are read, so a rule means one thing whichever
 *  way the host loaded the manifest. */
export interface ReferenceValue {
  readonly name: string;
  readonly alias?: string;
  readonly kind?: string;
}

/** Resolves a reference to the manifest it names, or `undefined` when this
 *  analysis holds no such declaration. Supplied by the caller, which owns the
 *  manifest set and the alias scope. */
export type DeclarationLookup = (ref: ReferenceValue) => ResourceManifest | undefined;

/** What the binder needs from its host. Both halves are the caller's because
 *  only it holds the definition registry and the manifest set. */
export interface PeerBinderEnv {
  readonly declarationOf: DeclarationLookup;
  /** The ref-slot field paths a referrer kind declares (`tables[]`,
   *  `mounts[].mount`, `tables.{}`) — the authority on which paths hold
   *  references. `undefined` when the kind is not resolvable, which binds
   *  nothing rather than guessing. */
  readonly refSlotsOf: (kind: string) => readonly string[] | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The reference a value holds, in either shape, or `undefined`. Read only at a
 *  path the field map declares to be a reference slot. */
export function referenceValueOf(value: unknown): ReferenceValue | undefined {
  if (!isObject(value)) return undefined;
  if (value.__tagged === true && value.engine === "ref" && typeof value.source === "string") {
    const dot = value.source.indexOf(".");
    return dot > 0
      ? { alias: value.source.slice(0, dot), name: value.source.slice(dot + 1) }
      : { name: value.source };
  }
  if (typeof value.name === "string" && typeof value.kind === "string") {
    return {
      name: value.name,
      kind: value.kind,
      ...(typeof value.alias === "string" ? { alias: value.alias } : {}),
    };
  }
  return undefined;
}

/** True when a concrete path is an instance of a field-map shape — `tables[2]`
 *  of `tables[]`, `mounts[1].mount` of `mounts[].mount`, `tables.orders` of
 *  `tables.{}`. A map key containing a dot is not distinguishable here, the same
 *  ambiguity the concrete path itself carries. */
export function shapeMatches(concrete: string, shape: string): boolean {
  const c = concrete.split(".");
  const s = shape.split(".");
  if (c.length !== s.length) return false;
  return s.every((segment, i) => {
    if (segment === "{}") return true;
    if (segment.endsWith("[]")) {
      const base = segment.slice(0, -2);
      return c[i].startsWith(`${base}[`) && /^\[\d+\]$/.test(c[i].slice(base.length));
    }
    return segment === c[i];
  });
}

/** The concrete path of the ENTRY a slot path sits in, truncated at the first
 *  `[]` / `{}` marker of the shape it matches — which is where an entry begins,
 *  everything after it being the entry's own shape. */
export function entryBoundary(concrete: string, shape: string): string {
  const c = concrete.split(".");
  const s = shape.split(".");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{}" || s[i].endsWith("[]")) return c.slice(0, i + 1).join(".");
  }
  return concrete;
}

/** Navigate a dotted/bracketed path (`mounts[1].mount`) within a value — the
 *  spelling the call graph gives an edge, so an edge's own path is what reads
 *  the entry it came from. */
export function navigatePath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const parsed = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!parsed) return undefined;
    const [, key, indices] = parsed;
    if (key !== "") {
      if (!isObject(current)) return undefined;
      current = current[key];
    }
    for (const index of indices.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * The entry shape a collection's items take — `tables[]` for an array,
 * `tables.{}` for a map — as the field map spells it.
 *
 * Chosen by the collection's RUNTIME type rather than by whichever shape the map
 * lists first: the two spell an entry's concrete path differently (`tables[2]`
 * versus `tables.orders`), so taking the wrong one leaves every entry unable to
 * recognise itself.
 */
function entryShapeOf(
  shapes: readonly string[],
  collectionPath: string,
  isArray: boolean,
): string | undefined {
  const wanted = isArray ? `${collectionPath}[]` : `${collectionPath}.{}`;
  return shapes.some((shape) => shape === wanted || shape.startsWith(`${wanted}.`))
    ? wanted
    : undefined;
}

/** Which paths inside one entry hold a reference: the item itself, or the named
 *  properties one level in. */
function entryRefsOf(
  shapes: readonly string[],
  entryShape: string,
): { itemIsRef: boolean; properties: Set<string> } {
  const properties = new Set<string>();
  let itemIsRef = false;
  for (const shape of shapes) {
    if (shape === entryShape) {
      itemIsRef = true;
      continue;
    }
    if (!shape.startsWith(`${entryShape}.`)) continue;
    const rest = shape.slice(entryShape.length + 1);
    if (!rest.includes(".")) properties.add(rest);
  }
  return { itemIsRef, properties };
}

/**
 * The first `!cel` among the fields of a resolved DECLARATION that a peer rule
 * can actually COMPARE — its own top-level scalars.
 *
 * Which fields a condition reads off an element cannot be recovered from the
 * parse: cel-js emits no access chain for a comprehension variable, so
 * `peers.exists(p, p.table == …)` yields only `peers` and nothing about `table`.
 * The bound is drawn structurally instead, and top-level scalars are the honest
 * line: a physical name, a type name, a marker — the identities a peer rule
 * compares. Reaching deeper needs a comprehension over nested config, and a rule
 * of that shape has an unbounded subject anyway.
 *
 * Scanning the whole declaration was tried first and is what this replaced: it
 * disabled every rule over a table the moment any nested field held an
 * expression — a seed's `when:`, a column default — which is noise where the
 * rule was about a physical name.
 */
function dynamicInDeclaration(declaration: ResourceManifest): DynamicLeaf | undefined {
  for (const [key, value] of Object.entries(declaration as Record<string, unknown>)) {
    if (key === "metadata") continue;
    const dynamic = dynamicNode(value, key);
    if (dynamic) return dynamic;
  }
  return undefined;
}

type EntryResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: PeerBindingFailure };

/** One entry with the references INSIDE it resolved — the declaration itself for
 *  a bare `!ref`, or the entry with each declared reference property replaced. */
function resolveEntry(
  value: unknown,
  at: string,
  refs: { itemIsRef: boolean; properties: Set<string> },
  lookup: DeclarationLookup,
): EntryResult {
  if (refs.itemIsRef) {
    const reference = referenceValueOf(value);
    // An inline declaration (`{kind, …config}` with no name) is not a reference;
    // it binds as written, exactly as any other non-reference entry does.
    if (reference) {
      const declaration = lookup(reference);
      if (!declaration) return { ok: false, failure: { reason: "unresolved", at } };
      const dynamic = dynamicInDeclaration(declaration);
      if (dynamic) {
        return {
          ok: false,
          failure: { reason: "dynamic", at: `${at} → ${dynamic.path}`, what: dynamic.what },
        };
      }
      return { ok: true, value: declaration };
    }
  }
  if (!isObject(value)) return { ok: true, value };

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!refs.properties.has(key)) {
      // The author's OWN entry data beside the reference (`prefix` next to
      // `mount`) — small, and read directly by a rule, so it is scanned whole.
      const dynamic = findDynamicLeaf(child, `${at}.${key}`);
      if (dynamic !== undefined) {
        return { ok: false, failure: { reason: "dynamic", at: dynamic.path, what: dynamic.what } };
      }
      out[key] = child;
      continue;
    }
    const reference = referenceValueOf(child);
    if (!reference) {
      out[key] = child;
      continue;
    }
    const declaration = lookup(reference);
    if (!declaration) return { ok: false, failure: { reason: "unresolved", at: `${at}.${key}` } };
    const dynamic = dynamicInDeclaration(declaration);
    if (dynamic) {
      return {
        ok: false,
        failure: { reason: "dynamic", at: `${at}.${key} → ${dynamic.path}`, what: dynamic.what },
      };
    }
    out[key] = declaration;
  }
  return { ok: true, value: out };
}

type ResolvedCollection =
  | {
      readonly ok: true;
      /** Concrete key of each entry — an index for an array, a key for a map. */
      readonly keys: string[];
      readonly values: unknown[];
      /** Absent for an empty collection: with no items there is no array/map
       *  distinction to draw, and nothing to exclude. */
      readonly entryShape?: string;
    }
  | { readonly ok: false; readonly failure: PeerBindingFailure };

/**
 * Binds `peers` and `entry`, resolving each referrer's collection once.
 *
 * One binder per analysis: the cache is what keeps a rule over an n-entry
 * collection linear in resolution work rather than quadratic, and it is shared
 * by the evaluation and the exercised check, which ask the same question.
 */
export class PeerBinder {
  constructor(private readonly env: PeerBinderEnv) {}

  private readonly collections = new WeakMap<ResourceManifest, Map<string, ResolvedCollection>>();

  /**
   * @param slotPath concrete path of the edge that reached the referenced
   *   resource, e.g. `tables[2]` or `mounts[1].mount`.
   */
  bind(
    referrer: ResourceManifest,
    referrerKind: string,
    pointer: string,
    slotPath: string,
  ): PeerBindingResult {
    const collectionPath = pointerToPath(pointer);
    const shapes = this.env.refSlotsOf(referrerKind);
    if (!shapes) return { ok: false, failure: { reason: "unknown-shape", at: collectionPath } };

    const resolved = this.collection(referrer, pointer, collectionPath, shapes);
    if (!resolved.ok) return resolved;

    const mine = resolved.entryShape
      ? this.entryKey(slotPath, collectionPath, resolved.entryShape)
      : undefined;
    const at = mine === undefined ? -1 : resolved.keys.indexOf(mine);
    const peers = at === -1 ? resolved.values : resolved.values.filter((_, i) => i !== at);

    if (at !== -1) return { ok: true, binding: { peers, entry: resolved.values[at] } };

    // The edge runs through a DIFFERENT collection than the one `peers:` names
    // (a rule over a schema's `enums:` while my own entry sits in `tables:`), so
    // the entry is found through the shape this slot path matches.
    const shape = shapes.find((candidate) => shapeMatches(slotPath, candidate));
    if (!shape) return { ok: false, failure: { reason: "unknown-shape", at: slotPath } };
    const boundary = entryBoundary(slotPath, shape);
    const entryShape = entryBoundary(shape, shape);
    const entry = resolveEntry(
      navigatePath(referrer, boundary),
      boundary,
      entryRefsOf(shapes, entryShape),
      this.env.declarationOf,
    );
    if (!entry.ok) return entry;
    return { ok: true, binding: { peers, entry: entry.value } };
  }

  /** True when the rule has something to compare — the input to the
   *  never-exercised report, asked through the same cache. */
  hasPeers(
    referrer: ResourceManifest,
    referrerKind: string,
    pointer: string,
    slotPath: string,
  ): boolean {
    const bound = this.bind(referrer, referrerKind, pointer, slotPath);
    return bound.ok && bound.binding.peers.length > 0;
  }

  private collection(
    referrer: ResourceManifest,
    pointer: string,
    collectionPath: string,
    shapes: readonly string[],
  ): ResolvedCollection {
    let byPointer = this.collections.get(referrer);
    if (!byPointer) {
      byPointer = new Map();
      this.collections.set(referrer, byPointer);
    }
    const cached = byPointer.get(pointer);
    if (cached) return cached;

    const resolved = this.resolveCollection(referrer, pointer, collectionPath, shapes);
    byPointer.set(pointer, resolved);
    return resolved;
  }

  private resolveCollection(
    referrer: ResourceManifest,
    pointer: string,
    collectionPath: string,
    shapes: readonly string[],
  ): ResolvedCollection {
    const raw = resolvePointer(referrer, pointer);
    // An ABSENT collection is an EMPTY one, not an unbindable one — the line
    // `resolveRuleSubjects` already draws for a resource rule's `in:`. A resource
    // that simply declares none is the loudest case a peer rule has (a column
    // naming an enum its schema lists nowhere), so degrading it to a skip would
    // silence exactly the manifest the rule exists for.
    if (raw === undefined || raw === null) return { ok: true, keys: [], values: [] };
    if (!Array.isArray(raw) && !isObject(raw)) {
      return { ok: false, failure: { reason: "no-collection", at: collectionPath } };
    }
    const entryShape = entryShapeOf(shapes, collectionPath, Array.isArray(raw));
    if (!entryShape) {
      return { ok: false, failure: { reason: "unknown-shape", at: collectionPath } };
    }
    const refs = entryRefsOf(shapes, entryShape);
    const keys = Array.isArray(raw) ? raw.map((_, i) => String(i)) : Object.keys(raw);
    const items = Array.isArray(raw) ? raw : Object.values(raw);

    const values: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const at = Array.isArray(raw) ? `${collectionPath}[${keys[i]}]` : `${collectionPath}.${keys[i]}`;
      const resolved = resolveEntry(items[i], at, refs, this.env.declarationOf);
      if (!resolved.ok) return resolved;
      values.push(resolved.value);
    }
    return { ok: true, keys, values, entryShape };
  }

  /** The array index or map key `slotPath` occupies in the peers collection, or
   *  `undefined` when the path does not run through it at all. */
  private entryKey(
    slotPath: string,
    collectionPath: string,
    entryShape: string,
  ): string | undefined {
    if (entryShape.endsWith("[]")) {
      if (!slotPath.startsWith(`${collectionPath}[`)) return undefined;
      const match = /^\[(\d+)\]/.exec(slotPath.slice(collectionPath.length));
      return match ? match[1] : undefined;
    }
    if (!slotPath.startsWith(`${collectionPath}.`)) return undefined;
    const rest = slotPath.slice(collectionPath.length + 1);
    const dot = rest.indexOf(".");
    return dot === -1 ? rest : rest.slice(0, dot);
  }
}

/**
 * What a peer rule's `peers:` pointer names in the kind its `referrer:` filters
 * to — the strict half's question, answered where the binding vocabulary lives
 * so the checker and the binder read one field map.
 *
 * - `unknown` — the referrer kind is not resolvable here; say nothing.
 * - `absent` — the kind declares no such collection.
 * - `plain` — a collection of plain data: nothing in it resolves, so the rule
 *   would never see a declaration.
 * - `ok` — a collection whose items are, or contain, a reference.
 */
export type PeersTarget = "unknown" | "absent" | "plain" | "ok";

/**
 * The binder for one analysis run.
 *
 * ONE per run: it caches each referrer's resolved collection, which is what
 * keeps a rule over an n-entry collection from re-resolving that collection once
 * per entry — and both the evaluation and the exercised check ask for it.
 *
 * Built here rather than assembled at the analysis site, the
 * `analyzerContractScope` precedent: both halves are the binding's own rule
 * expressed against the analyzer's registry, and inline they were 40 lines of a
 * 2700-line pass, using two different field-map accessors for one question.
 */
export function analyzerPeerBinder(
  registry: PeerBinderRegistry,
  aliases: PeerAliasScope,
  manifests: readonly ResourceManifest[],
): PeerBinder {
  const byName = new Map<string, ResourceManifest>();
  const byModuleAndName = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    byName.set(name, m);
    const mod = (m.metadata as { module?: string }).module;
    if (mod) byModuleAndName.set(`${mod}\0${name}`, m);
  }

  /**
   * An alias RESOLVES OR NOTHING DOES. Resource names are module-scoped, so two
   * libraries each exporting a `users` share one bucket in `byName`; falling
   * back to it when the alias names a module this analysis cannot resolve would
   * compare against a declaration from somewhere else entirely — a confident
   * wrong verdict, which is worse than the reported skip an absent binding
   * produces.
   */
  const declarationOf: DeclarationLookup = (ref) => {
    if (ref.alias && ref.alias !== "Self") {
      const module = aliases.moduleForAlias(ref.alias);
      return module ? byModuleAndName.get(`${module}\0${ref.name}`) : undefined;
    }
    return byName.get(ref.name);
  };

  /**
   * Which paths of a referrer kind hold references — the field map, which is the
   * authority. A binder that sniffed for `{kind, name}` instead would resolve
   * author data carrying those two keys to an unrelated manifest.
   */
  const refSlotsOf = (kind: string): string[] | undefined => {
    const map = registry.getFieldMapForKind(kind, aliases);
    if (!map) return undefined;
    return [...map].filter(([, entry]) => isRefEntry(entry)).map(([path]) => path);
  };

  return new PeerBinder({ declarationOf, refSlotsOf });
}

/**
 * The strict half's resolver for a `peers:` pointer.
 *
 * Liskov in BOTH directions, which is what the check has to be: the filter is
 * usually an abstract (`Sql.Schema`, so one rule serves every backend) while the
 * collection is declared by the backends that implement it, so a pointer
 * resolving on any candidate resolves the rule. Reported only when NO candidate
 * declares it, or when every candidate that does holds plain data — the two
 * shapes where the rule would see no declaration at all.
 *
 * Takes only the registry: it is answered after the registration loop and before
 * the manifest list exists, which is also why it is a separate function rather
 * than a method on one environment object.
 */
export function analyzerPeersTarget(
  registry: PeerBinderRegistry,
): (referrerKind: string, pointer: string) => PeersTarget {
  return (referrerKind, pointer) => {
    const implementations = registry
      .getByExtends(referrerKind)
      .map((d) =>
        d.metadata.module ? `${d.metadata.module}.${d.metadata.name}` : String(d.metadata.name),
      );
    const candidates = [referrerKind, ...implementations];
    const path = pointerToPath(pointer);
    let sawSchema = false;
    let sawCollection = false;
    for (const kind of candidates) {
      const schema = registry.effectiveSchema(kind);
      if (!schema) continue;
      sawSchema = true;
      const node = schemaAtPointer(schema, pointer);
      if (node === undefined || !isIterableSchema(node)) continue;
      sawCollection = true;
      const map = registry.getFieldMap(kind);
      if (!map) continue;
      for (const [fieldPath, entry] of map) {
        if (!isRefEntry(entry)) continue;
        if (
          fieldPath === `${path}[]` ||
          fieldPath.startsWith(`${path}[].`) ||
          fieldPath === `${path}.{}` ||
          fieldPath.startsWith(`${path}.{}.`)
        ) {
          return "ok";
        }
      }
    }
    if (!sawSchema) return "unknown";
    // An ABSTRACT filter with no implementations in this analysis says nothing:
    // the abstract declares the collection structurally and each backend
    // restates the entry as a reference to its OWN kind, so checking a library
    // on its own would report every such rule as pointing at plain data. The
    // consumer's app analysis holds the backends and answers properly there.
    const filter = registry.resolve(referrerKind);
    if (implementations.length === 0 && filter?.kind === "Telo.Abstract") return "unknown";
    return sawCollection ? "plain" : "absent";
  };
}
