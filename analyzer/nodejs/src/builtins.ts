import { manifestFragment, manifestFragmentRef, withSchemaFragments } from "./manifest-schemas.js";

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

/** Observed state a kind reports while running, as a data schema. `required:` is
 *  rejected separately by `validateObservedStateDeclarations`, which can say why
 *  and what to write instead. */
const observedStateSlot = {
  title: "Observed state",
  description:
    "What a resource of this kind reports while running, published at `resources.<name>.status.<field>`.",
  $ref: manifestFragmentRef("JsonSchema7"),
};
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
      os: { type: "string" },
      arch: { type: "string" },
      libc: { type: "string" },
    },
    additionalProperties: false,
  },
};

/** The published layer index, written by `telo publish` (never hand-authored).
 *  One entry per layer except the manifest layer, which cannot list its own hash
 *  inside itself and is pinned by the importer's `#sha256-...` instead. Shape and
 *  matching rules are normative in kernel/specs/module-artifact.md; the parser
 *  that enforces them is `artifact-layer-index.ts`. */
const LAYER_INDEX_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["role", "blob", "integrity"],
    properties: {
      role: { type: "string", enum: ["controller", "library", "assets", "common"] },
      selector: {
        type: "object",
        required: ["format"],
        properties: {
          format: { type: "string" },
          os: { type: "string" },
          arch: { type: "string" },
          libc: { type: "string" },
        },
        additionalProperties: false,
      },
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
        resources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            // Resource bodies are `self`-only for config: per-call `inputs` is
            // NOT in scope here. Each entry is a persistent child created once at
            // init() and reused, so its config cannot depend on call-time data —
            // that flows through the top-level `inputs:` sibling into the dispatch
            // target's invoke().
            //
            // The exception is CEL the child's OWN controller evaluates later
            // against a runtime context it owns (e.g. an Http.Api evaluating route
            // CEL per request). Those `request` / `result` / `steps` / `error`
            // variables are deferred — the template controller preserves them
            // untouched (see resource-template-controller.ts) — so they are
            // exposed here permissively. Their deep shape is the child kind's
            // concern, not the template's, so they type as open values.
            "x-telo-context": {
              type: "object",
              additionalProperties: false,
              properties: {
                self: { "x-telo-context-from-root": "schema" },
                request: {},
                result: {},
                steps: {},
                error: {},
              },
            },
          },
        },
        invoke: {
          oneOf: [
            {
              type: "string",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  self: { "x-telo-context-from-root": "schema" },
                },
              },
            },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" },
                name: {
                  type: "string",
                  "x-telo-context": {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      self: { "x-telo-context-from-root": "schema" },
                    },
                  },
                },
              },
            },
          ],
        },
        provide: {
          type: "object",
          additionalProperties: true,
          properties: {
            kind: { type: "string" },
            name: {
              type: "string",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  self: { "x-telo-context-from-root": "schema" },
                },
              },
            },
          },
        },
        run: {
          type: "string",
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
            },
          },
        },
        // Mount dispatch: names the `resources:` entry (a Telo.Mount, e.g. an
        // Http.Api) whose `register()` this definition delegates to. Same
        // string / { kind, name } grammar as `invoke:`. The named child stays
        // persistent so the produced mount's routes can `!ref` its siblings.
        mount: {
          oneOf: [
            {
              type: "string",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  self: { "x-telo-context-from-root": "schema" },
                },
              },
            },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" },
                name: {
                  type: "string",
                  "x-telo-context": {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      self: { "x-telo-context-from-root": "schema" },
                    },
                  },
                },
              },
            },
          ],
        },
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
              result: {
                "x-telo-context-from-ref-kind": [
                  "provide/kind#outputType",
                  "invoke/kind#outputType",
                ],
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
            kinds: { type: "array", items: { type: "string" } },
            // An entry is a bare name (`Db`, a locally-owned export) or a dotted `Alias.Name`
            // (re-export of the instance reached via this library's import aliased `Alias`,
            // under the name `Name`) — mirroring `exports.kinds`. `variables` / `secrets` are
            // reserved on the resources.<Alias> value-flow surface, so they may not be exported.
            resources: {
              type: "array",
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
