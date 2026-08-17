/**
 * Shared JSON-Schema fragments every module's `telo.yaml` may point at with
 * `$ref: "telo://manifest#/$defs/<Name>"`.
 *
 * WHY THE ANALYZER OWNS THEM. These describe manifest structure, which is what
 * this package exists to read — and the layering forces the choice anyway: the
 * editor validates in a browser through `@telorun/analyzer`, and the analyzer
 * must not depend on the kernel. A fragment in the kernel would exist only at
 * runtime, so `telo check` and the editor could not see a step's shape at all.
 * The kernel re-exports these from its own `manifest-schemas` surface, and both
 * halves register the same root document with AJV, so a `$ref` resolves
 * identically in the editor, in `telo check` and at dispatch.
 *
 * A fragment here is STRUCTURE, not a named user type. The two are different
 * mechanisms and both exist:
 *
 *   - `#/$defs/<Name>` is private to the declaring kind's own schema — Run's
 *     `WhileStep` is Run's business and nothing outside it can name one.
 *   - `telo://manifest#/$defs/<Name>` is this set: shapes the kernel defines, so
 *     several unrelated documents can agree on one. `builtins.ts` is not a module
 *     document and has no `$defs` any module could reach, which is why a shared
 *     shape cannot live in one of the modules that use it.
 *   - `telo:<module>/<Type>` names a `Telo.JsonSchema` resource a MODULE
 *     declared, resolved through the type registry and carrying its owner so two
 *     libraries may both declare a `Filter`.
 *
 * Adding a fragment means putting it under `$defs` in {@link ManifestRootSchema}
 * and `$ref`-ing it from module schemas. Browser-safe: no Node built-ins.
 */

import { jsonSchemaKeywords } from "./schema-keywords.js";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";

export const MANIFEST_SCHEMA_URI = "telo://manifest";

/** `$ref` to a fragment in this set, as a module schema writes it. */
export function manifestFragmentRef(name: string): string {
  return `${MANIFEST_SCHEMA_URI}#/$defs/${name}`;
}

/** Schema fragment for a resource-reference slot. The only form a manifest
 *  author writes is the `!ref <name>` (or `!ref <Alias>.<name>`) YAML tag,
 *  which parses to a `TaggedSentinel` (engine "ref") whose `source` is the
 *  bare resource name. In practice module schemas mark a ref slot with a bare
 *  `x-telo-ref` annotation (plus, where the slot only ever holds a reference,
 *  `type: object` to reject a stray scalar); the analyzer's reference walker
 *  reads `x-telo-ref` to look the name up against that constraint, independent
 *  of this fragment. A slot opts into this fragment only when it wants this
 *  exact two-branch shape enforced at the AJV layer too — it is not required,
 *  and slots that also accept an inline value (e.g. `inputType` / `outputType`)
 *  deliberately do not use it (an inline JSON Schema has no `kind`).
 *
 *  Two `anyOf` branches because the value's shape depends on the phase at
 *  which it is validated:
 *
 *   1. The raw `!ref` sentinel — what survives to AJV when a cross-module
 *      reference can't be resolved in standalone single-file analysis (the
 *      imported module isn't loaded). `substituteCelFields` deliberately
 *      keeps the sentinel so this branch matches.
 *   2. A resolved reference object — `{kind, name, alias?}` substituted in
 *      place of a sentinel (or an inline definition `{kind, ...config}`
 *      reached through a local `$ref` that escapes extraction). Both the
 *      kernel and the analyzer validate ref slots *after* sentinel
 *      resolution, so this is the shape AJV usually sees.
 *
 *  The object-form `{kind, name}` reference a user could once type directly
 *  is gone: a plain object at a ref slot is only ever an inline definition
 *  or the resolver's own substitution, never an author-written reference.
 *  That removal is enforced by the analyzer (it rejects an author-written
 *  `{kind, name}` before normalization), not by this schema — branch 2
 *  cannot distinguish an author's `{kind, name}` from the resolver's. */
