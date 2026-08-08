---
sidebar_label: Diagnostics reference
slug: /reference/diagnostics
description: Every diagnostic code the Telo analyzer and runtime can emit, what triggers it, and how to fix it.
---

# Diagnostics reference

Every code Telo can emit, with what triggers it and what to do. Look a code up
here — the message text contains your resource names, but the code is stable.

Telo reports problems in two places:

- **Static diagnostics** come from the analyzer — `telo check`, the
  [VS Code extension](/build/vscode), and the load pass of `telo run`. They
  carry an `UPPER_SNAKE_CASE` code, a file, and a line. Nothing has run yet.
- **Runtime errors** come from the kernel while loading, initializing, or
  dispatching. They carry an `ERR_*` code.

`telo check` exits `1` if any **error** is present; warnings alone do not fail
it.

For the workflow around all this — what the analyzer checks, what it cannot,
how to read a failure, and the debugging flags — see
[Catching errors before they run](/learn/static-analysis).

## Static diagnostics

### Kinds and definitions

| Code | What it means and what to do |
| --- | --- |
| `UNDEFINED_KIND` | No `Telo.Definition` for this `kind:`. Check the alias prefix matches an `imports:` entry, and that the spelling matches the module's exported kind. |
| `KIND_NOT_EXPORTED` | The alias resolves, but the target library does not list that kind in `exports.kinds`. It is private to that module — you cannot construct it. |
| `MISSING_KIND_OR_NAME` | Every resource doc needs `kind:` and `metadata.name`. |
| `DUPLICATE_RESOURCE_NAME` | Two resources in one module scope share a name; the kernel would fail with `ERR_DUPLICATE_RESOURCE`. Rename one. |
| `INVALID_RESOURCE_NAME` | A resource name contains `.`, which `!ref` uses to split alias from name. Remove the dot. |
| `EXTENDS_MALFORMED` | `extends:` must be the string form `<Alias>.<Kind>` (use `Self.<Kind>` for a kind in the same library). |
| `EXTENDS_UNKNOWN_TARGET` | The `extends:` target is not an exported kind of that alias. |
| `EXTENDS_CAPABILITY_MISMATCH` | A child declares a different `capability:` than its ancestor. Capability is inherited and immutable — omit it, or restate it identically. |
| `CAPABILITY_NOT_DECLARABLE` | `capability: Telo.Executable` — that name is an `x-telo-ref` slot constraint (the parent `Telo.Invocable` and `Telo.Runnable` extend), not a lifecycle role. Declare `Telo.Invocable` (invoke) or `Telo.Runnable` (run). |
| `CAPABILITY_SHADOWS_EXTENDS` ⚠️ | `capability:` names a user-declared abstract. Capability names a kernel lifecycle role; use `extends:` for a contract. |
| `PROVIDER_MISSING_IMPLEMENTATION` | A `Telo.Provider` definition needs either `controllers:` or a `provide:` body. |
| `SCOPE_ENTRY_NOT_INLINE` | Entries in an `x-telo-scope` block must be inline declarations (`kind:` + `metadata.name`), not references. |

### References

