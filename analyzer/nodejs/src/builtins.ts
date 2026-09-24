import { PLATFORM_AXES } from "./artifact-axes.js";
import { manifestFragment, manifestFragmentRef, withSchemaFragments } from "./manifest-schemas.js";
import { ABSTRACT_THROWS_SCHEMA, THROWS_SCHEMA } from "./throws-declaration.js";

/** A slot holding author-written JSON Schema. Localized and hoisted by
 *  {@link withSchemaFragments} on the enclosing schema, which is what makes the
 *  `#/$defs` pointer resolve inside whatever AJV compiles.
 *
 *  `KindSchema` and `JsonSchema7` share a body; the name is the discriminator
 *  the IDE reads off the `x-telo-fragment` stamp to decide whether the
 *  `x-telo-*` vocabulary belongs here. A kind's own `schema:` is where it does;
 *  a `status:` block or an `inputType:` describes plain data, where it does not. */
const kindSchemaSlot = {
  title: "Schema",
  description: "Configuration this kind accepts, as JSON Schema plus `x-telo-*` annotations.",
  $ref: manifestFragmentRef("KindSchema"),
};

/** A type inside a callable's signature: a JSON Schema node in which a `!ref` to
 *  a `Telo.JsonSchema` may appear at the root or at any depth. The same grammar
 *  `inputType:` / `outputType:` already use, so every contract walk, CEL field
 *  check and structural comparison reads it unchanged. */
const signatureTypeSlot = {
  title: "Type",
  description:
    "The value's shape, as JSON Schema. `!ref <Shape>` names a `Telo.JsonSchema`, at the root or nested.",
  // The string branch is admitted so a bare name reaches the ONE diagnostic that
  // knows what it is — `FUNCTION_TYPE_NAME_FORM`, which carries the `!ref`
  // repair — rather than also producing a schema violation that says only
  // "must be object" about the same node.
  anyOf: [{ $ref: manifestFragmentRef("JsonSchema7") }, { type: "string" }],
};

/** `params:` — a callable's ORDERED parameter list. Ordered because a call site
 *  is positional (`Alias.fn(a, b)`); named because `call(args)` hands the
 *  controller one object keyed by these names. Optional parameters are trailing
 *  (`FUNCTION_OPTIONAL_NOT_TRAILING`). */
const SIGNATURE_PARAMS_SCHEMA = {
  title: "Parameters",
  description: "Ordered parameters this callable accepts. Optional parameters come last.",
  type: "array",
  items: {
    type: "object",
    required: ["name", "schema"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      schema: signatureTypeSlot,
      // Shorthand for a union with `{type: "null"}` — for an argument that
      // genuinely IS null, as opposed to one that may be omitted.
      nullable: { type: "boolean" },
      optional: { type: "boolean" },
    },
    additionalProperties: false,
  },
};

/** `returns:` — what a call evaluates to. */
const SIGNATURE_RETURNS_SCHEMA = {
  title: "Result",
  description: "What a call to this callable evaluates to.",
  type: "object",
  required: ["schema"],
  properties: {
    description: { type: "string" },
    schema: signatureTypeSlot,
    nullable: { type: "boolean" },
  },
  additionalProperties: false,
};

/** `deterministic:` — the promise a NATIVE callable makes about code the runtime
 *  cannot inspect: the result depends only on the arguments and the instance's
 *  configuration. Absent means false. A body function never declares it; its
 *  determinism is derived from everything it calls. */
const DETERMINISTIC_SCHEMA = {
  title: "Deterministic",
  // No `type: boolean`: a non-boolean is `CALLABLE_DEFINITION_INVALID`, which
  // says what the value reads as and why, and the kernel refuses it under the
  // same rule. A schema type here would report the one mistake twice.
  description:
    "`true` when the result depends only on the arguments and this instance's configuration. Legal on a callable kind that declares its own `controllers:` (a claim) or on a callable abstract (a requirement every implementation must meet).",
};

/** Observed state a kind reports while running, as a data schema. `required:` is
 *  rejected separately by `validateObservedStateDeclarations`, which can say why
 *  and what to write instead. */
const observedStateSlot = {
  title: "Observed state",
  description:
    "What a resource of this kind reports while running, published at `resources.<name>.status.<field>`.",
  $ref: manifestFragmentRef("JsonSchema7"),
};

/** The `self`-only CEL scope a dispatch slot's name template is written in. */
const dispatchSelfContext = {
  type: "object",
  additionalProperties: false,
  properties: { self: { "x-telo-context-from-root": "schema" } },
};

/**
 * A `Telo.Definition` dispatch slot: which `resources:` entry receives the call.
 *
 * Three shapes, and the union is what keeps the slot CONSTRAINED for manifests
 * no pass walks — `validate-template-body` resolves the target and its
 * capability, but it is entry-scoped, so a dependency's definition would
 * otherwise have nothing checking this slot at all. An array or a number fails
 * every branch here, which is the floor AJV used to provide.
 *
 * `anyOf`, never `oneOf`: a `!ref` sentinel is an object, so it would match both
 * the sentinel branch and any permissive object branch and then fail for
 * matching twice. That is also how the sentinel used to pass — the legacy object
 * branch required nothing, so it accepted one by accident; here it is a branch
 * of its own that says so.
 */
