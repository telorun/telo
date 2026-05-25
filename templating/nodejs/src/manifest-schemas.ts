/** Shared JSON-Schema fragments referenced from every module's `telo.yaml`
 *  via `$ref: "telo://manifest#/$defs/<Name>"`. Lives in the templating
 *  package (alongside the YAML tag mechanism) because the analyzer cannot
 *  depend on the kernel — both consume this package, so this is the only
 *  layer where a single source of truth can sit. The kernel re-exports
 *  these symbols from its own `manifest-schemas` surface for downstream
 *  ergonomics. */

/** Schema fragment for a resource reference produced by the `!ref` YAML
 *  tag. After parsing, the value is a `TaggedSentinel` (engine "ref")
 *  whose `source` is the bare resource name. Module schemas declare a
 *  ref slot as `$ref: "telo://manifest#/$defs/ResourceRef"`; the
 *  analyzer's reference walker is what looks the name up against the
 *  slot's `x-telo-ref` constraint.
 *
 *  Migration note: while the legacy bare-name string and `{kind, name}`
 *  object forms are still accepted by the analyzer/kernel walkers (in an
 *  additive transitional state), those shapes are *not* part of this
 *  schema. Slots that need to accept legacy forms during migration keep
 *  their hand-rolled `oneOf` until the cutover lands. */
export const ResourceRefSchema = {
  type: "object",
  required: ["__tagged", "engine", "source"],
  properties: {
    __tagged: { const: true },
    engine: { const: "ref" },
    source: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

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
