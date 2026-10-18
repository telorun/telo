/**
 * Shared JSON-Schema fragments every module's `telo.yaml` may point at with
 * `$ref: "telo://manifest#/$defs/<Name>"`.
 *
 * THE BODIES ARE DATA: one JSON file per fragment under `sdk/builtins/fragments/`,
 * derived into `builtin-entries/` by `scripts/render-builtin-vocabulary.mjs`.
 * Every runtime reads the same files, and a fragment refers to another as
 * `telo://manifest#/$defs/<Name>` — the spelling an author writes. Expansion,
 * below, is the analyzer's reading of those references.
 *
 * WHY THE ANALYZER OWNS THE READING. These describe manifest structure, which is
 * what this package exists to read — and the layering forces the choice anyway:
 * the editor validates in a browser through `@telorun/analyzer`, and the analyzer
 * must not depend on the kernel. The kernel re-exports these from its own
 * `manifest-schemas` surface, and both halves register the same root document
 * with AJV, so a `$ref` resolves identically in the editor, in `telo check` and
 * at dispatch.
 *
 * A fragment here is STRUCTURE, not a named user type. The two are different
 * mechanisms and both exist:
 *
 *   - `#/$defs/<Name>` is private to the declaring kind's own schema — Run's
 *     `WhileStep` is Run's business and nothing outside it can name one.
 *   - `telo://manifest#/$defs/<Name>` is this set: shapes the kernel defines, so
 *     several unrelated documents can agree on one.
 *   - `telo:<module>/<Type>` names a `Telo.JsonSchema` resource a MODULE
 *     declared, resolved through the type registry and carrying its owner so two
 *     libraries may both declare a `Filter`.
 *
 * Adding a fragment means adding its file under `sdk/builtins/fragments/` and
 * `$ref`-ing it. Browser-safe: no Node built-ins.
 */

import { BUILTIN_FRAGMENT_FILES } from "./builtin-entries/index.js";
import { refuseRosterMarkers } from "./builtin-entry-markers.js";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";

export const MANIFEST_SCHEMA_URI = "telo://manifest";

/** `$ref` to a fragment in this set, as a module schema writes it. */
export function manifestFragmentRef(name: string): string {
  return `${MANIFEST_SCHEMA_URI}#/$defs/${name}`;
}

const FRAGMENT_PREFIX = `${MANIFEST_SCHEMA_URI}#/$defs/`;

/** The fragments that describe author-written JSON Schema, whichever vocabulary
 *  they admit. Distinct from being recursive: being recursive is a fact about how
 *  a reference is RESOLVED, being a schema is a fact about which vocabulary a
 *  slot admits, and `Step` is recursive without being a schema. */
const SCHEMA_FRAGMENTS = new Set(["JsonSchema7", "KindSchema"]);

/** True when a slot's `x-telo-fragment` stamp says it holds author-written JSON
 *  Schema — a kind's `schema:`, a `status:` block, a `Telo.JsonSchema`'s own
 *  `schema`. The one accessor every consumer asks, so no surface re-spells the
 *  set. */
export function isSchemaFragment(name: string | undefined): boolean {
  return name !== undefined && SCHEMA_FRAGMENTS.has(name);
}

/**
 * The `$defs` key a hoisted fragment is written under, and the one its own
 * self-reference points at once localized.
 *
 * NAMESPACED so a collision is unrepresentable rather than diagnosable: `$defs`
 * is the author's namespace, and a kind declaring its own `$defs: { KindSchema:
 * … }` beside a slot pointing at the fragment would otherwise have its shape
 * silently validate every such slot — a wrong-but-plausible validation, which is
 * worse than a loud failure and impossible to see. With a reserved key the two
 * coexist, and "already present" can only mean a previous hoist of the same
 * fragment, which is what makes {@link hoistFragmentDef}'s skip provably safe.
 */
function hoistedDefKey(name: string): string {
  return `telo:${name}`;
}