function dispatchSlot(title: string, description: string): Record<string, unknown> {
  return {
    title,
    description,
    anyOf: [
      // `!ref <entry>` — the spelling to write.
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
      // Legacy: a name template expanded against `self`. Read forever, because
      // published artifacts carry it; `DEPRECATED_TEMPLATE_DISPATCH_FORM` is
      // what moves an author off it.
      { type: "string", "x-telo-context": dispatchSelfContext },
      // Legacy: `{ kind?, name }`, where `name` is that same template.
      {
        type: "object",
        required: ["name"],
        properties: {
          kind: { type: "string" },
          name: { type: "string", "x-telo-context": dispatchSelfContext },
        },
        additionalProperties: true,
      },
    ],
  };
}
import type { ResourceDefinition } from "@telorun/sdk";

/** Descriptive provenance a module declares about itself, shared by
 *  `Telo.Application` and `Telo.Library`.
 *
 *  These are *descriptive*, never *addressing* — nothing resolves, fetches,
 *  caches, or publishes based on them, so they do not conflict with
 *  identity-is-the-ref (which bans metadata from determining an artifact's
 *  location). `repository` is the location of the module's **source code**, in
 *  the same spirit as npm's `repository` / `license` / `homepage`. It is named
 *  `repository` rather than `source` because `source:` already means "where to
 *  fetch a dependency from" in the `imports` map.
 *
 *  A publish transport projects these into whatever its backend surfaces —
 *  OCI maps them onto the standard `org.opencontainers.image.*` annotations;
 *  the HTTP registry stores the manifest verbatim, so they are preserved as
 *  declared with nothing to translate. */
const PROVENANCE_METADATA = {
  description: { type: "string" },
  repository: { type: "string" },
  license: { type: "string" },
  documentation: { type: "string" },
};

/** The declared runtime requirements block, shared by `Telo.Application` and
 *  `Telo.Library` — the two module kinds, whose schemas are otherwise
 *  independent and would drift.
 *
 *  **Deliberately says only "these are objects", and nothing about the values.**
 *  The grammar belongs to `requires-block.ts`, which is the single reader, and
 *  every rule that matters — `^` and `~` refused, a bare version refused, bounds
 *  that must not exclude each other, an upper bound that must name a version that
 *  exists — needs a parse and a comparison, not a schema. Adding `type: "string"`
 *  here bought nothing and cost a duplicate: `telo: 80` then produced BOTH a
 *  `SCHEMA_VIOLATION` and a `REQUIRES_INVALID` for one node, one of them phrased
 *  by a layer that does not know what the value is for.
 *
 *  Left open at both tiers for the same reason. An unrecognized axis is reported
 *  by the reader with the vocabulary it knows — a far better message than AJV's —
 *  and, critically, is SUPPRESSED while the `telo` requirement is itself unmet,
 *  since an older runtime not knowing a newer axis is a consequence of the
 *  version skew rather than a second defect. AJV cannot express that ordering. */
const REQUIRES_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "object" },
  },
  additionalProperties: true,
};

/** Author-declared subset of `files:` that ships in the artifact's lazily
 *  materialized `assets` layer. Optional: an unclaimed file joins the `common`
 *  layer, which is pulled alongside any controller layer, so omitting this costs
 *  laziness rather than correctness. See kernel/specs/module-artifact.md. */
const ASSETS_FILES_SCHEMA = {
  type: "array",
  items: { type: "string" },
};

/** `exports.code` — the entry point a sibling module's controller bundle resolves
 *  this library's bare specifier to, one per format.
 *
 *  Data rather than a package URL: `controllers:` needs a PURL because it can name
 *  an ecosystem fetch (`pkg:npm`, `pkg:cargo`), while this always names a file the
 *  module already ships, so the type/namespace segments would be constant noise —
 *  and a query string is one opaque box to the visual editor. `format` plus the
 *  platform axes build the same `ArtifactSelector` a controller candidate does.
 *  Semantics and diagnostics live in `analyzer/nodejs/src/module-library.ts`. */
const LIBRARY_CANDIDATES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["specifier", "format", "path"],
    properties: {
      specifier: { type: "string" },
      format: { type: "string" },
      path: { type: "string" },
      source: { type: "string" },
      ...Object.fromEntries(PLATFORM_AXES.map((axis) => [axis, { type: "string" }])),
    },
    additionalProperties: false,
  },
};

/** `native:` — the module's platform-specific files, one entry per logical name
 *  per platform tuple. Closed, so a mistyped axis is a schema violation rather
 *  than a platform-neutral entry. Grammar and rules live in
 *  `analyzer/nodejs/src/native-entries.ts` and `validate-native-entries.ts`. */
const NATIVE_ENTRIES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["name", "format", "os", "arch", "path"],
    properties: {
      name: { type: "string" },
      format: { type: "string" },
      path: { type: "string" },
      ...Object.fromEntries(PLATFORM_AXES.map((axis) => [axis, { type: "string" }])),
    },
    additionalProperties: false,
  },
};

/** `sources:` — where every staged file comes from, keyed by source name, each
 *  entry keyed by the module-relative path it produces. Closed at every level.
 *  An entry is a file (`upstream` + `member`, pinned with `sha256` +
 *  `executable`) or a link (`target`); a mix of the two, and every other rule,
 *  is reported by `analyzer/nodejs/src/validate-source-entries.ts`. `archive`
 *  names the upstream's format. A source built in the repo names its build under
 *  `build`, keyed by build system (`cargo: <crate dir>`), with the digest of its
 *  build inputs (`inputs`). */