export const ResourceRefSchema = {
  title: "Resource reference",
  anyOf: [
    {
      type: "object",
      required: ["__tagged", "engine", "source"],
      properties: {
        __tagged: { const: true },
        engine: { const: "ref" },
        source: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string" } },
      additionalProperties: true,
    },
  ],
};

/**
 * How a dispatch is re-attempted.
 *
 * ONE shape, because a retry policy is a cross-cutting primitive rather than
 * each composer's own idea: it was written out six times across `run` and
 * `http-client` and had already drifted — one copy declared no defaults, another
 * carried a field the others lacked. Defaults live here, so the Node step leaf
 * and a second-language one read the same numbers instead of each re-deriving
 * them from the other's source.
 *
 * `delay` survives as the older duration-string spelling because published
 * manifests carry it, and it cannot be migrated away: a migration entry writes a
 * SCALAR, and `"250ms"` → `250` is a computation the vocabulary deliberately
 * cannot express.
 */
export const RetryPolicySchema = {
  title: "Retry policy",
  description:
    "Re-attempts a failed dispatch with exponential backoff. A domain failure is " +
    "retried; a cancellation and a contract violation are not — the latter is a " +
    "property of the manifest and would fail identically every time.",
  type: "object",
  additionalProperties: false,
  properties: {
    attempts: {
      title: "Attempts",
      description: "Re-attempts after the first try. 0 disables retrying.",
      type: "integer",
      minimum: 0,
      default: 0,
    },
    initialDelay: {
      title: "Initial delay",
      description: "Milliseconds to wait before the first re-attempt.",
      type: "integer",
      minimum: 0,
      default: 250,
    },
    factor: {
      title: "Factor",
      description: "Multiplier applied to the delay after each re-attempt.",
      type: "number",
      minimum: 1,
      default: 2,
    },
    maxDelay: {
      title: "Max delay",
      description: "Ceiling on the delay between re-attempts, in milliseconds.",
      type: "integer",
      minimum: 0,
      default: 32000,
    },
    jitter: {
      title: "Jitter",
      description:
        "`full` picks each delay uniformly from [0, delay], which is what stops " +
        "work that failed together from re-attempting together.",
      type: "string",
      enum: ["none", "full"],
      default: "full",
    },
    delay: {
      title: "Delay",
      description:
        "DEPRECATED duration string (`250ms`, `1s`) — read as `initialDelay` when " +
        "that is absent. The pattern is what makes a typo a `telo check` failure " +
        "instead of a silently different backoff.",
      type: "string",
      pattern: "^[0-9]+(\\.[0-9]+)?\\s*(ms|s|m|h)$",
    },
  },
};

/**
 * The bare-count spelling of a re-attempt — `Http.Request.retries`, deprecated
 * but carried by every manifest published before `retry:` existed.
 *
 * Its own fragment rather than a special case in the reader: what a consumer
 * needs to know is WHERE the budget is, and pointing at this shape says "the
 * value itself" as precisely as pointing at a policy says "its `attempts`". It
 * cannot be migrated to the policy form — a migration entry writes a scalar, and
 * wrapping one in an object is not something the vocabulary can express.
 */
export const RetryAttemptsSchema = {
  title: "Retry attempts",
  description: "Re-attempts after the first try. 0 disables retrying.",
  type: "integer",
  minimum: 0,
  default: 0,
};

/**
 * A DISPATCH SITE: name a target, pass it arguments, optionally guard it,
 * optionally re-attempt it.
 *
 * The runtime has always had exactly one of these — `InvokeStep` in the SDK, run
 * by `executeInvokeStep`, which every dispatch passes through. What did not exist
 * was the schema half: the shape was hand-restated by each composer (four times
 * in `run`, once in `builtins.ts`) and they drifted, which is why `retry:` worked
 * in a sequence step and was a schema error one line away in `targets:` — not a
 * decision anyone made about boot, just a copy that never grew the field.
 *
 * Owning it here is also what retired `x-telo-retry` for a step: the analyzer
 * reads `step.retry.attempts` because that is what a step IS, rather than
 * discovering a retry-bearing field through a marker the kind had to remember to
 * write.
 *
 * `name` is optional: a boot target only needs one to publish
 * `steps.<name>.result`, and a composer that requires one says so in its own
 * schema. Closed, so a misspelled key is rejected wherever a dispatch is written.
 */
export const InvokeStepSchema = {
  title: "Invoke step",
  description:
    "Transfers control to a resource: what to call, what to pass it, whether to " +
    "call it, and how to re-attempt it.",
  type: "object",
  required: ["invoke"],
  additionalProperties: false,
  properties: {
    name: {
      title: "Name",
      description: "Publishes this dispatch's result as `steps.<name>.result`.",
      type: "string",
    },
    invoke: {
      title: "Invoke",
      description: "Resource to invoke.",
      "x-telo-topology-role": "invoke",
      // A reference is always an object (a `!ref` sentinel or its resolved
      // `{kind, name}`); requiring an object rejects a bare-string ref — which
      // `validateReferenceForms` cannot catch at this nested slot — at
      // `telo check` instead of as an obscure runtime failure.
      type: "object",
      "x-telo-ref": {
        kind: "Telo.Executable",
        use: "call",
        inputs: "/inputs",
      },
    },
    inputs: {
      title: "Inputs",
      description: "Values passed to the invoked resource.",
      "x-telo-topology-role": "inputs",
      type: "object",
      additionalProperties: true,
    },
    when: {
      title: "When",
      description: "CEL guard — the dispatch is skipped when it evaluates false.",
      type: "string",
    },
    retry: {
      title: "Retry",
      $ref: `${MANIFEST_SCHEMA_URI}#/$defs/RetryPolicy`,
    },
  },
};

/**
 * A JSON Schema an author writes as a manifest VALUE — an `inputType:`, an
 * `outputType:`, a `status:` block, an API route's `request.schema`.
 *
 * Declared so the surfaces that read a slot's schema learn what lives there. A
 * slot spelled `type: object` told them "some object": completion offered
 * nothing from the first key down, hover had nothing to show, and a misspelled
 * keyword travelled to a runtime failure that named the wrong field.
 *
 * OPEN, deliberately (`additionalProperties: true`, `type` admitting the
 * boolean form a nested `additionalProperties: false` takes). The keyword set
 * below is draft-07's — the dialect AJV actually runs — and everything outside
 * it, every `x-telo-*` annotation included, passes through untouched. Closing
 * this would reject the next annotation the moment a module invented one, for a
 * check nobody asked for; what it buys as it stands is the value of a keyword
 * an author DID write (`required: "name"`, `type: 5`) being wrong at
 * `telo check` rather than at dispatch.
 *
 * RECURSIVE, which is why it is not expanded in place like the fragments above
 * it: a schema's properties hold schemas. `expandManifestFragments` rewrites a
 * reference to this to the document-local `#/$defs/JsonSchema7` and hoists one
 * copy to the enclosing schema's root, so the pointer resolves inside whatever
 * AJV compiles, and the editor's local-only `$ref` resolver keeps working.
 */
export const JsonSchema7Schema = {
  title: "JSON Schema",
  description: "The shape of a value, as JSON Schema (draft-07).",
  type: ["object", "boolean"],
  properties: jsonSchemaKeywords(hoistedDefKey("JsonSchema7")),
  additionalProperties: true,
};

/**
 * The schema a KIND declares for its own configuration — a `Telo.Definition`'s
 * `schema:` block.
 *
 * The same body as {@link JsonSchema7Schema}, under its own name because the
 * name is the discriminator: a kind's schema is where the `x-telo-*` vocabulary
 * belongs (`x-telo-eval`, `x-telo-ref`, `x-telo-scope`, …) and a plain data
 * schema is where it does not. Completion reads the `x-telo-fragment` stamp to
 * decide which vocabulary to offer, exactly as a retry-budget consumer reads
 * which of `RetryPolicy` / `RetryAttempts` a slot pointed at.
 *
 * The annotations are NOT properties here — see `schema-keywords.ts` for why a
 * literal `x-telo-*` key inside a hoisted `properties` map would read to the
 * annotation walkers as a slot the author never wrote.
 */
export const KindSchemaSchema = {
  title: "Kind schema",
  description:
    "The configuration a resource of this kind accepts, as JSON Schema plus the `x-telo-*` annotations that say how each field behaves.",
  type: ["object", "boolean"],
  properties: jsonSchemaKeywords(hoistedDefKey("KindSchema")),
  additionalProperties: true,
};

/** The fragments that describe author-written JSON Schema, whichever vocabulary
 *  they admit. They are also exactly the RECURSIVE ones — a schema is the only
 *  shape in this set that contains itself — so a reference to one is localized
 *  and hoisted rather than expanded in place ({@link localizeRecursiveFragment});
 *  should a self-containing fragment that is not a schema ever land, the two
 *  ideas split and this set stays the one about schemas. */
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
 * self-reference points at.
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

/** Root schema registered with AJV under {@link MANIFEST_SCHEMA_URI}. Carries
 *  `$defs` only — it isn't validated against directly. */
export const ManifestRootSchema = {
  $id: MANIFEST_SCHEMA_URI,
  $defs: {
    ResourceRef: ResourceRefSchema,
    RetryPolicy: RetryPolicySchema,
    RetryAttempts: RetryAttemptsSchema,
    InvokeStep: InvokeStepSchema,
    JsonSchema7: JsonSchema7Schema,
    KindSchema: KindSchemaSchema,
  },
};

deepFreeze(ManifestRootSchema);

/** A private, expanded copy of a fragment, for a consumer that must EMBED one
 *  rather than `$ref` it — `builtins.ts` is not a manifest and never passes
 *  through the loader, so its dispatch site has to arrive already resolved and
 *  already stamped. Cloned for the reason {@link deepFreeze} explains. */
export function manifestFragment(name: string): Record<string, unknown> {
  const fragment = (ManifestRootSchema.$defs as Record<string, unknown>)[name];
  if (!fragment || typeof fragment !== "object") {
    throw new Error(`Unknown manifest fragment '${name}'`);
  }
  if (SCHEMA_FRAGMENTS.has(name)) {
    // A recursive fragment has no expanded form — that is the whole reason it is
    // localized instead. Embedding one would hand the consumer a body whose
    // `#/$defs` pointers resolve against nothing.
    throw new Error(
      `Manifest fragment '${name}' is recursive and cannot be embedded — ` +
        `point a slot at it with $ref: "${manifestFragmentRef(name)}" and pass the ` +
        `enclosing schema through withSchemaFragments().`,
    );
  }
  const copy = structuredClone(fragment) as Record<string, unknown>;
  expandManifestFragments(copy);
  copy[X_TELO_FRAGMENT] = name;
  return copy;
}

const FRAGMENT_PREFIX = `${MANIFEST_SCHEMA_URI}#/$defs/`;

/**
 * Replace every `telo://manifest#/$defs/<Name>` reference with the fragment
 * itself, in place, throughout a parsed manifest.
 *
 * EXPANDED rather than left as a reference, which is the opposite of what
 * `resolveSchemaTypeRefs` does for a named user type — and for the opposite
 * reasons. A user type must stay a reference because it can recurse and because
 * the compiled-validator cache is keyed on schema identity. These fragments are a
 * closed, non-recursive set the analyzer itself owns, and expanding them is what
 * keeps a composer that points at a shared shape legible to walks that never
 * resolved anything: the CEL-placeholder substitution, the eval-path collector,
 * the editor's field walk. Teaching each of those to follow a reference is the
 * same fix applied N times, and the failure mode when one is missed is silent —
 * a role-driven lookup finds nothing and the check it feeds simply stops
 * reporting.
 *
 * Runs in the shared loader, so both kernels' Node halves and every consumer of a
 * loaded manifest see the same expanded shape.
 */
export function expandManifestFragments(node: unknown, seen = new Set<object>()): void {
  if (!node || typeof node !== "object") return;
  walkFragments(node, seen, { hoistTarget: node as Record<string, unknown>, depth: 0 });
}

/** Where a hoisted recursive fragment's `$defs` entry goes, and how deep the
 *  walk is — the two facts {@link walkFragments} carries down. */
interface ExpandContext {
  /** The nearest enclosing node AJV will compile as a schema: a document's
   *  top-level schema-valued key, else the node expansion started from. */
  readonly hoistTarget: Record<string, unknown>;
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
    return { hoistTarget: value, depth: 1 };
  }
  return { hoistTarget: ctx.hoistTarget, depth: ctx.depth + 1 };
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
        const fragment = fragmentFor(node[i]);
        if (fragment) node[i] = fragment;
        else walkFragments(node[i], seen, { ...ctx, depth: ctx.depth + 1 });
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
    const fragment = fragmentFor(value);
    if (fragment) obj[key] = fragment;
    else walkFragments(value, seen, childContext(ctx, key, value));
  }
}