/** True for a `$defs` key {@link hoistedDefKey} reserved — the analyzer's own
 *  copy of a fragment, which a walk over what a kind DECLARED must not read as
 *  the kind's own schema. */
export function isHoistedFragmentDefKey(key: string): boolean {
  return key.startsWith(hoistedDefKey(""));
}

/** Recursively freeze, so the fragment set cannot be edited through any of the
 *  references handed out. `fragmentFor` clones precisely because downstream
 *  passes rewrite schemas in place — `resolveSchemaRefKinds` rewrites the very
 *  `x-telo-ref` node `InvokeStep` carries — and a consumer that embedded a
 *  fragment WITHOUT cloning would corrupt every later expansion process-wide, in
 *  a host that outlives one load (the editor, the LSP). Freezing turns that from
 *  a rule someone has to remember into a throw at the write. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function readFragments(): Record<string, Record<string, unknown>> {
  const defs: Record<string, Record<string, unknown>> = {};
  for (const [name, data] of BUILTIN_FRAGMENT_FILES) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`sdk/builtins/fragments/${name}.json: a fragment is a JSON Schema object.`);
    }
    refuseRosterMarkers(data, `sdk/builtins/fragments/${name}.json`);
    defs[name] = structuredClone(data) as Record<string, unknown>;
  }
  return defs;
}

/** Root schema registered with AJV under {@link MANIFEST_SCHEMA_URI}. Carries
 *  `$defs` only — it isn't validated against directly. Each body is the entry as
 *  written, its references to the others in the authored spelling. */
export const ManifestRootSchema = {
  $id: MANIFEST_SCHEMA_URI,
  $defs: readFragments(),
};

deepFreeze(ManifestRootSchema);

function fragmentBody(name: string): Record<string, unknown> | undefined {
  const body = (ManifestRootSchema.$defs as Record<string, unknown>)[name];
  return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
}

/** A fragment body by name, for the consumers that re-export the well-known
 *  shapes. Throws on a name the vocabulary does not hold. */
function requireFragment(name: string): Record<string, unknown> {
  const body = fragmentBody(name);
  if (!body) throw new Error(`Unknown manifest fragment '${name}'`);
  return body;
}

export const ResourceRefSchema = requireFragment("ResourceRef");
export const RetryPolicySchema = requireFragment("RetryPolicy");
export const RetryAttemptsSchema = requireFragment("RetryAttempts");
export const InvokeStepSchema = requireFragment("InvokeStep");
export const StepSchema = requireFragment("Step");
export const JsonSchema7Schema = requireFragment("JsonSchema7");
export const KindSchemaSchema = requireFragment("KindSchema");

/** The fragments a body names directly, by `telo://manifest#/$defs/<Name>`. */
function referencedFragments(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) referencedFragments(item, out);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(FRAGMENT_PREFIX)) {
      out.add(value.slice(FRAGMENT_PREFIX.length));
    } else {
      referencedFragments(value, out);
    }
  }
  return out;
}

/**
 * The fragments that CONTAIN THEMSELVES — a schema's properties hold schemas, a
 * step's branches hold steps. A reference to one is localized and hoisted rather
 * than expanded in place ({@link localizeRecursiveFragment}), because inlining
 * cannot terminate.
 *
 * DERIVED from the bodies — a fragment that reaches itself through the
 * references they hold — so which fragments recurse is a property of the data,
 * never a list kept beside it.
 */
