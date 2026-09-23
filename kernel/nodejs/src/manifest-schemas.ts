import AjvModule from "ajv";
import addFormats from "ajv-formats";
// The loader's shape check for a `status:` block. `telo check` narrows it
// further through the `JsonSchema7` fragment, which can name the offending
// keyword and its line; keeping this permissive is what stops a sloppy keyword
// in an already-published manifest from becoming a boot failure.
import {
  ABSTRACT_THROWS_SCHEMA,
  OBSERVED_STATE_SCHEMA,
  registerTeloKeywords,
  THROWS_CAPABLE_CAPABILITIES,
  THROWS_SCHEMA,
} from "@telorun/analyzer";
const Ajv = AjvModule.default ?? AjvModule;

// Re-export the shared manifest fragments so consumers reaching them through the
// kernel's surface keep working. The canonical home is `@telorun/analyzer`: they
// describe manifest STRUCTURE, and the editor validates in a browser through the
// analyzer, which must not depend on this package — a fragment here would exist
// only at runtime, invisible to `telo check` and to the editor.
export {
  InvokeStepSchema,
  isSchemaFragment,
  JsonSchema7Schema,
  KindSchemaSchema,
  MANIFEST_SCHEMA_URI,
  ManifestRootSchema,
  manifestFragmentRef,
  ResourceRefSchema,
  RetryPolicySchema,
  StepSchema,
  withSchemaFragments,
} from "@telorun/analyzer";

const metadataSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    module: { type: "string" },
    // Discovery facet — an unordered set of domain labels (`[AI, Storage]`) the
    // hub and the editor group by. Open vocabulary: any label is legal, and
    // consumers group by whatever they find. The hub derives a match slug from
    // each label at index time, so casing and punctuation don't fork a group.
    categories: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

/** Alias-form pattern for `extends` values: "<Alias>.<AbstractName>".
 *  Resolved against the declaring file's `Telo.Import` aliases — identical to how
 *  kind prefixes work (e.g. `kind: Http.Api` resolves `Http` via the importer's
 *  alias registration). Identity form (`std/mod#Name`) is deprecated and intentionally not
 *  accepted: aliases carry the module version via their `Telo.Import` source,
 *  which canonical module names can't.
 *  - Alias: PascalCase (first letter uppercase)
 *  - Name: PascalCase */
const EXTENDS_ALIAS_PATTERN = "^[A-Z][A-Za-z0-9_]*\\.[A-Z][A-Za-z0-9_]*$";

const baseDefinition = {
  type: "object",
  required: ["kind", "metadata"],
  properties: {
    kind: { const: "Telo.Definition" },
    metadata: metadataSchema,
    capability: { type: "string" },
    extends: { type: "string", pattern: EXTENDS_ALIAS_PATTERN },
    schema: { type: "object", additionalProperties: true },
    status: OBSERVED_STATE_SCHEMA,
    controllers: { type: "array", items: { type: "string" } },
    throws: THROWS_SCHEMA,
    // A callable's signature and its native determinism claim. Deliberately
    // UNCONSTRAINED here, the `REQUIRES_SCHEMA` posture: every rule that matters
    // — optional parameters trailing, a shape named with `!ref` rather than as a
    // bare string, where `deterministic` may be written at all — needs the
    // `extends` chain and the kind's capability, not a schema. Declaring a shape
    // here would give one mistake two diagnostics, one of them phrased by a
    // layer that does not know what the value is for. They are LISTED because
    // `unevaluatedProperties: false` would otherwise reject every callable kind.
    params: {},
    returns: {},
    deterministic: {},
  },
  unevaluatedProperties: false,
};

const KNOWN_CAPABILITIES = [
  "Telo.Service",
  "Telo.Runnable",
  "Telo.Invocable",
  "Telo.Provider",
  "Telo.Type",
  "Telo.Mount",
  // A record-stream destination the runtime writes to directly rather than
  // through `ctx.invoke` — per-record dispatch is far too slow for a logging hot
  // path, and dispatch emits trace events, so routing logs through it would
  // generate telemetry from inside the telemetry path. See kernel/specs/logging.md §10.
  "Telo.Sink",
  // A function: `call(args)`, synchronous, reached from inside a CEL expression
  // through a module name. It receives no context — no zone, no cancellation, no
  // trace, nothing to await — which is why it is outside `Telo.Executable` and
  // why a thrown error here is not a structured error for a caller to render.
  "Telo.Callable",
  // `Telo.Executable` is deliberately declarable NOWHERE: it is the slot-
  // constraint parent of Invocable and Runnable ("control can be transferred to
  // this"), naming no lifecycle role. Listing it here keeps the open third-party
  // fallback branch below from accepting it — and since no branch above admits
  // it either, `capability: Telo.Executable` fails validation outright.
  "Telo.Executable",
] as const;

