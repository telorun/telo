# Plan — Application-level `variables` / `secrets` sourced from env

Goal: let `Telo.Application` declare its env-var contract directly on the root manifest, so values land in the same `variables.X` / `secrets.X` CEL scope that Library importers already see. Today every real application writes a `Config.Env` resource and references it as `resources.AppConfig.port`; this plan folds that boilerplate into the Application doc.

Result for authors:

```yaml
kind: Telo.Application
metadata:
  name: my-api
  version: 1.0.0

variables:
  port:
    env: PORT
    type: integer
    minimum: 1024
    default: 3000
  logLevel:
    env: LOG_LEVEL
    type: string
    enum: [debug, info, warn, error]
    default: info

secrets:
  databaseUrl:
    env: DATABASE_URL
    type: string

targets: [Server]
---
kind: Http.Server
metadata: { name: Server }
port: !cel "variables.port"
---
kind: Sql.Connection
metadata: { name: Db }
url: !cel "secrets.databaseUrl"
```

Libraries are unchanged — they keep their pure-JSON-Schema `variables` / `secrets` and get values from importers. Only `Telo.Application` may carry an `env:` key per field; a Library manifest with `env:` on an entry is rejected at load time (Section 2). This closes the new env-binding path against Library use; the deprecated `Config.Env` kind remains importable for legacy uses (Section "Config.Env deprecation").

## Shape: per-field, not block-wrapped