const RECURSIVE_FRAGMENTS: ReadonlySet<string> = (() => {
  const edges = new Map<string, Set<string>>();
  for (const name of Object.keys(ManifestRootSchema.$defs)) {
    edges.set(name, referencedFragments(fragmentBody(name)));
  }
  const recursive = new Set<string>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const queue = [...(edges.get(start) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
})();

/** An expanded fragment body, and the recursive fragments its expansion
 *  localized — which belong in the `$defs` of whatever schema embeds it. */
interface ExpandedTemplate {
  readonly body: Record<string, unknown>;
  readonly hoists: readonly string[];
}

/**
 * One expanded template per fragment, cloned per consumer.
 *
 * Expansion is a full walk of the body and the result is identical every time —
 * `Step` alone is a couple of hundred nodes and `modules/run` hoists it four
 * times, on the kernel's boot path. The copy handed out is still fresh, because
 * downstream passes (`resolveSchemaRefKinds`, migrations) rewrite schemas in
 * place.
 */
const expandedFragments = new Map<string, ExpandedTemplate>();

/**
 * A fully expanded fragment body, and the recursive fragments it references.
 *
 * TARGET-INDEPENDENT, which is what makes caching it correct: a localized copy
 * belongs in the schema a validator compiles, never inside another `$defs`
 * entry, so the walk RECORDS which recursive fragments the body localized
 * instead of placing them. Each consumer hoists those into its own target — a
 * non-recursive fragment that references a recursive one (`CallableType` holds a
 * `JsonSchema7`) carries the reference with it wherever it is expanded.
 */
function expandedFragment(name: string): ExpandedTemplate {
  let template = expandedFragments.get(name);
  if (!template) {
    const body = structuredClone(requireFragment(name)) as Record<string, unknown>;
    const hoists = new Set<string>();
    walkFragments(body, new Set(), { hoist: (fragment) => hoists.add(fragment), depth: 1 });
    template = { body, hoists: [...hoists] };
    expandedFragments.set(name, template);
  }
  return { body: structuredClone(template.body), hoists: template.hoists };
}

/** A private, expanded copy of a fragment, for a consumer that must EMBED one
 *  rather than `$ref` it. Refused for a fragment whose expansion localizes a
 *  recursive one, since an embedded copy has no `$defs` to resolve it against.
 *  Cloned for the reason {@link deepFreeze} explains. */
export function manifestFragment(name: string): Record<string, unknown> {
  requireFragment(name);
  const embeddable = !RECURSIVE_FRAGMENTS.has(name) && expandedFragment(name).hoists.length === 0;
  if (!embeddable) {
    // A recursive fragment has no expanded form — that is the whole reason it is
    // localized instead. Embedding one would hand the consumer a body whose
    // `#/$defs` pointers resolve against nothing.
    throw new Error(
      `Manifest fragment '${name}' is recursive, or references one, and cannot be embedded — ` +
        `point a slot at it with $ref: "${manifestFragmentRef(name)}" and pass the ` +
        `enclosing schema through withSchemaFragments().`,
    );
  }
  const copy = expandedFragment(name).body;
  copy[X_TELO_FRAGMENT] = name;
  return copy;
}

/**
 * Replace every `telo://manifest#/$defs/<Name>` reference with the fragment
 * itself, in place, throughout a parsed manifest.
 *
 * EXPANDED rather than left as a reference, which is the opposite of what
 * `resolveSchemaTypeRefs` does for a named user type — and for the opposite
 * reasons. A user type must stay a reference because it can recurse and because
 * the compiled-validator cache is keyed on schema identity. The non-recursive
 * fragments are a closed set the analyzer itself owns, and expanding them is
 * what keeps a composer that points at a shared shape legible to walks that
 * never resolved anything: the CEL-placeholder substitution, the eval-path
 * collector, the editor's field walk. Teaching each of those to follow a
 * reference is the same fix applied N times, and the failure mode when one is
 * missed is silent — a role-driven lookup finds nothing and the check it feeds
 * simply stops reporting.
 *
 * Runs in the shared loader, so both kernels' Node halves and every consumer of a
 * loaded manifest see the same expanded shape. The built-ins never meet the
 * loader and are expanded the same way when they are registered.
 */
export function expandManifestFragments(node: unknown, seen = new Set<object>()): void {
  if (!node || typeof node !== "object") return;
  const target = node as Record<string, unknown>;
  walkFragments(node, seen, { hoist: (name) => hoistFragmentDef(target, name), depth: 0 });
}

/** Where a recursive fragment the walk localizes is hoisted, and how deep the
 *  walk is — the two facts {@link walkFragments} carries down. */
interface ExpandContext {
  /** Hoist a localized fragment into the nearest enclosing node AJV will
   *  compile as a schema: a document's top-level schema-valued key, else the
   *  node expansion started from — or, while a template is expanded, record it
   *  for whoever embeds the template. */
  readonly hoist: (name: string) => void;
  readonly depth: number;
}

/**
 * Descend one key. A TOP-LEVEL schema-valued key (`schema:`, `inputType:`,
 * `status:`, …) opens a new hoist target, because that node is what a validator
 * compiles: a `#/$defs/…` pointer written below it resolves against IT, not
 * against the document. Depth-anchored for the reason migrations anchor `under`
 * at top-level keys — a slot DESCRIBING a field named `schema` is not itself a
 * schema region, and treating it as one would scatter `$defs` blocks into the
 * middle of a kind's property map.
 */
function childContext(ctx: ExpandContext, key: string, value: unknown): ExpandContext {
  if (ctx.depth === 0 && SCHEMA_REGION_KEYS.includes(key) && isPlainObject(value)) {
    return { hoist: (name) => hoistFragmentDef(value, name), depth: 1 };
  }
  return { hoist: ctx.hoist, depth: ctx.depth + 1 };
}

function walkFragments(node: unknown, seen: Set<object>, ctx: ExpandContext): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const localized = localizeRecursiveFragment(node[i], ctx);
      if (localized) node[i] = localized;
      else {
        const fragment = fragmentFor(node[i], ctx);
        if (fragment) node[i] = fragment;
        else walkFragments(node[i], seen, { hoist: ctx.hoist, depth: ctx.depth + 1 });
      }
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const localized = localizeRecursiveFragment(value, ctx);
    if (localized) {
      obj[key] = localized;
      continue;
    }
    const fragment = fragmentFor(value, ctx);
    if (fragment) obj[key] = fragment;
    else walkFragments(value, seen, childContext(ctx, key, value));
  }
}