const SOURCES_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "object",
    required: ["version", "url", "archive", "notices", "entries"],
    properties: {
      version: { type: "string" },
      url: { type: "string" },
      archive: { enum: ["tar.gz"] },
      notices: { type: "array", minItems: 1, items: { type: "string" } },
      build: {
        type: "object",
        required: ["cargo"],
        properties: { cargo: { type: "string" }, inputs: { type: "string" } },
        additionalProperties: false,
      },
      entries: {
        type: "object",
        additionalProperties: {
          type: "object",
          anyOf: [{ required: ["upstream", "member"] }, { required: ["target"] }],
          properties: {
            upstream: { type: "string" },
            member: { type: "string" },
            sha256: { type: "string" },
            executable: { type: "boolean" },
            target: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

/** The published layer index, written by `telo publish` (never hand-authored).
 *  One entry per layer except the manifest layer, which cannot list its own hash
 *  inside itself and is pinned by the importer's `#sha256-...` instead. Shape and
 *  matching rules are normative in kernel/specs/module-artifact.md; the parser
 *  that enforces them is `artifact-layer-index.ts`. `role` stays open and
 *  `selector` unconstrained: an entry for a newer runtime is skipped, not
 *  rejected, and its selector is not examined (spec §3.1). A known role's
 *  selector is validated by the parser, which `telo check` runs. */
const LAYER_INDEX_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["role", "blob", "integrity"],
    properties: {
      role: { type: "string", minLength: 1 },
      selector: {},
      blob: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      integrity: { type: "string", pattern: "^sha256-[A-Za-z0-9_-]{43}$" },
    },
    additionalProperties: false,
  },
};

/** The pre-layers payload digest, superseded by the per-layer `integrity` values
 *  in `layers:`. Accepted and ignored, for one reason only: a module published in
 *  the old single-blob shape must reach the *actionable* failure — the controller
 *  loader's "republish the module" error — instead of dying earlier on
 *  `must NOT have additional properties`, which tells an author nothing. Nothing
 *  reads this field. */
const LEGACY_FILES_INTEGRITY_SCHEMA = { type: "string" };

/** The six named levels of `kernel/specs/logging.md` §5.1. The full 1–24 OTel
 *  range stays valid on the wire; only these are nameable in a manifest. */
const LOG_LEVEL_ENUM = ["trace", "debug", "info", "warn", "error", "fatal"];

const DURATION_PATTERN = "^\\s*\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*$";

/** Fields every sink kind inherits from `Telo.LogSink` (§12.1). A concrete sink
 *  kind may narrow a default but must not remove a field — a buffering policy
 *  that cannot be configured from the only permitted configuration source is
 *  not a policy. */
const LOG_SINK_COMMON_PROPERTIES = {
  level: { type: "string", enum: LOG_LEVEL_ENUM },
  buffer: { type: "integer", minimum: 1 },
  on_full: { type: "string", enum: ["block", "drop_new", "drop_old"] },
  flush_interval: { type: "string", pattern: DURATION_PATTERN },
};

/** Threshold / redaction / sampling — the fields an `imports:` entry may
 *  override for its subtree (§12.2). Deliberately excludes `sinks`: sinks are
 *  process-level I/O and belong to the root Application that owns the process,
 *  so an imported library can never open a log file on its importer's behalf. */
const LOGGING_SCOPE_PROPERTIES = {
  level: { type: "string", enum: LOG_LEVEL_ENUM },
  attributes: { type: "object" },
  redact: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" } },
      censor: { type: "string" },
      // Deletion destroys schema stability and hides that a field was present
      // at all, so §14 offers this but never as the default.
      remove: { type: "boolean" },
    },
    additionalProperties: false,
  },
  sampling: {
    type: "object",
    properties: {
      first: { type: "integer", minimum: 0 },
      thereafter: { type: "integer", minimum: 0 },
      tick: { type: "string", pattern: DURATION_PATTERN },
      sampleErrors: { type: "boolean" },
    },
    additionalProperties: false,
  },
};

/** The per-import `logging:` override. */
const IMPORT_LOGGING_SCHEMA = {
  type: "object",
  "x-telo-eval": "compile",
  properties: LOGGING_SCOPE_PROPERTIES,
  additionalProperties: false,
};

/** The root Application's `logging:` block — the scope fields plus `sinks`.
 *
 *  `x-telo-eval: compile` covers the whole block: every value resolves once at
 *  load, which is what lets a level come from the host environment through a
 *  `variables:` entry read with `!cel` rather than through a parallel
 *  `TELO_LOG_*` path that would be invisible to the analyzer and the editor
 *  (§12.3, D6). */
const ROOT_LOGGING_SCHEMA = {
  type: "object",
  "x-telo-eval": "compile",
  // Resolved while the application is loaded, before any resource — and so any
  // function — exists.
  "x-telo-unbound-calls":
    "the Application's logging: block is resolved when the application is loaded, before any resource — any function among them — has been created",
  properties: {
    ...LOGGING_SCOPE_PROPERTIES,
    // A list rather than a keyed map because sinks are root-only and therefore
    // never merged; with no merge to disambiguate, a list matches how Telo
    // spells every other ref-or-inline collection. `x-telo-inline` opts this one
    // slot into inline-resource extraction — see normalize-inline-resources.ts.
    sinks: {
      type: "array",
      items: {
        type: "object",
        // A sink is written to directly by the logging pipeline, never through
        // `ctx.invoke` — so from the Application's side it is held, not called.
        "x-telo-ref": { kind: "Telo.LogSink", use: "dependency" },
        "x-telo-inline": true,
      },
    },
  },
  additionalProperties: false,
};