`Telo.Application.variables.<name>` and `Telo.Application.secrets.<name>` extend the shape used by `Config.Env` entries today ([modules/config/telo.yaml:89-140](../../../modules/config/telo.yaml#L89-L140)) by adding object / array support:

- `env: <ENV_VAR_NAME>` — required. Names the source env var.
- `type: string | integer | number | boolean | object | array` — required. Drives env-string-to-typed coercion at load (scalars coerced per-type; objects and arrays via `JSON.parse` constrained to the matching top-level type).
- `default: <typed value>` — optional. Used when the env var is unset. A field with no `default:` and no env value at boot is a fatal load error.
- Any other JSON Schema keyword appropriate to the declared `type:` (`minimum`, `maximum`, `enum`, `pattern`, `format`, `multipleOf`, `properties`, `items`, `required`, `additionalProperties`, `oneOf`, `allOf`, …) — applied after coercion via the kernel's existing schema validator.

The `env:` key is the only thing that distinguishes Application entries from Library entries. Same block names (`variables`, `secrets`), same CEL access (`variables.X`, `secrets.X`) — just a different leaf schema based on which kind owns the block. The editor's Environment tab (Section 7) renders the Application shape as form rows and the Library shape as a read-only summary.

No wrapping `env:` block, no separate `variables:` JSON-Schema block alongside the env mapping: one declaration per logical input.

## Touch points

### 1. `Telo.Application` entry schema

Application entries layer two extra keys (`env:` required, `default:` optional) on top of an otherwise-open JSON Schema property schema. `type:` is required and constrains the kernel's coercion rules; every other JSON Schema keyword appropriate to the declared `type:` is allowed unchanged (`items`, `properties`, `required`, `additionalProperties`, `oneOf`, `allOf`, `anyOf`, `not`, numeric / string / array constraints, `enum`, `const`, `pattern`, `format`, …). The schema lives in [`analyzer/nodejs/src/builtins.ts:187-229`](../../../analyzer/nodejs/src/builtins.ts#L187-L229) as a TS object literal — written in YAML form here because that's how every other manifest schema in the repo is authored.

`variables` and `secrets` each take this shape (identical for both):

```yaml
type: object
additionalProperties:
  type: object
  required: [env, type]
  properties:
    env: { type: string }
    type:
      type: string
      enum: [string, integer, number, boolean, object, array]
    default: {}                          # typed value; validated against the entry's residual schema at init
  # All other JSON Schema keywords appropriate to the declared `type:` are allowed
  # (items, properties, required, additionalProperties, oneOf, allOf, anyOf, not,
  # enum, const, pattern, format, minimum/maximum, minLength/maxLength,
  # minItems/maxItems, uniqueItems, …). additionalProperties is NOT closed here —
  # Application entries are JSON Schema fragments first, with `env:` / `default:`
  # as the only kernel-recognised extras.
```

Object and array `type:` values are populated by JSON-decoding the env var's string value (see Section 3 and the polyglot spec). Use them when the manifest needs structured config from a single env var (`SERVER_TLS='{"cert":"…","key":"…"}'`, `ALLOWED_ORIGINS='["a","b"]'`).

### 2. `Telo.Library` entry schema

[`builtins.ts:230-266`](../../../analyzer/nodejs/src/builtins.ts#L230-L266) currently types `variables` / `secrets` as `{ type: object }` (fully open). **Leave it open.** Libraries receive values from importers as already-typed CEL values, so any JSON Schema property schema is valid — including object / array / `oneOf` shapes the Application form can't (and shouldn't try to) express through a single env var. Narrowing the Library shape to match Application would strip expressiveness Libraries already rely on.

The "no `env:` on Library entries" rule is enforced as a separate load-time validation rather than via the schema's `additionalProperties`. After AJV validates a Library manifest against the open shape, the loader walks `variables` / `secrets` entries and rejects any with an `env:` key, producing a diagnostic of the form:

```text
Telo.Library variables/<name>: `env:` is only permitted on Telo.Application entries.
Libraries must receive values from importers via the parent manifest's `variables` /
`secrets` block.
```

Keeping this check outside the schema lets the Library entry schema remain a pure JSON Schema property schema (which is how the analyzer, editor, and importer wiring already treat it) and produces a targeted error message instead of a generic "additional property" diagnostic.

### 3. Populate root `variables` / `secrets` from env

Root Application population currently happens in [`kernel/nodejs/src/kernel.ts:294-315`](../src/kernel.ts#L294-L315), and the comment on line 309-311 explicitly says *"Applications have no variables/secrets fields — those are a Library-only contract."* That line is now wrong; replace the comment block and add a new step that mirrors [`modules/config/nodejs/src/env-controller.ts:25-80`](../../../modules/config/nodejs/src/env-controller.ts#L25-L80):

**Residual schema** (used in both the steps below and the polyglot spec): the entry object with `env` and `default` keys stripped. `type:` is **kept** so the residual schema enforces the declared JSON top-level shape after coercion (especially important for object / array entries, where `JSON.parse` could produce a wrong-typed value and the residual schema is what catches it via the standard validator path). This is the single definition referenced everywhere else in this plan — the analyzer-side normalization (Section 4) and the runtime residual-schema validation (polyglot spec steps 2 and 4) must produce the same object.

For each `[name, entry]` in `manifest.variables ?? {}` and `manifest.secrets ?? {}`:

1. Read `raw = process.env[entry.env]`.
2. If `raw === undefined`:
   - If `entry.default !== undefined`: validate the default against the entry's residual schema and store it.
   - Else: collect an error `${name}: environment variable ${entry.env} is not set (no default)`.
3. Else: coerce `raw` per `entry.type` (see the coercion table in the polyglot spec below — string passthrough; integer; number; boolean; object / array via `JSON.parse` constrained to the matching top-level type), then validate against the residual schema. Collect any coercion or validation error keyed by `name`.

If any error was collected, throw `RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", …)` with one bullet per failure — the same aggregation shape `Config.Env` uses today. The error must land *before* any controller init runs, so it surfaces at `kernel.load()` / `kernel.boot()` time, not mid-init. Implementing this as a small `populateApplicationEnv(manifest, env)` helper in `kernel.ts` (called once between `setTargets` and the manifest loop) keeps the env-coercion logic out of every individual controller.

Then call `this.rootContext.setVariables(coercedValues)` / `setSecrets(coercedSecrets)` ([module-context.ts:105-116](../src/module-context.ts#L105-L116)) so the root module's CEL scope sees the typed values. Secrets pass through `collectSecretValues` ([module-context.ts:34](../src/module-context.ts#L34)) for redaction, same as Library-imported secrets do today.

The Node `populateApplicationEnv` helper is the first implementation of the "Polyglot spec" section below — the spec is the source of truth, and any other runtime reimplements against it, not against this helper.

### 4. Analyzer: typed `variables` / `secrets` from Application's new shape

[`analyzer/nodejs/src/kernel-globals.ts:62-63`](../../../analyzer/nodejs/src/kernel-globals.ts#L62-L63) calls `buildSchemaMapSchema(moduleManifest?.variables)` on the manifest's raw variables block. Today that block IS the JSON Schema property map (Library shape); under this plan, the Application shape's entries carry `env:` / `type:` / `default:` keys and CEL doesn't want those.

Add a normalization step that produces the **residual schema** defined in Section 3 (strip `env` and `default`; keep `type:` and every other JSON Schema keyword) for each entry before handing it to `buildSchemaMapSchema`. This must be the same residual-schema function the runtime helper in Section 3 uses — extract it into a single shared utility so the analyzer and the kernel cannot drift. For Library manifests the strip is a no-op. For Application manifests the result is a pure JSON Schema property map describing the coerced shape CEL sees at runtime — `port: { type: "integer", minimum: 1024 }`, not `port: { env, type, default, minimum }`. The same normalization works for object / array entries (`tls: { type: "object", properties: {...} }` after stripping `env` / `default`).

The function comment at [`kernel-globals.ts:25-35`](../../../analyzer/nodejs/src/kernel-globals.ts#L25-L35) updates to reflect that Application now contributes variables/secrets to the typed globals scope (today it falls back to Library; tomorrow Application is the primary source whenever present, with the same fallback).

### 5. CLAUDE.md

The `### kind: Telo.Application` section currently says:

> `variables` / `secrets` / `exports` are **forbidden** — an Application is a root with no parent to supply inputs. Use `env` for runtime config. If you want to export or accept variables/secrets, the file is a Library.

Replace with: variables / secrets ARE allowed on Application; their entries carry an `env:` mapping per field; `exports` remains forbidden (an application has no importer). Document the per-entry shape (`env`, `type`, `default`, plus JSON Schema constraints) and link the Config.Env analogue. The "Use `env` for runtime config" sentence stays — `env` (raw `process.env`) remains the escape hatch for keys the manifest doesn't pre-declare.

### 6. Module documentation

The Application-level env contract gets a documentation page colocated with where Telo.Application is documented (or a new page under the kernel docs if there isn't one yet — confirm during implementation). `Config.Env`'s documentation page stays but gains a "Deprecated — prefer Application-level `variables` / `secrets`" banner at the top with a link to the new page (see "Config.Env deprecation" below).

### 7. Telo editor — Environment tab

The Environment tab is a **run-configuration surface** for the editor's Run feature. It **never edits the manifest**: nothing in this tab writes back to `Telo.Application.variables` / `.secrets`. Its only purpose is to collect the env-var values the editor will export to `process.env` when the user launches the application from the editor — analogous to a Run/Launch configuration in other IDEs, scoped to the workspace.

The tab's shape is **derived** entirely from the Application's declared `variables` / `secrets` block: one row per declared entry. If the user wants a new variable, they edit the manifest (Source view); the tab re-renders. The tab itself has no add / rename / delete / type-change / constraints-edit controls.

Current state (verified during planning): the editor parses Application manifests through [`apps/telo-editor/src/loader/parse.ts:57-110`](../../../apps/telo-editor/src/loader/parse.ts#L57-L110) and exposes `variables` / `secrets` structurally on `ParsedManifest.metadata`, but no part of the editor renders those fields today. The Environment tab must be wired explicitly.

Scope for this plan:

- **Two grouped sections**: "Variables" and "Secrets", one row per entry declared in the Application manifest.
- **Each row displays (read-only, derived from the manifest)**:
  - The entry's **name** (`port`, `databaseUrl`, …).
  - The mapped **env var name** (`PORT`, `DATABASE_URL`, …).
  - The declared **type** (`string | integer | number | boolean | object | array`).
  - The entry's **default** if declared (muted hint).
  - A one-line **constraints summary** derived from the entry's residual schema (`min 1024`, `enum: debug, info, warn, error`, `array of string`, …).
- **Each row has one editable surface**: a **value input** holding the user-supplied value for the local Run feature. Type-aware: single-line for scalars, masked single-line for secrets, Monaco JSON pane for `object` / `array`. Inputs are validated client-side against the entry's residual schema (Section 3) so what the editor accepts is what the kernel will accept on launch.
- **Run wiring**: when the user invokes the editor's Run feature on an Application, the editor builds the child process's `env` from these values keyed by each entry's `env:` name. Empty / unset rows simply omit the var (the kernel then applies the manifest's `default:` or fails with the missing-required diagnostic from Section 3, exactly as if the user ran the manifest from a shell with no env set).
- **Storage**: entered values are persisted in the editor's existing workspace-local run-configuration store (whatever already holds per-workspace launch state — confirm during implementation). The manifest YAML on disk is untouched.
- **Secrets are visually distinct**: padlock icon, masked value input with a toggle, "redacted in logs" hint. Storage for secret values follows whatever the editor already uses for secret-like workspace state (env-flagged in the run-config store, OS keychain if that's the existing convention — confirm).
- **Validation surfacing**: residual-schema diagnostics for the entered value appear inline on the offending row. Manifest-level diagnostics (Section 2 / analyzer) appear on the Source view, not duplicated here.
- **Library manifests**: no Environment tab. Libraries are not runnable; the Run feature is Application-only, so there is no run-config surface to render for them.

Out of scope for the editor work in this plan: refactoring the existing Monaco / form components; redesigning the tab layout; any UI for editing the manifest's `variables` / `secrets` declarations (Source view continues to own that); building the editor's Run feature itself — this section assumes it already exists and only adds the env-var input surface that feeds it.

Touch points (confirm exact paths during implementation):

- `apps/telo-editor/src/components/environment-tab/*` — new tab component, read-only shape with value-input rows.
- `apps/telo-editor/src/loader/parse.ts` — surface the per-entry shape (`name`, `env`, `type`, `default`, residual schema) on `ParsedManifest.metadata` so the tab can render without re-parsing.
- Wherever the editor's Run feature builds its child-process environment — extend it to merge in the values held by this tab's run-config store, keyed by `entry.env`.

## Polyglot spec — env-var resolution

The kernel hosts the *spec* for env-sourced `variables` / `secrets`, not the implementation. Any non-Node kernel runtime (browser analyzer, future Go/Python kernels) implements this spec on top of its existing env-access primitive and JSON Schema validator — roughly ~30 lines plus the validator dependency.

For each `(name, entry)` in `Telo.Application.variables` (then `.secrets`), processed in declaration order:

1. **Lookup** — read `raw = host_env[entry.env]` using the host's native "unset" semantics (Node: `process.env[k] === undefined`).
2. **Unset path** — if `raw` is unset:
   - If `entry.default` is present: validate `default` against the entry's residual schema (definition in Section 3 — strip `env` and `default`, keep `type:`) and store it.
   - Else: collect error `"{name}: environment variable {entry.env} is not set (no default)"`.
3. **Coercion** — if `raw` is set, convert per `entry.type`:
   - `string`: identity.
   - `integer`: trim leading/trailing whitespace; require the trimmed value to match `^-?\d+$`; parse as signed 64-bit integer. On mismatch collect `"{name}: environment variable {entry.env}: value \"{raw}\" is not a valid integer"`.
   - `number`: parse as IEEE-754 double; reject NaN with the analogous message.
   - `boolean`: `"true"` → `true`; `"false"` → `false`; anything else is a coercion error.
   - `object`: parse `raw` as JSON. The parsed value must be a JSON object (`{...}`); any other JSON top-level type (number, string, array, …) is a coercion error: `"{name}: environment variable {entry.env}: expected JSON object, got {actual_json_type}"`. Parse failures collect `"{name}: environment variable {entry.env}: value is not valid JSON: {parser_message}"`.
   - `array`: parse `raw` as JSON; require a top-level JSON array (`[...]`). Mismatches and parse failures collect the analogous messages.
4. **Residual schema validation** — validate the coerced value against the residual schema using a JSON Schema draft 2020-12 validator. On failure collect `"{name}: {validator_message}"`.
5. **Aggregation** — after all entries are processed, if any errors were collected throw `ERR_MANIFEST_VALIDATION_FAILED` with one bullet per failure. This must surface before any resource controller's `init()` runs.
6. **Secret handling** — entries declared under `secrets:` resolve identically to variables but their resolved values must pass through the runtime's secret-redaction path (Node: `collectSecretValues` in [module-context.ts:34](../src/module-context.ts#L34)). Logging redaction is a runtime contract, not a kernel concern.

This is the entire kernel-hosted surface for env resolution. Everything else (JSON Schema validation, env access) is delegated to facilities every target runtime already has. The Node `populateApplicationEnv` helper in Section 3 is the spec's first implementation; future runtimes implement against the spec text, not against the Node helper.

## Config.Env deprecation

`Config.Env` is **deprecated**, not removed. The kind, its controller, its docs, and its existing tests all stay; Application-level `variables` / `secrets` becomes the recommended path. Deprecation is the lighter-touch move and preserves the cleaner polyglot story `Config.Env` already offers (its controller uses the runtime-agnostic SDK `ctx.env` surface, so any host language with the SDK gets the kind for free).

Deprecation touch points:

- `modules/config/telo.yaml` — mark the `Telo.Definition` for `Env` as deprecated. Add `deprecated: true` to the definition's metadata if/when the manifest schema accepts that key; until then add a `description:` prefix `"[Deprecated] "` and a doc cross-reference to the Application-level page.
- `modules/config/nodejs/src/env-controller.ts` — emit a single deprecation log line at `init()` (one per resource instance, not per env-var lookup): *"Config.Env is deprecated; prefer Telo.Application-level variables/secrets with an `env:` mapping. See &lt;docs link&gt;."* No behavioural change.
- `modules/config/docs/env.md` — add a "Deprecated" banner at the top of the page with a link to the new Application-level page. Keep the rest of the content so existing users have a reference until they migrate.
- `modules/config/tests/config-env.yaml` — keep as-is. The new `application-env-*.yaml` tests cover the new path; the existing test ensures the deprecated path still works.
- Existing `kind: Config.Env` usages stay functional. Migration to Application-level entries is recommended in the docs and changeset note but is not part of this change:
  - `examples/configurable-http-server.yaml` — keep, optionally add a follow-up example file showing the Application-level shape side-by-side.
  - `apps/registry/telo.yaml`, `apps/registry/tests/e2e/mcp-tools.yaml` — leave alone; migration can happen incrementally later.
- `@telorun/config` package takes a **minor** version bump (deprecation is additive). The changeset's description points readers at the new Application-level shape.

The `env:` key on Library `variables` / `secrets` entries is still rejected (Section 2). A Library that wants to read env via `Config.Env` can still do so — that's an existing pattern we're not closing here. The Section-2 rule closes the path that this plan introduces; broader Library-env isolation is a separate decision and not in scope.

## Tests

New tests in `kernel/nodejs/tests/` (or wherever module/import tests live — confirm at implementation time):

- `application-env-variables.yaml` — Application declares one variable and one secret with env mapping; targets assert the coerced values match expectations under fixed `PORT=1234` / `LOG_LEVEL=info` / `DATABASE_URL=postgres://…`. Mirrors [modules/config/tests/config-env.yaml](../../../modules/config/tests/config-env.yaml) but accessed as `variables.X` / `secrets.X` instead of `resources.AppConfig.X`.
- `application-env-missing-required.yaml` — variable with no default and unset env var must produce `ERR_MANIFEST_VALIDATION_FAILED` at `kernel.load()`, with the error message naming the field and env var. Verified via the test-suite's expected-failure mechanism.
- `application-env-coercion-failure.yaml` — env var set to a non-integer value for a `type: integer` field; expect the same error code with the coercion message.
- `application-env-schema-violation.yaml` — env var coerces successfully but violates `minimum:` / `enum:`; expect schema validation error with the field name.
- `application-env-object-array.yaml` — Application declares one `type: object` and one `type: array` variable with `properties:` / `items:` constraints; env vars hold JSON strings; targets assert the parsed values match the declared shape. Includes one negative case where the env var is valid JSON but the wrong top-level type (`expected array, got object`).
- `library-env-key-rejected.yaml` — Library manifest with `env:` on a variable entry must produce the targeted load-time diagnostic from Section 2.

The existing `modules/config/tests/config-env.yaml` stays — it pins the deprecated path's behaviour while it remains supported.

## Out of scope

- Adding richer mapping forms (`env: { from: PORT, when: …, transform: json }`, multi-source `env: [PORT, HTTP_PORT]`). The entry shape stays as defined in Section 1; future extensions land here once and propagate to every kernel runtime via the polyglot spec.
- `process.env` raw-map access — `env` in CEL stays available on the root module exactly as today, for keys the manifest hasn't pre-declared.
- Forced migration of existing `kind: Config.Env` consumers to Application-level entries. The deprecation surfaces the recommended path; migration is incremental.
- Broader "Libraries can never read host env" isolation. The plan closes the new path (`env:` on Library entries) but does not remove the pre-existing path of a Library importing `@telorun/config` and instantiating `Config.Env`. That's a separate decision.

## Changeset

Single changeset spanning `@telorun/kernel`, `@telorun/analyzer`, `@telorun/config`, `@telorun/telo-editor`. **Minor** bumps across the board — the change is additive (`Config.Env` is deprecated, not removed). Description: "Telo.Application accepts `variables` / `secrets` with per-field env-var mapping; values resolve at load time into the root `variables` / `secrets` CEL scope. The Telo editor's Environment tab renders these entries. `Config.Env` is deprecated in favour of the new shape; existing usages keep working."