/**
 * Rewrite a reference to a RECURSIVE fragment to the document-local pointer,
 * hoisting one copy of the fragment into the enclosing schema's `$defs`.
 *
 * Localized rather than inlined because the shape contains itself: inlining
 * cannot terminate. Localized rather than left pointing at `telo://manifest`
 * because two consumers cannot follow a foreign URI — the editor's resolver
 * throws on any `$ref` that does not start with `#/`, and that throw takes the
 * whole canvas down, exactly as gating fragment expansion once did.
 *
 * Siblings written beside the `$ref` are kept, but draft-07 makes `$ref`
 * exclusive, so they reach the human surfaces (completion, hover, the editor)
 * and not AJV. A slot adds a `title` / `description` that way; a slot narrowing
 * the shape would be silently ignored and should declare its own schema.
 */
function localizeRecursiveFragment(
  value: unknown,
  ctx: ExpandContext,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const ref = value.$ref;
  if (typeof ref !== "string" || !ref.startsWith(FRAGMENT_PREFIX)) return undefined;
  const name = ref.slice(FRAGMENT_PREFIX.length);
  if (!RECURSIVE_FRAGMENTS.has(name)) return undefined;

  ctx.hoist(name);
  return { ...value, $ref: `#/$defs/${hoistedDefKey(name)}`, [X_TELO_FRAGMENT]: name };
}

/** Add `name` (and every recursive fragment its body localizes) to
 *  `target.$defs`, cloned — the fragment set is frozen, and later passes rewrite
 *  schemas in place. */
