import AjvModule from "ajv";
import addFormats from "ajv-formats";
// The loader's shape check for a `status:` block. `telo check` narrows it
// further through the `JsonSchema7` fragment, which can name the offending
// keyword and its line; keeping this permissive is what stops a sloppy keyword
// in an already-published manifest from becoming a boot failure.
import { OBSERVED_STATE_SCHEMA, registerTeloKeywords } from "@telorun/analyzer";
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

const throwsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    codes: {
      type: "object",
      propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
      additionalProperties: {
        type: "object",
        required: ["description"],
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
      },
    },
    // "my throw union includes every code thrown by every invocable I call
    //  (minus codes caught in an enclosing try/catch)". Analyzer enforces
    //  that this is only legal on definitions whose schema declares at least
    //  one `x-telo-step-context` array.
    inherit: { type: "boolean" },
    // "my throw union is whatever `inputs.code` resolves to statically." Used
    // by passthrough-style adapters. Analyzer resolves per call site.
    passthrough: { type: "boolean" },
  },
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
    throws: throwsSchema,
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
const capabilityBranch = (capability: string, mayThrow: boolean) => ({
  required: ["capability"],
  properties: {
    capability: { const: capability },
    ...(mayThrow ? {} : { throws: false }),
  },
});

export const ResourceDefinitionSchema = {
  ...baseDefinition,
  oneOf: [
    capabilityBranch("Telo.Service", false),
    capabilityBranch("Telo.Runnable", true),
    capabilityBranch("Telo.Invocable", true),
    capabilityBranch("Telo.Provider", false),
    capabilityBranch("Telo.Type", false),
    capabilityBranch("Telo.Mount", false),
    // A sink is written to directly, never dispatched, so a thrown error is a
    // boot-time failure rather than a structured runtime error for a caller.
    capabilityBranch("Telo.Sink", false),
    // Unknown/absent capability: open schema for third-party extensibility
    {
      not: {
        required: ["capability"],
        properties: { capability: { enum: KNOWN_CAPABILITIES } },
      },
      unevaluatedProperties: true,
    },
  ],
};

/** Schema for `kind: Telo.Abstract`. Library-declared abstracts are type blueprints —
 *  they may carry an optional `capability` (lifecycle inherited by implementations)
 *  and an optional `schema` (shared base for implementations). `controllers` and `throws`
 *  are forbidden (no runtime implementation; throws lives on concrete definitions).
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
  },
  not: {
    anyOf: [{ required: ["controllers"] }, { required: ["throws"] }],
  },
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