| Code | What it means and what to do |
| --- | --- |
| `UNRESOLVED_REFERENCE` | A `!ref` names a resource that does not exist in scope. Check spelling, and that a scoped name is used inside its scope. |
| `REFERENCE_KIND_MISMATCH` | The referenced resource's kind is not accepted by that slot. The slot's `x-telo-ref` constraint names what it takes; a child of that kind is also accepted. |
| `INVALID_REFERENCE_FORM` | A reference was written as a bare string or `{ kind, name }`. Write `!ref Name` or `!ref Alias.Name`. |
| `INVALID_REFERENCE` | A reference object is missing string `kind` / `name` fields. |
| `X_TELO_REF_UNRESOLVED` | A kind's own `x-telo-ref` constraint names nothing resolvable — a module-authoring bug, in the module that declares the slot. |
| `X_TELO_REF_LEGACY_IDENTITY` ⚠️ | The module uses the deprecated `"<namespace>/<module>#<Kind>"` ref form. Still resolves; the module should migrate to the alias form. |
| `X_TELO_REF_INVALID_USE` | A structured `x-telo-ref` carries an unrecognized `use` token (a typo would otherwise silently degrade to the legacy no-use reading), or a `use` case map whose `by` is not a JSON Pointer. Valid uses: `schema`, `dependency`, `call`, `detached`, `trigger.inbound`, `trigger.consumer`. |
| `X_TELO_REF_MISSING_USE` | The structured `x-telo-ref` form declares no `use`. Say what the declaring resource does with the target; only the legacy bare-string spelling may omit it. |
| `X_TELO_REF_MISSING_KIND` | A structured `x-telo-ref` declares no `kind`, so the slot constrains nothing and the editor has nothing to pick against. |
| `X_TELO_REF_USE_CONFLICT` | `anyOf` branches of one slot declare disagreeing `use`s. `use` is a property of the slot — declare the acceptable kinds as one `kind:` list with one `use`. |
| `X_TELO_REF_DYNAMIC_SELECTOR` | A `use` case map's selector field is written in CEL, so which `use` holds cannot be resolved statically. Write the mode as a literal (or rely on the schema default), or split the wiring into one resource per mode. |
| `MOUNT_TARGET_UNKNOWN` / `MOUNT_TARGET_NOT_MOUNTABLE` | A `mount:` names something that does not exist, or whose capability is not `Telo.Mount`. |
| `MOUNT_ON_NON_MOUNT` / `MOUNT_DISPATCHER_CONFLICT` | `mount:` used on a non-Mount definition, or alongside another dispatcher (`invoke:` / `provide:` / `run:`). |
| `PROVIDE_TARGET_UNKNOWN` / `PROVIDE_TARGET_NOT_INVOCABLE` / `PROVIDE_KIND_MISMATCH` | The `provide:` target is missing, not invocable, or its declared kind disagrees with the resolved one. |
| `PROVIDE_ON_NON_PROVIDER` / `PROVIDE_DISPATCHER_CONFLICT` | `provide:` on a definition that is not a `Telo.Provider`, or beside another dispatcher. |

### CEL

| Code | What it means and what to do |
| --- | --- |
| `CEL_SYNTAX_ERROR` | The expression does not parse. |
| `CEL_UNKNOWN_FIELD` | A property does not exist on the value's schema at that path. |
| `CEL_NULLABLE_ACCESS` | Dereferencing a value whose schema admits `null` without a guard. |
| `CEL_IN_NON_EVAL_FIELD` | The field is never evaluated, so the expression would be read as a literal. |
| `UNKNOWN_ENGINE` | A `!<tag>` names a templating engine that is not registered. |
| `UNUSED_DECLARATION` ⚠️ | A declared `variables.*` / `secrets.*` entry is referenced by no CEL expression. Usually a typo at the use site. |

### Invocation contracts

| Code | What it means and what to do |
| --- | --- |
| `CONTRACT_INPUTS_MISMATCH` | The `inputs:` at a call site do not satisfy the target's declared `inputType`. |
| `CONTRACT_MISSING_MAPPING` | A child that inherits a controller declared its own `inputType`/`outputType` but no `inputs:`/`result:` bridge, so the inherited controller would never see the mapped shape. |
| `CONTRACT_INPUTS_SCHEMA_FORM` | `inputs:` was written as a JSON-Schema property map. `inputs`/`outputs` are always **values**; `inputType`/`outputType` are always **schemas**. |
| `CONTRACT_TYPE_NOT_FOUND` | An `inputType`/`outputType` names a type that does not resolve. |
| `TEMPLATE_TARGET_MISMATCH` | A templated definition's body does not satisfy the target kind's contract. |
| `UNCOVERED_THROW_CODE` | The handler declares an error code that no `catches:` entry covers. |
| `UNDECLARED_THROW_CODE` | A `catches:` entry names a code the handler never throws — usually a typo. |
| `UNBOUNDED_UNION_NEEDS_CATCHALL` / `CATCHALL_NOT_LAST` | The throw union could not be enumerated, so `catches:` needs a catch-all; and a catch-all must come last. |
| `INHERIT_WITHOUT_STEP_CONTEXT` | An inherit/passthrough resolution was used where no step context exists to inherit from. |

### Modules, imports, and exports