/**
 * Rewrite a reference to a RECURSIVE fragment to the document-local pointer,
 * hoisting one copy of the fragment into the enclosing schema's `$defs`.
 *
 * Localized rather than inlined because the shape contains itself: inlining
 * cannot terminate, which is what the "closed, non-recursive set" caveat above
 * says. Localized rather than left pointing at `telo://manifest` because two
 * consumers cannot follow a foreign URI — the editor's resolver throws on any
 * `$ref` that does not start with `#/`, and that throw takes the whole canvas
 * down, exactly as gating fragment expansion once did.
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
  if (!SCHEMA_FRAGMENTS.has(name)) return undefined;

  hoistFragmentDef(ctx.hoistTarget, name);
  return { ...value, $ref: `#/$defs/${hoistedDefKey(name)}`, [X_TELO_FRAGMENT]: name };
}

/** Add `name` (and anything it references in turn) to `target.$defs`, cloned —
 *  the fragment set is frozen, and later passes rewrite schemas in place. */
function hoistFragmentDef(target: Record<string, unknown>, name: string): void {
  const defs = (target.$defs ??= {}) as Record<string, unknown>;
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    const key = hoistedDefKey(next);
    if (defs[key]) continue;
    const fragment = (ManifestRootSchema.$defs as Record<string, unknown>)[next];
    if (!fragment || typeof fragment !== "object") continue;
    // Stamped on the hoisted body, not only on the slot that pointed at it: a
    // schema nests, so the node a consumer resolves two levels down is the
    // fragment reached through its own self-reference, with no slot in sight.
    // That node is exactly where an annotation like `x-telo-eval` is written,
    // so it is where the stamp has to be readable.
    defs[key] = { ...(structuredClone(fragment) as object), [X_TELO_FRAGMENT]: next };
    for (const nested of SCHEMA_FRAGMENTS) {
      if (nested !== next && referencesLocalDef(defs[key], nested)) pending.push(nested);
    }
  }
}

/** Does a hoisted fragment point at another one? Cheap and structural: the set
 *  is small and a missed edge would leave an unresolvable pointer, which AJV
 *  reports loudly rather than silently skipping. */
function referencesLocalDef(node: unknown, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((item) => referencesLocalDef(item, name));
  const obj = node as Record<string, unknown>;
  if (obj.$ref === `#/$defs/${hoistedDefKey(name)}`) return true;
  return Object.values(obj).some((value) => referencesLocalDef(value, name));
}

/**
 * Expand fragments in a schema that never passes through the loader —
 * `builtins.ts` is not a manifest, so its slots have to arrive already
 * localized, with the hoisted `$defs` at the root of the schema AJV compiles.
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
function fragmentFor(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith(FRAGMENT_PREFIX)) return undefined;
  const name = ref.slice(FRAGMENT_PREFIX.length);
  const fragment = (ManifestRootSchema.$defs as Record<string, unknown>)[name];
  if (!fragment || typeof fragment !== "object") return undefined;

  const expanded = structuredClone(fragment) as Record<string, unknown>;
  // A fragment may reference another (InvokeStep holds a RetryPolicy); the copy
  // is expanded too, so one pass leaves no reference behind.
  expandManifestFragments(expanded);

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