/** A `Telo.Library`'s declared resource inputs — the instances it requires from
 *  whoever imports it, the inward half of the symmetry `exports.resources`
 *  already had outward. Each entry is constrained by KIND ONLY, through the same
 *  alias-qualified grammar `extends:` and `x-telo-ref` use; there is no `use:`,
 *  because the boundary is a dependency edge for init order whatever the library
 *  does with the instance. See `analyzer/nodejs/src/resource-input.ts`. */
const LIBRARY_RESOURCE_INPUTS_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  },
};

/** The importer's side of the same block: entry name → `!ref` to the instance
 *  supplied for it. Left open because the accepted KIND is declared by the
 *  target library, not by this schema — the constraint is checked by
 *  `validate-resource-inputs.ts`, which reads the target's declared block off
 *  the `metadata.requiredResources` stamp. */
const IMPORT_RESOURCE_INPUTS_SCHEMA = {
  type: "object",
  additionalProperties: {},
};

export const KERNEL_BUILTINS: ResourceDefinition[] = [
  { kind: "Telo.Abstract", metadata: { name: "Template", module: "Telo" } },
  // "Control can be transferred to this" — the parent of Invocable and Runnable,
  // and the only thing a slot that accepts either needs to say. It is a SLOT
  // CONSTRAINT, never a lifecycle role: `capability: Telo.Executable` is rejected
  // because it is absent from the kernel's `KNOWN_CAPABILITIES` enum, which is
  // what keeps "what a resource is" and "what a slot does with it" separate.
  //
  // `Telo.Service` is deliberately NOT under it. A Service's `run()` is a
  // lifecycle start the kernel dispatches differently (no ambient scope, so
  // inbound work roots its own trace), and admitting it here would make every
  // step's `invoke:` slot accept a service. Boot-target slots that genuinely take
  // `Runnable | Service` stay kind lists — the honest shape for a heterogeneous
  // set.
  { kind: "Telo.Abstract", metadata: { name: "Executable", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Runnable", module: "Telo" }, extends: "Telo.Executable" },
  { kind: "Telo.Abstract", metadata: { name: "Service", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Invocable", module: "Telo" }, extends: "Telo.Executable" },
  { kind: "Telo.Abstract", metadata: { name: "Mount", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Type", module: "Telo" } },
  // A function: `call(args)`, synchronous, reached from CEL through a module
  // name. Deliberately NOT under `Telo.Executable` — `call()` receives no
  // context, so no zone, cancellation or trace reaches it, and a step's
  // `invoke:` must refuse it. A callable publishes no reading either, so
  // `resources.<fn>` reads as absent.
  { kind: "Telo.Abstract", metadata: { name: "Callable", module: "Telo" } },
  {
    kind: "Telo.Abstract",
    metadata: { name: "Provider", module: "Telo" },
    schema: { "x-telo-eval": "compile" },
  },
  // The sink lifecycle role: attach, write a record, flush, detach. Deliberately
  // payload-opaque — it carries no filtering and no encoding — so a future
  // `Telo.TraceSink` reuses the same capability with a different record type.
  // Scoped to record-stream sinks; metrics aggregate rather than stream and are
  // not covered. See kernel/specs/logging.md §10.
  { kind: "Telo.Abstract", metadata: { name: "Sink", module: "Telo" } },
  // The abstract every *log* sink kind extends, carrying the log-specific
  // configuration. A kernel built-in resolvable without an import, so a sink
  // author depends on the kernel contract rather than on a standard-library
  // module version and kernel↔module skew never becomes a compatibility surface
  // for "where do logs go".
  {
    kind: "Telo.Abstract",
    metadata: { name: "LogSink", module: "Telo" },
    capability: "Telo.Sink",
    schema: {
      type: "object",
      properties: LOG_SINK_COMMON_PROPERTIES,
      additionalProperties: true,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "ConsoleSink", module: "Telo" },
    capability: "Telo.Sink",
    extends: "Telo.LogSink",
    schema: {
      type: "object",
      properties: {
        ...LOG_SINK_COMMON_PROPERTIES,
        destination: { type: "string", enum: ["stderr", "stdout"] },
        encoding: { type: "string", enum: ["auto", "pretty", "json"] },
        color: { type: "string", enum: ["auto", "always", "never"] },
      },
      additionalProperties: false,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "FileSink", module: "Telo" },
    capability: "Telo.Sink",
    extends: "Telo.LogSink",
    schema: {
      type: "object",
      properties: {
        ...LOG_SINK_COMMON_PROPERTIES,
        destination: { type: "string" },
        encoding: { type: "string", enum: ["json", "pretty"] },
      },
      required: ["destination"],
      additionalProperties: false,
    },
  },
  {
    // Telo.JsonSchema — the concrete data-shape kind, in the kernel rather than
    // in an installable module for the same reason the mandatory sinks are:
    // declaring a shape is not optional. Every kind with an invocation contract
    // needs one, so requiring an import to write `inputType:` would put a tax on
    // the one thing the contract wants authors to do more of — and a library
    // declaring a contract would have to import a module purely to describe
    // itself. `type.JsonSchema` remains as a deprecated alias of this kind.
    kind: "Telo.Definition",
    metadata: { name: "JsonSchema", module: "Telo" },
    capability: "Telo.Type",
    // Declared so the kind reads as controller-BEARING, which is what lets
    // another definition inherit it by delegation (`extends: Telo.JsonSchema`
    // with no controller of its own). The entry is never loaded from — the
    // kernel registers this controller directly at boot, before any lazy
    // resolution — it states truthfully who provides it.
    controllers: [{ runtime: "kernel", entry: "Telo.JsonSchema" }],
    schema: withSchemaFragments({
      type: "object",
      properties: {
        schema: {
          title: "Schema",
          description: "JSON Schema definition for the declared data type.",
          $ref: manifestFragmentRef("JsonSchema7"),
        },
        extends: {
          title: "Extends",
          description: "Parent type name or list of parent type names to inherit from.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        rules: {
          title: "Rules",
          description:
            "CEL-based business invariant rules. Each rule's condition must return true for valid data.",
          type: "array",
          items: {
            type: "object",
            properties: {
              condition: {
                type: "string",
                description:
                  "CEL expression evaluated with 'this' bound to the data. Must return true for valid data.",
                // Plain text evaluated as CEL against the value alone, wherever
                // the shape is validated — not in the module that declared it.
                "x-telo-unbound-calls":
                  "a type rule's condition is evaluated against the value alone, wherever the shape is checked, where no module's functions are bound",
              },
              code: {
                type: "string",
                description: "Machine-readable error code surfaced on validation failure.",
              },
              message: {
                type: "string",
                description: "Optional human-readable hint for the validation failure.",
              },
            },
            required: ["condition", "code"],
          },
        },
      },
      required: ["schema"],
      additionalProperties: false,
    }),
  },
  {
    // Telo.Function — the built-in callable kind for a function written in CEL,
    // in the kernel rather than an installable module for the reason
    // `Telo.JsonSchema` is: a module must be able to declare a function without
    // importing one to do it. It carries a signature and a body and nothing
    // else — native code is written as a callable `Telo.Definition` plus
    // instances, so there is one way to write a native function and no document
    // that is half kind, half instance.
    //
    // The schema is CLOSED, which is what makes `deterministic:` here a
    // SCHEMA_VIOLATION: a body's determinism is DERIVED from everything it
    // calls, so an author-written flag would be a second source of truth for a
    // fact the analyzer can already compute.
    kind: "Telo.Definition",
    metadata: { name: "Function", module: "Telo" },
    capability: "Telo.Callable",
    schema: withSchemaFragments({
      type: "object",
      properties: {
        params: SIGNATURE_PARAMS_SCHEMA,
        returns: SIGNATURE_RETURNS_SCHEMA,
        body: {
          title: "Body",
          // No `type:` — a CEL field's schema states what the expression
          // PRODUCES, and a body produces whatever `returns:` declares, which
          // differs per function. Checking the result against it is the
          // signature's job, not this field's.
          description: "The expression this function evaluates, over its parameters.",
          // The value it produces is the function's result, so it must satisfy
          // the signature's `returns:` — read through the one annotation that
          // names a result declaration, so nothing here knows what a function is.
          "x-telo-returns-from": "returns",
          // A body sees its PARAMETERS. The names come from `params:` through the
          // one annotation that reads an ordered parameter list, so nothing here
          // knows what a function is — a kind declaring a parameter list of the
          // same shape gets the same scope.
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            "x-telo-context-parameters-from": "params",
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    }),
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Abstract", module: "Telo" },
    capability: "Telo.Template",
    schema: withSchemaFragments({
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: true,
        },
        capability: { type: "string" },
        schema: kindSchemaSlot,
        status: observedStateSlot,
        // The callable signature, declared on a contract with no implementation.
        // `deterministic: true` here is a REQUIREMENT every implementation must
        // meet, checked like a covariant result.
        params: SIGNATURE_PARAMS_SCHEMA,
        returns: SIGNATURE_RETURNS_SCHEMA,
        deterministic: DETERMINISTIC_SCHEMA,
        throws: ABSTRACT_THROWS_SCHEMA,
      },
      required: ["metadata"],
      // Telo.Abstract is an extension point by design — it must accept forward-compatible
      // fields (e.g. inputType/outputType from the typed-abstracts plan) without requiring
      // the analyzer to enumerate them here.
      additionalProperties: true,
    }),
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Definition", module: "Telo" },
    capability: "Telo.Template",
    // Top-level shape stays open (`additionalProperties: true`) so this change
    // attaches x-telo-context annotations to known template-body fields without
    // tightening the Telo.Definition shape itself. The annotations drive
    // static CEL validation of expressions inside `resources:` / `invoke:` /
    // `run:` / `provide:` / top-level `inputs:` / top-level `result:` against
    // `self` (typed from `schema:`) and `inputs` (typed from `inputType:`,
    // falling back to the extends-declared abstract).
    //
    // `inputs:` and `result:` live as top-level siblings of `invoke:` / `provide:`,
    // matching how Run.Sequence steps factor dispatch from data. The dispatch
    // entry-point (`invoke` / `provide` / `run`) determines how `inputs`/`result`
    // are interpreted at runtime. See analyzer/nodejs/plans/template-internal-cel-validation.md.
    schema: withSchemaFragments({
      type: "object",
      additionalProperties: true,
      properties: {
        // The kind's own configuration contract. Declared as a slot for the
        // first time here: it was reachable only as an unnamed extra property,
        // so nothing could say what belonged in it — no completion inside a
        // `schema:` block, and a misspelled keyword surviving to a runtime
        // failure that named a different field.
        schema: kindSchemaSlot,
        status: observedStateSlot,
        // The callable signature and the native determinism claim. Declared here
        // so the editor offers them and so `x-telo-*` inside a signature is
        // walked; what a callable kind may actually carry is enforced by
        // `callableKindIssues` in both halves.
        params: SIGNATURE_PARAMS_SCHEMA,
        returns: SIGNATURE_RETURNS_SCHEMA,
        deterministic: DETERMINISTIC_SCHEMA,
        throws: THROWS_SCHEMA,
        resources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            // A `resources:` entry is a DECLARATION of another kind, so the
            // CEL inside it belongs to THAT kind: its `x-telo-context` regions
            // are rebased under this entry's path and take precedence (they are
            // deeper), which is what puts `inputs`, `item`, `request`, `steps`
            // and a `catch:`'s `error` in scope exactly where the nested kind
            // declares them — see `analyzer/nodejs/src/template-body.ts`.
            //
            // What stays here is `self` alone, in force throughout the entry:
            // it is how a body reaches the configuration its enclosing template
            // was given, and no nested kind knows about it. The four names that
            // used to sit beside it (`request` / `result` / `steps` / `error`)
            // were a fixed permissive stand-in for the nested kind's own
            // regions — which is why `error` was offered outside every `catch:`
            // while `inputs` and `item` were undefined wherever a body actually
            // reads them.
            "x-telo-context": {
              type: "object",
              additionalProperties: false,
              properties: {
                self: { "x-telo-context-from-root": "schema" },
              },
            },
          },
        },
        // A dispatch slot names the `resources:` entry that receives the call,
        // as `!ref <entry>` — the one spelling every reference in Telo has. The
        // string and `{ kind, name }` forms it used to admit (a CEL name
        // template matched against CEL-named entries) were the removed
        // reference object surviving in the one place nothing resolved it;
        // `validate-template-body` is what resolves this slot, so the schema
        // stays open here rather than reporting the same defect twice.
        invoke: dispatchSlot(
          "Invoke target",
          "The `resources:` entry whose `invoke()` this kind dispatches to, as `!ref <entry>`.",
        ),
        provide: dispatchSlot(
          "Provide target",
          "The `resources:` entry whose `invoke()` produces this provider's value, as `!ref <entry>`.",
        ),
        run: dispatchSlot(
          "Run target",
          "The `resources:` entry whose `run()` this kind dispatches to, as `!ref <entry>`.",
        ),
        // The template twin of an Application's boot sequence. Its shape is
        // `templateTargetProblems`' to check (shared with the kernel), so the
        // schema states none — a second check would report the same line twice.
        targets: {
          title: "Targets",
          description:
            "The `resources:` entries this kind starts, in order, when an instance runs — each as " +
            "`!ref <entry>`, each a Telo.Service or Telo.Runnable. Replaces `run:` when the kind " +
            "has more than one thing to start, such as a server and the poller beside it.",
        },
        // The named child stays persistent so the produced mount's routes can
        // `!ref` its siblings.
        mount: dispatchSlot(
          "Mount target",
          "The `resources:` entry (a Telo.Mount, e.g. an Http.Api) whose `register()` this kind delegates to, as `!ref <entry>`.",
        ),
        inputs: {
          type: "object",
          additionalProperties: true,
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
              inputs: { "x-telo-context-from-root": "inputType" },
            },
          },
        },
        result: {
          type: "object",
          additionalProperties: true,
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
              // Typed from the dispatch target's declared output: the slot
              // holds a `!ref` to a `resources:` entry, resolved to that
              // entry's kind (or its own `outputType`, where it narrows one).
              result: {
                "x-telo-context-from-ref-kind": ["provide#outputType", "invoke#outputType"],
              },
            },
          },
        },
        // `base:` ("super(...)") — construction mapping for an inherited
        // (concrete-`extends`) definition. Its CEL is evaluated once against
        // `self` (typed from this definition's `schema:`) to build the parent
        // kind's config. Same `self`-only scope as a resource body.
        base: {
          type: "object",
          additionalProperties: true,
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
            },
          },
        },
      },
    }),
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Import", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: true,
        },
        source: { type: "string" },
        integrity: { type: "string" },
        variables: { type: "object" },
        secrets: { type: "object" },
        resources: IMPORT_RESOURCE_INPUTS_SCHEMA,
        runtime: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        logging: IMPORT_LOGGING_SCHEMA,
      },
      required: ["metadata", "source"],
      additionalProperties: false,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Application", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            module: { type: "string" },
            ...PROVENANCE_METADATA,
          },
          required: ["name"],
          additionalProperties: true,
        },
        lifecycle: {
          type: "string",
          enum: ["shared", "isolated"],
          default: "shared",
        },
        targets: {
          // Boot targets form a step list: a later target reads an earlier one's
          // result as `steps.<name>.result`, exactly as a sequence step does, so
          // the same annotation types that context and drives the call-site
          // contract check.
          "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
          type: "array",
          items: {
            // A genuinely heterogeneous set stays a kind list: `Telo.Service` is
            // deliberately outside `Telo.Executable`, since a service's `run()`
            // is a lifecycle start the kernel dispatches without an ambient
            // scope.
            "x-telo-ref": { kind: ["Telo.Runnable", "Telo.Service"], use: "call" },
            anyOf: [
              { type: "string" },
              // Post-resolution shape that `resolveRefSentinels`
              // substitutes a `!ref <name>` sentinel into. The
              // adjacent `x-telo-ref` constraint governs the kind
              // check; this branch only admits the structural form so
              // AJV doesn't reject a resolved ref.
              {
                type: "object",
                required: ["kind", "name"],
                properties: {
                  kind: { type: "string" },
                  name: { type: "string" },
                },
                additionalProperties: true,
              },
              // Gated reference: run() a Runnable/Service only when the
              // `when` CEL guard holds. Discriminated by the `ref` key. `ref`
              // is a `!ref` that resolves to the `{ kind, name }` shape below.
              {
                type: "object",
                required: ["ref"],
                properties: {
                  ref: {
                    "x-telo-ref": { kind: ["Telo.Runnable", "Telo.Service"], use: "call" },
                    anyOf: [
                      { type: "string" },
                      {
                        type: "object",
                        required: ["kind", "name"],
                        properties: {
                          kind: { type: "string" },
                          name: { type: "string" },
                        },
                        additionalProperties: true,
                      },
                    ],
                  },
                  when: { type: "string" },
                },
                additionalProperties: false,
              },
              // Inline flat invoke step, discriminated by the `invoke` key —
              // THE dispatch site, shared with every `Run` step array rather
              // than restated here. Restating it is what made `retry:` a schema
              // error at boot while working one line away in a sequence: not a
              // decision about boot, just a copy that never grew the field.
              // Control flow (if/while/switch/try) is still not available here —
              // reach for Run.Sequence.
              // An expanded, stamped COPY. `builtins.ts` is not a manifest, so it
              // never passes through the loader's expansion — embedding the
              // fragment object itself would leave the nested `retry` as an
              // unresolved `$ref` with no `x-telo-fragment` stamp, which is
              // exactly what made LIVE_VALUE_RETRIED silently skip every boot
              // target. A copy, because this is a module-level singleton and
              // `resolveSchemaRefKinds` rewrites the `x-telo-ref` inside it.
              manifestFragment("InvokeStep"),
            ],
          },
        },
        include: {
          type: "array",
          items: { type: "string" },
        },
        // Files bundled alongside `telo.yaml` into the module's artifact —
        // controller bundles, static assets served by Http.Static, templates,
        // etc. Ordered `.gitignore`-style patterns resolved against the manifest
        // dir at publish time. Analyzer-only role: accept the field (the schema
        // is additionalProperties:false); the analyzer never reads the payload.
        files: {
          type: "array",
          items: { type: "string" },
        },
        assets: ASSETS_FILES_SCHEMA,
        native: NATIVE_ENTRIES_SCHEMA,
        sources: SOURCES_SCHEMA,
        layers: LAYER_INDEX_SCHEMA,
        filesIntegrity: LEGACY_FILES_INTEGRITY_SCHEMA,
        // Inline imports — name-keyed map sugar for separate `Telo.Import`
        // documents. The key is the PascalCase alias (the import's
        // `metadata.name`). Each value is either a bare source string
        // (shorthand for `{ source }`) or the full object form. The loader
        // desugars each entry into a synthetic `Telo.Import` before discovery;
        // authored `Telo.Import` docs keep working alongside this. See
        // analyzer/nodejs/src/inline-imports.ts.
        imports: {
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                required: ["source"],
                properties: {
                  source: { type: "string" },
                  integrity: { type: "string" },
                  variables: { type: "object" },
                  secrets: { type: "object" },
                  resources: IMPORT_RESOURCE_INPUTS_SCHEMA,
                  runtime: {
                    oneOf: [
                      { type: "string" },
                      { type: "array", items: { type: "string" } },
                    ],
                  },
                  // Threshold / redaction / sampling override for this import's
                  // subtree. Attached to the import rather than to a map keyed
                  // by module name because an alias is already uniqueness-
                  // enforced, while module names collide (§12.2, D9).
                  logging: IMPORT_LOGGING_SCHEMA,
                },
                additionalProperties: false,
              },
            ],
          },
        },
        // Application-level environment contract. Each entry layers `env:`
        // (required, names the source env var) and `default:` (optional, used
        // when the env var is unset) on top of an open JSON Schema property
        // schema. `type:` constrains the coercion rule applied to the raw env
        // string (scalars per-type; `object` / `array` via JSON.parse with the
        // matching top-level type). All other JSON Schema keywords are passed
        // through unchanged and applied to the coerced value via the standard
        // schema validator. See kernel/nodejs/src/application-env.ts.
        variables: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["env", "type"],
            properties: {
              env: { type: "string" },
              type: {
                type: "string",
                enum: ["string", "integer", "number", "boolean", "object", "array"],
              },
              default: {},
            },
          },
        },
        secrets: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["env", "type"],
            properties: {
              env: { type: "string" },
              type: {
                type: "string",
                enum: ["string", "integer", "number", "boolean", "object", "array"],
              },
              default: {},
            },
          },
        },
        // Inbound ports the Application listens on. A name-keyed map mirroring
        // `variables`: each entry binds a host env var (`env:`) that supplies a
        // port integer (implicitly typed `integer`, 1–65535), with an optional
        // `default:` used when the env var is unset. `protocol:` (default `tcp`)
        // selects the transport — the runner reads this list to know the
        // exposed ports before launch, and the analyzer brands the resolved
        // `ports.<name>` value (tcp → TcpPort, udp → UdpPort) for static wiring
        // checks. Application-only. See kernel/nodejs/src/application-env.ts.
        ports: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["env"],
            properties: {
              env: { type: "string" },
              protocol: {
                type: "string",
                enum: ["tcp", "udp"],
                default: "tcp",
              },
              default: { type: "integer", minimum: 1, maximum: 65535 },
            },
            additionalProperties: false,
          },
        },
        // Structured logging configuration. The manifest is the only
        // configuration source — there is no TELO_LOG_* variable and no logging
        // CLI flag — so a level derived from the host environment goes through a
        // `variables:` entry read with `!cel`. See kernel/specs/logging.md §12.
        logging: ROOT_LOGGING_SCHEMA,
        // The runtime range this module is verified against. See
        // `analyzer/nodejs/src/requires-block.ts`.
        requires: REQUIRES_SCHEMA,
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Library", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            module: { type: "string" },
            ...PROVENANCE_METADATA,
          },
          required: ["name"],
          additionalProperties: true,
        },
        variables: { type: "object" },
        secrets: { type: "object" },
        // How many times this library is instantiated in one application.
        //
        // `isolated` (the default) is what every published module was written
        // against: each import declaration builds its own child scope with its
        // own instances, so two libraries importing a third get two of
        // everything in it. `shared` makes the library a SINGLETON — every
        // import of it resolves to one instantiation, owned by the root and
        // torn down after everything that borrowed it.
        //
        // Default `isolated` rather than `shared` — the opposite of the
        // Application field's — because flipping it would silently collapse
        // every existing app's resource graph and turn per-import `variables:`
        // into a conflict. The `exports.kinds` precedent: private-by-default is
        // the better end state and still needs the ecosystem republished first.
        lifecycle: {
          type: "string",
          enum: ["shared", "isolated"],
          default: "isolated",
        },
        // The inward half of `exports.resources`: instances this library
        // requires from whoever imports it. Library-only — an Application is a
        // root with no importer, so it owns its instances outright.
        resources: LIBRARY_RESOURCE_INPUTS_SCHEMA,
        include: {
          type: "array",
          items: { type: "string" },
        },
        // Files bundled into the module's artifact — same semantics as the
        // Telo.Application `files` field above (a library may ship bundled
        // controllers, templates, migrations, seed data).
        files: {
          type: "array",
          items: { type: "string" },
        },
        assets: ASSETS_FILES_SCHEMA,
        native: NATIVE_ENTRIES_SCHEMA,
        sources: SOURCES_SCHEMA,
        layers: LAYER_INDEX_SCHEMA,
        filesIntegrity: LEGACY_FILES_INTEGRITY_SCHEMA,
        // Inline imports — same name-keyed map sugar as Telo.Application; the
        // loader desugars each entry into a synthetic Telo.Import. See the
        // Application schema above and analyzer/nodejs/src/inline-imports.ts.
        imports: {
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                required: ["source"],
                properties: {
                  source: { type: "string" },
                  integrity: { type: "string" },
                  variables: { type: "object" },
                  secrets: { type: "object" },
                  resources: IMPORT_RESOURCE_INPUTS_SCHEMA,
                  runtime: {
                    oneOf: [
                      { type: "string" },
                      { type: "array", items: { type: "string" } },
                    ],
                  },
                  // Threshold / redaction / sampling override for this import's
                  // subtree. Attached to the import rather than to a map keyed
                  // by module name because an alias is already uniqueness-
                  // enforced, while module names collide (§12.2, D9).
                  logging: IMPORT_LOGGING_SCHEMA,
                },
                additionalProperties: false,
              },
            ],
          },
        },
        exports: {
          type: "object",
          properties: {
            // Titled because these two ARE a library's public surface, and the
            // module graph draws them as the root's lists — where an Application
            // draws its boot targets. The view reads the title off the schema, so
            // naming them here is what keeps resource-kind knowledge out of it.
            kinds: { type: "array", title: "Exported kinds", items: { type: "string" } },
            // An entry is a bare name (`Db`, a locally-owned export) or a dotted `Alias.Name`
            // (re-export of the instance reached via this library's import aliased `Alias`,
            // under the name `Name`) — mirroring `exports.kinds`. `variables` / `secrets` are
            // reserved on the resources.<Alias> value-flow surface, so they may not be exported.
            resources: {
              type: "array",
              title: "Exported resources",
              items: { type: "string", not: { enum: ["variables", "secrets"] } },
            },
            code: LIBRARY_CANDIDATES_SCHEMA,
          },
          additionalProperties: true,
        },
        // The runtime range this module is verified against. See
        // `analyzer/nodejs/src/requires-block.ts`.
        requires: REQUIRES_SCHEMA,
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
];