| Code | What it means and what to do |
| --- | --- |
| `DUPLICATE_IMPORT_ALIAS` | An alias is declared twice in one module scope. Aliases never shadow — rename one. |
| `MODULE_VERSION_CONFLICT` | One module is imported at incompatible major versions. Align the pins. |
| `MODULE_VERSION_HOISTED` ⚠️ | One identity imported from two sources whose contents differ; one won. Align them to be sure which. |
| `INVALID_EXPORT` | `exports.resources` entries are plain name strings (`Name` or `Alias.Name`) — not `!ref`. |
| `LIBRARY_ENV_KEY_REJECTED` | `env:` is only valid on a `Telo.Application`. A library receives values from its importer. |
| `MANIFEST_PARSE_FAILED` | The YAML itself did not parse. |

### Schemas and types

| Code | What it means and what to do |
| --- | --- |
| `SCHEMA_VIOLATION` | The resource does not match its kind's schema — usually an unknown or misspelled field, since kind schemas are closed. |
| `SCHEMA_COMPILE_ERROR` | A definition's `schema:` is not valid JSON Schema. |
| `DUPLICATE_SCHEMA_ID` | A type name collides with a kind name in the same module. |
| `SCHEMA_TYPE_REF_UNKNOWN_ALIAS` / `SCHEMA_TYPE_REF_UNRESOLVED` | A schema `$ref` names an unknown alias, or a module that does not declare that type. |
| `INVALID_SCHEMA_FROM` / `SCHEMA_FROM_MISSING_PATH` | An `x-telo-schema-from` annotation is malformed or points at an unresolvable anchor. |
| `DEPENDENT_SCHEMA_MISMATCH` | A value does not match the schema derived from a sibling reference. |
| `BASE_UNKNOWN_FIELD` / `BASE_MISSING_REQUIRED` / `BASE_SCHEMA_MISMATCH` | A `base:` construction mapping sets a field the parent kind does not have, omits one it requires, or supplies the wrong shape. |

### Observed state

| Code | What it means and what to do |
| --- | --- |
| `OBSERVED_STATE_IN_STARTUP_FIELD` | `resources.<n>.status.*` was read in a field that resolves before anything runs. Observed state exists only once the resource has started. |
| `OBSERVED_STATE_NEVER_RUN` | The producer of that status can never start — it is in no `targets:` and named by no step's `invoke:`. |
| `OBSERVED_STATE_REQUIRED_FORBIDDEN` | `required:` is not allowed inside `status:` — every declared field is mandatory once running; a sometimes-absent one is declared nullable. |

### Controllers, logging, artifacts

| Code | What it means and what to do |
| --- | --- |
| `CONTROLLER_INVALID_SELECTOR` / `CONTROLLER_UNKNOWN_QUALIFIER` | A controller PURL's platform selector or qualifier is malformed. |
| `INVALID_LAYER_INDEX` | The published `layers:` index is malformed. |
| `INVALID_REDACTION_PATH` | A `logging.redact.paths` entry does not parse. Bad paths are caught here rather than silently failing to redact at runtime. |
| `LOG_SINK_ON_FULL_UNSUPPORTED` | The sink does not support the requested `on_full:` policy. |

⚠️ = warning; everything else is an error.

## Runtime errors

### Load and validation

| Code | What it means and what to do |
| --- | --- |
| `ERR_MANIFEST_VALIDATION_FAILED` | A declared `variables:` / `secrets:` / `ports:` entry is missing from the environment or failed coercion. All failures are aggregated before any controller initializes. |
| `ERR_RUNTIME_INVALID` | An import's `runtime:` is neither a string nor an array of strings. |
| `ERR_CIRCULAR_DEPENDENCY` | An imported library's resource graph contains a cycle. |
| `ERR_INVALID_EXPORT` / `ERR_INVALID_REEXPORT` | A library's `exports.resources` entry is malformed, or re-exports through an alias it never imported. |

### Initialization

| Code | What it means and what to do |
| --- | --- |
| `ERR_RESOURCE_INITIALIZATION_FAILED` | The multi-pass init loop gave up. It reports by **root cause**, not by count: resources that never ran because a dependency failed are classified as *derived* and attributed to the entry that actually broke, so the resource in the headline is the one to fix. Failures inside an imported library nest under that import. See [Resource lifecycle](/reference/kernel/resource-lifecycle). |
| `ERR_LOCAL_REF_PENDING` / `ERR_CROSS_MODULE_REF_PENDING` | A deferral, not a failure: this resource never ran because a dependency (local, or in an import) was not ready. It is always attributed to a real root cause. |
| `ERR_DUPLICATE_RESOURCE` | Two resources registered under one name. |
| `ERR_REF_REQUIRED` / `ERR_REF_UNRESOLVED` | A required reference slot is empty, or its `!ref` did not resolve to a live instance. |
| `ERR_SCOPE_RESOURCE_NOT_FOUND` | A cross-module `!ref Alias.name` did not resolve to an instance the library exports. Check `exports.resources`. |
| `ERR_SCOPE_ENTRY_NOT_INLINE` | A scope block entry is a reference rather than an inline declaration. |
| `ERR_VISIBILITY_DENIED` | A resource referenced boot context it was not granted. |
| `ERR_KERNEL_STATE_INVALID` | A kernel operation was called out of order (embedding the kernel directly). |

