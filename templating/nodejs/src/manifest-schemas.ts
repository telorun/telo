/** Shared JSON-Schema fragments referenced from every module's `telo.yaml`
 *  via `$ref: "telo://manifest#/$defs/<Name>"`. Lives in the templating
 *  package (alongside the YAML tag mechanism) because the analyzer cannot
 *  depend on the kernel — both consume this package, so this is the only
 *  layer where a single source of truth can sit. The kernel re-exports
 *  these symbols from its own `manifest-schemas` surface for downstream
 *  ergonomics. */

/** Schema fragment for a resource-reference slot. The only form a manifest
 *  author writes is the `!ref <name>` (or `!ref <Alias>.<name>`) YAML tag,
 *  which parses to a `TaggedSentinel` (engine "ref") whose `source` is the
 *  bare resource name. In practice module schemas mark a ref slot with a bare
 *  `x-telo-ref` annotation (plus, where the slot only ever holds a reference,
 *  `type: object` to reject a stray scalar); the analyzer's reference walker
 *  reads `x-telo-ref` to look the name up against that constraint, independent
 *  of this fragment. A slot opts into `$ref:
 *  "telo://manifest#/$defs/ResourceRef"` only when it wants this exact
 *  two-branch shape enforced at the AJV layer too — it is not required, and
 *  slots that also accept an inline value (e.g. `inputType` / `outputType`)
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

const REF_ANNOTATION = "x-telo-ref";

// The legacy base types a reference slot used to pin when references were
// written as plain strings. Post-migration a reference resolves to an object
// (the `{kind, name, alias?}` shape, or an unresolved `!ref` sentinel), so a
// scalar `type` on a ref slot is a stale constraint that would reject the
// resolved value. Object / array `type`s are left alone — they already admit
// the reference object (and any inline value a slot like `inputType` accepts).
const LEGACY_REF_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

// JSON Schema keywords whose values are themselves subschemas. Split by shape so
// the ref-slot normalizer recurses only into schema positions — never into
// data-bearing keywords (`default`, `const`, `enum`, `examples`), where a stray
// `x-telo-ref` key would be data, not an annotation.
const SUBSCHEMA_SINGLE = [
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SUBSCHEMA_MAP = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

/** Deep-clone `schema`, dropping the stale scalar `type` constraint from every
 *  reference-slot node — one carrying an `x-telo-ref` string annotation.
 *
 *  A reference slot's value is always a `!ref` sentinel or its resolved
 *  `{kind, name, alias?}` object (never a bare string, post-migration). Older
 *  published modules still pin `type: "string"` on these slots — the encoding
 *  references took when they were written as plain strings — which now rejects
 *  the resolved object. Removing only the scalar `type` lets the analyzer and
 *  kernel accept references uniformly across module versions during the
 *  migration away from `{kind, name}` / string references, without disturbing
 *  slots that legitimately accept an inline object (e.g. `inputType` /
 *  `outputType`, which take a Telo.Type reference *or* an inline JSON schema).
 *  The `x-telo-ref` constraint itself (which kind the reference must satisfy) is
 *  checked separately by the analyzer's reference walker, which reads the
 *  original schema — not this validation-only copy. */
export function normalizeRefSlots(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...node };
  // Reference slot with a stale scalar `type` (legacy string-ref encoding):
  // drop the constraint so the resolved reference object / sentinel validates.
  if (
    typeof node[REF_ANNOTATION] === "string" &&
    typeof node.type === "string" &&
    LEGACY_REF_SCALAR_TYPES.has(node.type)
  ) {
    delete out.type;
  }
  for (const key of SUBSCHEMA_SINGLE) {
    const value = node[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = normalizeRefSlots(value);
    }
  }
  for (const key of SUBSCHEMA_LIST) {
    const value = node[key];
    if (Array.isArray(value)) out[key] = value.map(normalizeRefSlots);
  }
  // `items` is either a single subschema or a tuple of subschemas.
  if (Array.isArray(node.items)) {
    out.items = node.items.map(normalizeRefSlots);
  } else if (node.items && typeof node.items === "object") {
    out.items = normalizeRefSlots(node.items);
  }
  for (const key of SUBSCHEMA_MAP) {
    const value = node[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        mapped[name] = normalizeRefSlots(sub);
      }
      out[key] = mapped;
    }
  }
  return out;
}

/** Stable URI under which the shared manifest root schema is registered
 *  with module-side AJV instances. Module YAMLs reach the fragments via
 *  `$ref: "telo://manifest#/$defs/<Name>"`. The URI is the contract;
 *  the symbol names intentionally omit a host-specific prefix since the
 *  fragments live in `@telorun/templating` (the only layer both kernel
 *  and analyzer depend on). */
export const MANIFEST_SCHEMA_URI = "telo://manifest";

/** Root schema registered with AJV under `MANIFEST_SCHEMA_URI`. Carries
 *  `$defs` only — it isn't validated against directly. Adding a new
 *  shared fragment means putting it under `$defs` here and `$ref`-ing
 *  it from module schemas. */
export const ManifestRootSchema = {
  $id: MANIFEST_SCHEMA_URI,
  $defs: {
    ResourceRef: ResourceRefSchema,
  },
};