/** Rule 8: `throws:` is only meaningful on Telo.Invocable or Telo.Runnable.
 *  On Service/Mount/Provider/Type/etc. a thrown error is a boot-time failure,
 *  not a structured runtime error for a downstream caller, so declaring one
 *  is a schema error.
 *
 *  Spelled as a `false` schema at the property rather than `not: {required}` so
 *  the failure NAMES THE KEY: AJV reports `not` at the document root with
 *  nothing about the inner schema, which left the whole union unable to say
 *  which key was at fault — and the reducer then preferred a branch whose
 *  `capability` const merely disagreed, reporting `/capability must be equal to
 *  constant` about a document whose capability was right and whose `throws:` was
 *  wrong. This form reports `/throws is not allowed here`. */
/** One capability's branch. `throws` and `capability` live in ONE `properties`
 *  map, built here — spreading a second object carrying `properties` silently
 *  REPLACES the capability constant, which turns every forbidding branch into
 *  "any definition with a capability and no throws" and makes the whole `oneOf`
 *  match several branches at once. */
const capabilityBranch = (capability: string) => ({
  required: ["capability"],
  properties: {
    capability: { const: capability },
    ...(THROWS_CAPABLE_CAPABILITIES.includes(capability) ? {} : { throws: false }),
  },
});

export const ResourceDefinitionSchema = {
  ...baseDefinition,
  oneOf: [
    capabilityBranch("Telo.Service"),
    capabilityBranch("Telo.Runnable"),
    capabilityBranch("Telo.Invocable"),
    capabilityBranch("Telo.Provider"),
    capabilityBranch("Telo.Type"),
    capabilityBranch("Telo.Mount"),
    // A sink is written to directly, never dispatched, so a thrown error is a
    // boot-time failure rather than a structured runtime error for a caller.
    capabilityBranch("Telo.Sink"),
    // A callable is evaluated inside a CEL expression, with no caller frame to
    // return a structured error to: a throw fails the evaluation itself
    // (ERR_FUNCTION_FAILED), so a declared throw union would describe a
    // dispatch that never happens.
    capabilityBranch("Telo.Callable"),
    // Unknown/absent capability: open schema for third-party extensibility. An
    // absent one is inherited through `extends` and judged there; a declared
    // unknown one may not throw, the rule `telo check` applies.
    {
      not: {
        required: ["capability"],
        properties: { capability: { enum: KNOWN_CAPABILITIES } },
      },
      if: { required: ["capability"] },
      then: { properties: { throws: false } },
      unevaluatedProperties: true,
    },
  ],
};

/** Schema for `kind: Telo.Abstract`. Library-declared abstracts are type blueprints —
 *  they may carry an optional `capability` (lifecycle inherited by implementations)
 *  and an optional `schema` (shared base for implementations). `controllers` is
 *  forbidden (no runtime implementation). `throws` is the third part of the
 *  contract: a literal `codes` list that is the CEILING every implementation's
 *  codes must fall within — no `inherit` / `passthrough`, since there is no body.
 *  Other fields are permitted for forward compatibility with typed-abstracts work
 *  (inputType, outputType, …) — Telo.Abstract is an extension point by design. */
export const ResourceAbstractSchema = {
  type: "object",
  required: ["kind", "metadata"],
  properties: {
    kind: { const: "Telo.Abstract" },
    metadata: metadataSchema,
    capability: { type: "string" },
    schema: { type: "object", additionalProperties: true },
    // A contract may mandate what its implementations report.
    status: OBSERVED_STATE_SCHEMA,
    throws: ABSTRACT_THROWS_SCHEMA,
  },
  not: { required: ["controllers"] },
  // Rule 8: a declared capability outside the allowlist may not throw.
  if: {
    required: ["throws", "capability"],
    properties: { capability: { not: { enum: THROWS_CAPABLE_CAPABILITIES } } },
  },
  then: { properties: { throws: false } },
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true, strict: false });
registerTeloKeywords(ajv);
addFormats.default(ajv);

// Lazy-compile validator: the AJV codegen cost (≈10–15 ms for these
// schemas) is only paid when a definition / abstract actually needs
// validating. A hello-world that loads no Telo.Definition or
// Telo.Abstract documents never triggers either compile; apps that
// do see them only pay once per process.
interface LazyValidator {
  (data: unknown): boolean | Promise<unknown>;
  errors?: any[] | null;
}
function lazyValidator(schema: object): LazyValidator {
  let compiled: ReturnType<typeof ajv.compile> | undefined;
  const fn: LazyValidator = (data: unknown) => {
    if (!compiled) compiled = ajv.compile(schema);
    const ok = compiled(data);
    fn.errors = compiled.errors as any[] | null | undefined;
    return ok;
  };
  return fn;
}

export const validateResourceDefinition = lazyValidator(ResourceDefinitionSchema);
export const validateResourceAbstract = lazyValidator(ResourceAbstractSchema);

/** Re-exported from the analyzer so a schema failure is phrased identically
 *  under `telo check` and at runtime — the kernel's own copy rendered the same
 *  failure as a raw `instancePath + message` join and handled no union. */
export { formatAjvErrors } from "@telorun/analyzer";