function hoistFragmentDef(target: Record<string, unknown>, name: string): void {
  const defs = (target.$defs ??= {}) as Record<string, unknown>;
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    const key = hoistedDefKey(next);
    if (defs[key]) continue;
    // Stamped on the hoisted body, not only on the slot that pointed at it: a
    // schema nests, so the node a consumer resolves two levels down is the
    // fragment reached through its own self-reference, with no slot in sight.
    // That node is exactly where an annotation like `x-telo-eval` is written,
    // so it is where the stamp has to be readable.
    const { body, hoists } = expandedFragment(next);
    defs[key] = { ...body, [X_TELO_FRAGMENT]: next };
    pending.push(...hoists);
  }
}

/**
 * Expand fragments in a schema that never passes through the loader, so its
 * slots arrive already localized, with the hoisted `$defs` at the root of the
 * schema AJV compiles.
 *
 * Returns the same object, expanded in place, for use as a declaration
 * initializer.
 */
export function withSchemaFragments<T extends Record<string, unknown>>(schema: T): T {
  expandManifestFragments(schema);
  return schema;
}

/**
 * The fragment a node references, expanded and merged with whatever the node
 * declared beside the `$ref`, or undefined when it references none.
 *
 * SIBLINGS ARE MERGED, which draft-07 would ignore — `$ref` is exclusive there,
 * so `{ $ref, properties: {...} }` silently drops the properties and `allOf` is
 * the only standard alternative. `allOf` cannot preserve
 * `additionalProperties: false`, because a branch only ever sees its own
 * `properties`; a kind extending the shared retry policy with one HTTP-specific
 * field would have had to give up a closed schema to do it. Merging at expansion
 * gives the 2019-09 reading — `$ref` composes rather than replaces — on the
 * draft the validators actually run.
 *
 * The node's own keys WIN, and `properties` merge key-wise, so an extension adds
 * fields without restating the shared ones.
 *
 * The result is STAMPED with the fragment it came from. That stamp is what
 * replaced `x-telo-retry`: a consumer asking "does this field declare a
 * re-attempt, and where is the budget" reads which shape the author pointed at,
 * rather than a marker the author had to remember to write beside it. Derived,
 * never authored — the same standing as `metadata.exportedKinds` — and stripped
 * before AJV like every other `x-telo-*` key, so it cannot affect validation.
 *
 * Deep-copied because downstream passes (`resolveSchemaRefKinds`, migrations)
 * rewrite schemas in place, and a shared object would let one manifest's rewrite
 * reach every other manifest that pointed at the same shape.
 */
function fragmentFor(value: unknown, ctx: ExpandContext): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith(FRAGMENT_PREFIX)) return undefined;
  const name = ref.slice(FRAGMENT_PREFIX.length);
  if (!fragmentBody(name)) return undefined;

  // A fragment may reference another (InvokeStep holds a RetryPolicy); the copy
  // arrives expanded, so one pass leaves no reference behind. What it localized
  // is hoisted where this node's own schema keeps its `$defs`.
  const { body: expanded, hoists } = expandedFragment(name);
  for (const hoisted of hoists) ctx.hoist(hoisted);

  for (const [key, own] of Object.entries(node)) {
    if (key === "$ref") continue;
    if (key === "properties" && isPlainObject(own) && isPlainObject(expanded.properties)) {
      expanded.properties = { ...expanded.properties, ...own };
      continue;
    }
    if (key === "required" && Array.isArray(own) && Array.isArray(expanded.required)) {
      expanded.required = [...new Set([...expanded.required, ...own])];
      continue;
    }
    expanded[key] = own;
  }
  expanded[X_TELO_FRAGMENT] = name;
  return expanded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Stamped by {@link expandManifestFragments} with the name of the shared
 *  fragment a slot pointed at. Derived, never author-written. */
export const X_TELO_FRAGMENT = "x-telo-fragment";

/** The shared fragment a schema node was expanded from, or undefined. The one
 *  accessor every consumer reads the stamp through. */
export function manifestFragmentOf(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const name = (schema as Record<string, unknown>)[X_TELO_FRAGMENT];
  return typeof name === "string" ? name : undefined;
}