### Dispatch

| Code | What it means and what to do |
| --- | --- |
| `ERR_RESOURCE_NOT_FOUND` | Dispatch target does not exist. The message lists what is available — a scoped resource registered into the wrong context is the usual cause. |
| `ERR_RESOURCE_NOT_INVOKABLE` / `ERR_RESOURCE_NOT_RUNNABLE` | The target exists but has no `invoke`/`run`. Check the kind's capability against the slot. |
| `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` | The values passed to, or produced by, a call do not satisfy the declared `inputType`/`outputType`. Raised as structured errors, so they can be caught — but never declared by a kind. |
| `ERR_CONTRACT_UNRESOLVABLE` | A declared contract could not be resolved to a schema. |
| `ERR_INVOKE_CANCELLED` | The invoke was cancelled — a shutdown signal, a disconnected client, or an elapsed deadline. |
| `ERR_EXECUTION_FAILED` | A dispatch failed; the underlying error is attached as its cause. |
| `ERR_INVALID_VALUE` | A resource reference string is not `<Kind>.<Name>`. |
| `ERR_TYPE_NOT_FOUND` / `ERR_TYPE_VALIDATION_FAILED` | A named type is not in the registry, or its rule evaluation threw. |
| `ERR_NETWORK_UNREACHABLE` | An outbound fetch could not reach its host. |
| `ERR_FATAL` | Unrecoverable — re-thrown immediately rather than retried by the init loop. |

### Observed state

| Code | What it means and what to do |
| --- | --- |
| `ERR_OBSERVED_STATE_BEFORE_START` | `ctx.setStatus()` was called before the resource started. `init()` performs no I/O, so nothing is observed there. |
| `ERR_OBSERVED_STATE_UNDECLARED` | The kind declares no `status:` block. |
| `ERR_OBSERVED_STATE_INVALID` | The reported value does not match the declared `status:` schema. |
| `ERR_OBSERVED_STATE_KEY_COLLISION` | A kind that declares `status:` also returned a flat `status` field. |
| `ERR_OBSERVED_STATE_UNAVAILABLE` | A read of `status.<field>` that cannot be answered — not started, still running, or run without reporting that field. The message says which. |

### Controllers and artifacts

| Code | What it means and what to do |
| --- | --- |
| `ERR_CONTROLLER_NOT_FOUND` | No controller candidate could be loaded for the kind, on this host. |
| `ERR_CONTROLLER_NOT_LOADED` | A kind resolved but its controller was never registered. |
| `ERR_CONTROLLER_INVALID` | The controller bundle loaded but has no such export — a module packaging bug. |
| `ERR_CONTROLLER_BUILD_FAILED` | Building a controller from source failed (the build's own error follows). |
| `ERR_MODULE_LAYER_INTEGRITY` | A layer's contents do not hash to the digest the pinned manifest records. Treat as tampering or corruption; see [Security](/deploy/security). |
| `ERR_MODULE_LAYER_INVALID` / `ERR_MODULE_FILES_UNAVAILABLE` | A layer contains an illegal entry, or a module-relative file was requested from an artifact that ships no payload — usually a module published before layered artifacts. Republish it. |

### Shutdown

| Code | What it means and what to do |
| --- | --- |
| `ERR_TEARDOWN_FAILED` | One or more resources threw during teardown. The cascade still completed — failures are aggregated, not fatal to the rest. |

## See also

- [Catching errors before they run](/learn/static-analysis) — the workflow, the
  debugging flags, and what static analysis can and cannot find.
- [Running in production](/deploy/production) — exit codes and signal handling.
- [Resource lifecycle](/reference/kernel/resource-lifecycle) — init ordering and
  failure classification.
- [Style guide](/guides/style-guide) — naming rules that prevent a whole class
  of these.
