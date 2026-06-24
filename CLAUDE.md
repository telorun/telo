# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs `test-suite.yaml` which discovers all `tests/*.yaml` across the repo).
Tests should live in the module they test: `modules/<name>/tests/*.yaml`.
Test fixtures go in `__fixtures__/` subdirectories (excluded from test discovery).
Implementation plans should live in the package they affect the most, eg. `apps/telo-editor/plans/some-plan.md`.

Follow this strictly:

- **Do not create, edit, or delete any file until the user's latest message clearly authorizes the specific change you are about to make.** Authorization is a direct instruction to act now — to write, change, or remove something concrete. It is NOT: a question ("would X work?", "is this better?"), a critique or correction of a proposal, a request to compare or weigh options, or general discussion — none of these grant permission, no matter how positive. Agreeing that an idea is good is not the same as asking for it to be done. When the intent for you to act *now* is anything less than unambiguous, stay in proposal mode and ask: "Apply this?" This gate overrides Auto Mode and any "execute immediately" directive.
- **NEVER run `git commit`, `git commit --amend`, `git push`, or any other command that creates, rewrites, or publishes a commit — not even to make a check pass or "fix" state.**
- never add underscores to unused function arguments
- never look at commit history
- never use git stash
- never fix linting problems, and never mention it
- keep code comments very concise and add them only when necessary; prefer self-documenting code and module documentation
- if you cannot implement a feature in a way it was established or planned to be implemented, propose a new approach and ask for approval before implementing it
- never implement logic that swallows errors
- telo manifests MUST be type safe
- in telo manifests, ALWAYS write CEL with the `!cel "..."` YAML tag — never the inline `"${{ ... }}"` string form. The formatter normalizes to `!cel`, and the inline form gets mangled on round-trip (it has been silently rewritten into a broken `!ref`). This applies to every CEL value, including pure expressions and string interpolations (`!cel "'http://localhost:' + string(ports.http)"`).
- never use `cat` nor `sed` to read files — read them directly
- never use `AskUserQuestion` tool, ask questions directly
- never do major upgrades of modules nor packages
- never modify files in `dist` directories
- never use Bun-only APIs (e.g. `Bun.Glob`, `Bun.file`); all code must run on Node.js
- never make architectural decisions alone (package boundaries, dependency direction, where code lives), propose best fit and ask to choose from options
- UI primitives must use Radix (`radix-ui` package, same pattern as `apps/telo-editor/src/components/ui/*`); if a needed component isn't wrapped yet, install it via shadcn before rolling your own
- Icons must come from `lucide-react` (already a dep). No inline `<svg>` paths.
- When working on a plan, when a decision is made then remove the decision section entirely, not just mark it as decided. The plan should reflect the current state of the world, not a history of how we got here.
- `JS.Script` in manifests is a last resort. Before reaching for it, check whether the work belongs in a new generic stdlib resource (composes with the existing kind library, reusable across consumers, type-safe at the manifest level). A `JS.Script` is acceptable when (a) the logic is one-off and demonstrably not reusable, or (b) it bridges to a Node-specific API the kernel doesn't yet expose. In every other case, propose a new resource kind first and ask before adding inline JS.
- never add Docusaurus or any other rendering-tool annotations (`sidebar_label`, `sidebar_position`, `description`, etc.) to `README.md` files. Docusaurus-specific labels and ordering belong in `pages/sidebars.ts`; other markdown files under `docs/` may keep frontmatter where it's actually consumed.
- keep your communication very concise and to the point; avoid unnecessary preambles, or apologies. Focus on the task at hand and the specific changes being made. If you need to explain a complex decision, do so.

## Architecture

Telo is a declarative runtime: YAML manifests describe desired state, the kernel resolves resource dependencies via a multi-pass init loop, and controllers implement each resource kind. CEL expressions in `${{ }}` are compiled before execution.

**Scope: everything is on the table.** Telo is intended to support every transport, every protocol, every backend domain — HTTP, MCP, gRPC, WebSocket, message queues, databases, file I/O, AI providers, workflow engines, and whatever else lands. Design abstractions for breadth, not for the current consumer. When choosing between a generic primitive and a use-case-specific shortcut, **default to the generic primitive**. "We'll only need it for X" is the wrong question — assume any transport-neutral concept (encoders, codecs, streams, schedulers, retry policies, etc.) will eventually be reused across multiple modules, and shape the API and package layout accordingly. Do not YAGNI on cross-cutting primitives.

**Cross-cutting concerns Telo intends to cover** (non-exhaustive — when in doubt, assume it's in scope):

- **Data shape**: encoders, codecs, serialization (JSON, Protobuf, Avro, CBOR, MessagePack), validation, schemas, content negotiation, compression (gzip/brotli/zstd).
- **Streaming & I/O**: async iterators, channels, backpressure, chunked transfer, framing, multiplexing, file/stdio/network pipes.
- **Reliability**: retry / backoff, circuit breakers, timeouts, deadlines, idempotency, graceful shutdown, dead-letter queues.
- **Performance**: caching (response, query, computation), connection pooling, batching, rate limiting, throttling, debouncing, deduplication.
- **Observability**: structured logging (levels, sinks, correlation IDs), metrics (counters, gauges, histograms), distributed tracing (OpenTelemetry, spans, baggage), audit logs, profiling, health checks (liveness/readiness), alerting hooks.
- **Security**: authentication (OAuth, OIDC, API keys, JWT, mTLS, SAML), authorization (RBAC, ABAC, policy engines), secrets management (vault integrations, rotation), encryption at rest / in transit, signing/verification, CSRF/CORS.
- **Time & scheduling**: cron, intervals, delayed jobs, leases, time-zone handling, deadlines, clock skew tolerance.
- **Coordination**: distributed locking, leader election, queues (FIFO / priority), pub/sub, event sourcing, sagas / workflow orchestration, transactional outbox.
- **Configuration**: env, file, remote config, feature flags, dynamic reload, multi-tenancy, environment promotion.
- **Lifecycle**: migrations (DB, config, schema), versioning, rollouts, blue/green, canary, drain/shed.
- **Internationalization**: localization, pluralization, time-zone formatting, locale negotiation.
- **Inputs & boundaries**: pagination, filtering, sorting, partial responses, file uploads (multipart, chunked, resumable), webhooks (inbound + outbound), bulk operations.
- **Errors**: structured error contracts, error codes, retryable vs terminal classification, error mapping across boundaries, partial-failure aggregation.

When designing a new module or capability, ask: which of the above does this resource genuinely need to declare or compose with? If the answer touches more than one consumer, the concern belongs in a shared primitive (kernel built-in capability or transport-neutral package), not buried inside the current module.

**Topology-driven constraint:** The analyzer and telo editor must never hardcode knowledge about specific resource kinds. All resource-specific behaviour must be expressed via `x-telo-*` schema annotations in `Telo.Definition` schemas and resolved generically.

**Browser compatibility:** The `analyzer` package must be runnable in the browser without Node.js polyfills. Do not import Node.js built-ins (`fs`, `path`, `url`, `child_process`, etc.) from analyzer code. Node.js-specific adapters belong in the consuming package (kernel, IDE extension, CLI).

## Core goals

- **Polyglot architecture** — Telo must support controllers and runtimes in any language, not just Node.js
- **Visual editing** — Telo manifests must remain visually editable in a GUI editor; solutions must not break declarative structure or introduce constructs that can't be represented visually
- **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; solutions must not introduce unnecessary overhead
- **Static analysis** — YAML manifests must remain statically analyzable; solutions must preserve the ability to validate references, type-check CEL expressions, and detect errors without running the kernel
- **Developer friendly** — Errors must not be swallowed; they should be surfaced clearly to developers. Error messages must be actionable and informative, guiding developers to concrete place in YAML manifest that needs fixing.

## Monorepo Structure

- `kernel/nodejs/src/` — core runtime: orchestration, loading, controllers, init loop
- `cli/nodejs/` — CLI wrapper (`bin/telo.mjs`)
- `sdk/nodejs/src/` — public API for module authors (re-exports kernel contexts + capability interfaces)
- `modules/` — standard library: `http-server`, `http-client`, `sql`, `javascript`, `config`, `run`, `assert`, `test`, `console`, etc.
- `analyzer/nodejs/` — static manifest validator (schema checks, reference validation, CEL type-checking)
- `apps/telo-editor/` — desktop editor (React + Vite + Tauri)
- `ide/vscode/` — VS Code extension (YAML diagnostics via analyzer)
- `tests/` — integration tests (YAML manifests run via kernel)
- `examples/` — sample manifests

## Kernel Internals (`kernel/nodejs/src/`)

- `kernel.ts` — main orchestrator, boot sequence, multi-pass init loop, event bus
- `loader.ts` — YAML loading + CEL-YAML compilation; accepts `compileContext` param
- `evaluation-context.ts` — `EvaluationContext`, `ModuleContext` — variable/secret/resource scoping
- `resource-context.ts` — bridge: `getModuleContext()`, `registerModuleImport()`
- `module-context-registry.ts` — per-module store for variables, secrets, resources, imports
- `controller-registry.ts` — maps resource kinds to controller implementations
- `controllers/module/module-controller.ts` — handles `kind: Telo.Application` / `kind: Telo.Library` (includes, module scope)
- `controllers/module/import-controller.ts` — handles module imports (external modules, export CEL eval)
- `controllers/resource-definition/` — handles `kind: Telo.Definition` and parameterized templates
- `capabilities/` — base interfaces: runnable, invokable, listener, provider, template, mount
- `manifest-schemas.ts` — JSON Schema for YAML validation

## Resource Kinds

Every module file must start with exactly one `Telo.Application` OR `Telo.Library` doc. Applications are runnable entry points, Libraries are importable units of kinds/definitions. The two kinds share most fields; what differs is runtime role.

### `kind: Telo.Application`

A runnable entry point. Loaded via `Kernel.loadFromConfig` (directly, or by the test suite spawning a fresh kernel). **Never** imported — importing an Application is rejected at load time.

- `metadata.name` — kebab-case; becomes the kind prefix (e.g. `MyModule.*`)
- `metadata.namespace` — optional grouping prefix for `x-telo-ref` resolution
- `lifecycle` — `"shared"` (default) | `"isolated"`
- `keepAlive` — prevent kernel exit when idle
- `include` — array of file paths/globs to load as partial files into the same module scope; partial files must not contain `Telo.Application`, `Telo.Library`, `Telo.Import`, or `Telo.Definition`
- `imports` — name-keyed map declaring the module's dependencies. Each key is the PascalCase alias; each value is either a bare **source string** (`Console: std/console@0.9.0`, shorthand for `{ source }`) or the object form `{ source, variables?, secrets?, runtime? }`. The shared loader expands each entry into an internal import before resolution (gated by the `desugarImports` `LoadOptions` flag — on for the kernel's analysis + runtime loads, the import-controller's child load, the analyzer, and `telo check`; off for the editor's round-trip view, which reads the raw map). An alias declared twice in one module scope is a hard `DUPLICATE_IMPORT_ALIAS` diagnostic, not a silent shadow.
- `targets` — optional; run after all resources init. A flat boot sequence: each entry is a bare reference / `!ref` to a `Telo.Runnable` or `Telo.Service` (`run()`), a gated reference `{ ref, when? }`, or an inline invoke step `{ name?, invoke: <Invocable/Runnable ref>, inputs?, when? }`. Inline steps invoke the referenced resource via the shared `executeInvokeStep` leaf (SDK), with `steps.<name>.result` plumbed into later targets and `when`/`inputs` evaluated against the root scope. Ref-only — `invoke`/`ref` must be a `!ref` to a named resource (inline `{ kind }` definitions and `retry` are not supported here); control flow (`if`/`while`/`switch`/`try`), `with:` scopes, callable `inputs`/`outputs`, and `retry` stay in `Run.Sequence`. A no-targets Application is valid when its work is carried by Services that auto-start on init.
- Receives `env: process.env` when it is the root loaded manifest — raw `process.env` map for keys the manifest hasn't pre-declared.
- `variables` / `secrets` — each entry binds a name to a host environment variable via an `env:` key, plus `type:` (`string | integer | number | boolean | object | array`), optional `default:`, and any further JSON Schema keywords. Values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope (object / array values are JSON-decoded from the env var; missing required vars or coercion / schema failures aggregate into `ERR_MANIFEST_VALIDATION_FAILED` before any controller init).
- `ports` — **Application-only** name-keyed map of inbound ports the app listens on. Each entry binds a host env var via `env:`, plus optional `protocol:` (`tcp` default | `udp`) and `default:`; the value is implicitly a port integer (1–65535, no `type:`). Resolves at `kernel.load()` (mirroring `variables`, same `ERR_MANIFEST_VALIDATION_FAILED` aggregation) into the root `ports.X` CEL scope, so a binding resource reads `${{ ports.http }}` as the single source of truth and a runner knows the exposed ports before boot. The analyzer brands each value by `protocol` (`tcp → TcpPort`, `udp → UdpPort`) for static wiring checks (see `x-telo-type`). `Telo.Library` does not get `ports`.
- `exports` is **forbidden** — an Application is a root with no importer. If you want to export kinds, the file is a Library.

### `kind: Telo.Library`

An importable unit of kinds/definitions. Loaded **only** as an imported dependency (via an `imports:` entry). Cannot be run directly; `loadFromConfig` on a Library manifest is a hard error.

- `metadata.name` / `metadata.namespace` — as Application.
- `variables` / `secrets` — JSON Schema property map; public contract for importers.
- `include` — same semantics as Application.
- `imports` — same imports map as Application (a library may declare its own dependencies).
- `exports.kinds` — which kinds importers may reference (`kind: <Alias>.<Kind>`). Each entry is either a bare kind name (a locally-defined kind) or `<Alias>.<Kind>` to **re-export** a kind the library imports under alias `<Alias>`. Re-export is transitive to arbitrary depth and resolves in O(1) (`ModuleContext` exported-kind table; analyzer `resolveExportedKinds` + `metadata.reExportedKinds` stamping); the gate still rejects kinds not listed. A re-exported kind resolves to its true owning module's controller/definition — `kind: Api.Thing` where `Api` re-exports `Domain.Thing` runs `domain`'s `Thing` controller.
- `exports.resources` — the resource **instances** the library exports as ready-made singletons. Each entry is a **plain name string** (the `!ref` tag is rejected here): `<name>` exports a locally-owned instance; `<Alias>.<name>` **re-exports** the instance the library reached through its own import aliased `<Alias>`, under the name `<name>` — same grammar as `exports.kinds`. Importers reference any export across the boundary as `!ref <Alias>.<name>` (injected into ref slots / boot targets) and, for value-flow exports, read them in CEL as `${{ resources.<Alias>.<name> }}`. The gate is the list itself: only named instances are reachable. A library declares a local instance internally with `kind: Self.<Kind>` (see `Self` under `Telo.Definition`), so it can export a singleton of a kind it does **not** export (omit the kind from `exports.kinds` to forbid importers constructing their own — singleton enforcement). Independent of `exports.kinds`: export a kind, an instance, or both. **Re-export is transitive to arbitrary depth** (`app → api → domain → …`) and resolves in O(1) regardless of depth: each import builds a flattened export table that copies the owner's terminal getter by reference (`ModuleContext.buildExportTable`), and the analyzer forwards re-exports transitively (`forwardReExportManifests`) so `telo check` agrees with runtime. The owning instance is shared — every re-exporting hop resolves to the single instance, not a copy.
- **Resource names must contain no dot** (hard diagnostic `INVALID_RESOURCE_NAME`): a `!ref` value is split on its first dot to separate the import alias from the resource name (`Console.writeLine` → alias `Console`, name `writeLine`), so a dotted `metadata.name` would mis-resolve. This is the load-bearing invariant of the reference grammar — enforced, not just convention.
- `targets` is **forbidden**. `lifecycle` / `keepAlive` are also forbidden — libraries are not lifecycle participants.
- No `env` access.

### `imports`

Loads `Telo.Library` modules into the current scope under PascalCase aliases, declared as the `imports:` map on the `Telo.Application` / `Telo.Library` doc (see above). Each entry value is a bare source string or the object form `{ source, variables?, secrets?, runtime? }`. The CLI `install` / `upgrade` / `publish` commands read and rewrite this map.

- `source` — relative path / registry ref / URL; resolved to `telo.yaml` automatically.
- `variables` / `secrets` — values passed into the child library.
- Each import creates an isolated child `EvaluationContext`; child resources are not visible to root scope.
- Importing a `Telo.Application` is a hard error — applications are run directly, not imported.
- Only the root module gets `env: process.env`; child modules are isolated from the host environment.

### `kind: Telo.Definition`

Registers a new resource kind. Defined inline in a module's `telo.yaml`.

- `metadata.name` — kind suffix; full kind = `<module-name>.<Name>`
- `capability` — one of the kernel capabilities (see below). Names the lifecycle role only; never a user-declared abstract kind.
- `extends` — alias-form reference to a `Telo.Abstract` this definition implements (e.g. `Ai.Model`, `Self.Encoder`). The prefix must be an import alias declared in the same file (an `imports:` entry). **`Self`** is auto-registered as an alias pointing at the declaring library's own module name — use `Self.<Kind>` when the kind lives in the same `Telo.Library` as the definition (no import to alias against, since a self-import would loop the loader). `Self` resolves the library's own kinds **ungated** — independent of `exports.kinds`, which gates importers, not internal use. This is what lets a library declare an instance of a kind it does not export (`kind: Self.WriteLine`) so it can export the instance instead (see `exports.resources`). The kernel registers `Self` in each import's child context so `Self.<Kind>` resolves at runtime, not just in the analyzer.
- `controllers` — `pkg:npm` locator; `local_path` is a relative fallback for local development
- `schema` — JSON Schema with `x-telo-*` annotations
- `resources` / `invoke` / `run` / `provide` — template-internal bodies. `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (post-call mapping applied to the target's output, works with `invoke:` or `provide:`) live as **top-level siblings** on the definition, matching how Run.Sequence steps factor `{ name, inputs, invoke }`. CEL expressions inside these fields are statically validated against `self` (always — typed from this definition's `schema:`). The `inputs` CEL variable (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) is available inside `resources[].*` and the top-level `inputs:` sibling **only for invocable / runnable definitions** — provider definitions take no caller args (`provide()` is parameterless), so no `inputs` variable is exposed inside their bodies. Inside top-level `result:` the `result` variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared.

## Capabilities

- `Telo.Service` — `init()` + optional `teardown()`; long-lived servers, pools
- `Telo.Runnable` — `run()`; one-shot tasks, pipelines
- `Telo.Invocable` — `invoke(inputs)`; request handlers, scripts
- `Telo.Provider` — `init()` + optional `provide(): Promise<T>`; config/secret/value-flow sources. All fields implicitly `x-telo-eval: compile`. `provide()` opts the definition into the typed value-flow contract checked against the abstract's `outputType`; template-form providers (declared with `provide:` on a `Telo.Definition`) get a synthesized `provide()` automatically.
- `Telo.Mount` — mounted into a Service (e.g. HTTP APIs, middleware)
- `Telo.Type` — pure schema definition, no runtime instance

Defined as `Telo.Abstract` entries in `builtins.ts`.

## x-telo-\* Schema Annotations

Inside `Telo.Definition` schema blocks:

- `x-telo-eval: "compile" | "runtime"` — when `${{ }}` expressions are evaluated: at load time (compile) or per invocation (runtime). Without annotation, strings pass through raw.
- `x-telo-ref: "namespace/module-name#TypeName"` — field must be a reference to a resource of that capability/type. References are written **only** with the `!ref` YAML tag: `!ref <name>` (local) or `!ref <Alias>.<name>` (an imported library's exported instance). The object form `{ kind, name }` and bare-string references are removed — `validateReferenceForms` rejects an author-written `{ kind, name }` / string at a ref slot up front (`INVALID_REFERENCE_FORM`); a plain object at a ref slot is only ever an inline definition (`{ kind, …config }`, no `name`). At parse time `!ref` becomes a tagged sentinel; `resolveRefSentinels` rewrites it across the whole manifest tree to the internal `{ kind, name, alias? }` shape (Phase 2.5), the analyzer validates it at Phase 3, and Phase 5 replaces it with the live `ResourceInstance`. Per-call data (`inputs`, `retry`, …) lives at the parent slot, never inside a ref.
- `x-telo-scope: "/json/pointer"` — marks an execution scope; resources inside are initialized on-demand, not at boot. Controller receives a `ScopeHandle`.
- `x-telo-schema-from: "refProp/$defs/Name"` — derives field validation schema from a sibling `x-telo-ref` resource's definition schema. Used for polymorphic config.
- `x-telo-context: <JSON Schema>` — annotates a handler field with the CEL context available inside it. Analyzer-only; no runtime effect. Within a context schema, properties can carry:
  - `x-telo-context-from: "<path>"` — navigates `manifestItem.<path>` (per-scope) and merges the resolved value as a **property map** into the annotated node's properties. Used for transport scopes where the navigated value is itself a map of variable names (e.g. `request/schema` → `{ query, body, params, headers }`).
  - `x-telo-context-from-root: "<path>"` — navigates `manifestRoot.<path>` and **replaces** the annotated node's schema with the resolved value. Used on individual property schemas (e.g. `properties.self`) where the resolved value is a single variable's full schema. Anchoring at the root avoids the schema-vs-manifest-tree depth ambiguity that `../` parent-paths would carry.
  - `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema (e.g. `outputType` / `inputType`). Used to type `result` against the dispatched target's declared output shape.
  - `x-telo-context-ref-from: "<refProp>/<subpath>"` — existing form: reads a `{kind, name}` object from `manifestItem.<refProp>`, looks up the named manifest, returns its `<subpath>` field schema.
- `x-telo-step-context: { invoke, outputType }` — on an array field, tells the analyzer to build typed `steps.<name>.result` context from each item's invoked resource's output type.
- `x-telo-error-context: <JSON Schema>` — on an array field (e.g. a `catch:` / `finally:` branch), declares the schema of the `error` CEL variable in scope inside that field. Analyzer-only. Unlike `x-telo-context` (fixed-depth JSONPath scopes that don't resolve `$ref`), the analyzer collects these annotations across `$defs`/`$ref` and merges the `error` schema for any CEL whose path passes through the annotated field name (`<field>[<index>]`) — so it applies at arbitrary nesting depth (a `catch` inside a `try` inside a `catch`). `error.<typo>` becomes `CEL_UNKNOWN_FIELD`. Generic — no resource kind is hardcoded; any composer with error-bearing branches opts in by annotating them.
- `x-telo-widget: "code"` — on a string field, tells the telo editor to render a Monaco code widget instead of a single-line input. The language is resolved from the field's standard `contentMediaType` (e.g. `application/javascript`) via Monaco's own language registry, so adding a new language is purely a schema change — no editor code to touch.
- `x-telo-stream: true` — on a property in an `inputType` or `outputType` schema, marks it as carrying a `Stream<T>` (the class exported by `@telorun/sdk`). Producers wrap their `AsyncIterable` in `new Stream(...)` so the value's constructor is recognized — CEL's runtime type-checker rejects unrecognized object constructors, and the analyzer's `buildCelEnvironment` registers `Stream` so `${{ steps.X.result.output }}` evaluations pass through as opaque values. The analyzer's chain validator forbids member access _past_ a stream-marked property (`result.output` is fine; `result.output.text` / `result.output[0]` are diagnostics). Convention: streaming Invocables put their stream on the `input` property of `inputs` and the `output` property of the result. Consumers iterate with `for await`. Forward-compatible: today a boolean; later may evolve to `x-telo-stream: { items: <JsonSchema> }` for element-type validation under the typed-abstracts plan, with `true` aliasing to `{ items: any }`.
- `x-telo-type: "<Brand>"` — analyzer-only nominal value brand (e.g. `TcpPort`, `UdpPort`). Marks a value as a distinct CEL type even when its base type is identical (a `TcpPort` and a `UdpPort` are both integers), so wiring a `UdpPort` into a `TcpPort`-branded field is a static error. Standard JSON Schema keywords (`type`, `minimum`/`maximum`) still do the real validation; the brand carries only nominal identity and has no runtime effect (the value flows as its base type). Brands register on the analyzer's cloned CEL registry only, never the kernel runtime env. A plain base value flows into a branded field (gradual typing); only a conflicting brand is rejected. General mechanism — not port-specific; `ports` entries get their brand from `protocol` automatically.

## CEL Templates (`${{ }}`)

Pure expression: `"${{ variables.port }}"` → typed value. Inline: `"Hello ${{ variables.name }}!"` → string.

Available in `${{ }}`:

- `variables`, `secrets` — always available (module inputs)
- `ports.<name>` — root Application only; resolved inbound port integers (Application `ports` block)
- `resources.<name>` — after that resource's `snapshot()`
- `steps.<step>.result` — inside `Run.Sequence` steps
- `request` — inside handler CEL (HTTP: query, body, params, headers, path, method)
- `env` — only in root module (compile context)

**Null-safety:** dereferencing a value whose schema admits `null` (e.g. `error` inside a `finally` block, typed `["object","null"]`) without a null-guard is a static error (`CEL_NULLABLE_ACCESS`). The analyzer recognises guards through `?:` ternaries and `&&` / `||` short-circuits — `error != null && error.code`, `error == null ? … : error.code`. General: applies to any nullable value in any CEL context (`templating/nodejs/src/cel/analyze.ts` `findNullableAccessIssues`, wired in `engines/cel.ts`).

## Where to Look

- Runtime bug / init order → `kernel.ts`, `loader.ts`
- Module/import scoping → `evaluation-context.ts`, `module-context-registry.ts`, `import-controller.ts`
- New resource kind → add `Telo.Definition` to module's `telo.yaml`, controller in `src/`
- Schema validation errors → `manifest-schemas.ts`, `analyzer/nodejs/`
- x-telo-ref / scope / topology → `analyzer/nodejs/src/reference-field-map.ts`, `dependency-graph.ts`, `validate-references.ts`
- CEL type checking → `analyzer/nodejs/src/validate-cel-context.ts`, `cel-environment.ts`
- Test a manifest → add to `tests/`, run `pnpm run test`
- Controller CLI args → `kernel.ts` (`parseArgsForController`), `resource-context.ts`
- Test runner → `modules/test/nodejs/src/suite.ts`

## Module Documentation — MANDATORY

**Every module change MUST include documentation updates.** This is not optional. Before finishing any task that adds or modifies a module, verify:

1. Documentation exists in `modules/<name>/docs/`. If not, create it.
2. Documentation matches the current code. If code changed, docs must be updated.
3. New documentation files are wired into GitHub Pages (Docusaurus):
   - Add the file path to `pages/docusaurus.config.ts` in the `include` array
   - Add a sidebar entry in `pages/sidebars.ts`
   - Add `sidebar_label` frontmatter to the markdown file

## Versioning & releases — MANDATORY

**The whole repo is intentionally pre-1.0, and staying pre-1.0 is the goal.** Breaking changes are released as **minor** bumps on purpose — both `@telorun/*` npm packages and Telo modules. A documented breaking change shipped as a minor (or a module's `Added` fragment for a breaking change) is the convention working as designed, **never** a versioning defect. Do not flag "breaking change shipped as minor" in reviews. The CI guards (`check-no-major-module-bump`, the changeset major-bump guard) exist to *enforce* this — anything that would bump to 1.0.0 is the error, not the minor.

Two release tracks, split by artifact:

- **npm packages → changesets.** Every change to a published `@telorun/*` package MUST ship a changeset — CI gates on `pnpm changeset status --since=origin/main`. Add one file under `.changeset/` (one per logical change, listing every affected package) and `git add` it. Use `pnpm changeset add --empty` when a change genuinely needs no release.
- **Telo module manifests → changie.** A module's published version is `metadata.version` in `modules/<name>/telo.yaml`, owned by **changie** — language-agnostic, so Node, Rust, and manifest-only modules version identically. Bump a module by adding a changie fragment: `changie new --project <module>` (writes `.changes/unreleased/<id>.yaml`). The `.changes/` ledger is the source of truth — never hand-edit `metadata.version`. Modules are pre-1.0 — use `Added` (minor) / `Fixed` (patch); `Changed`/`Removed` auto-bump to 1.0.0 and are rejected by CI (`scripts/check-no-major-module-bump.mjs`), mirroring the changeset major-bump guard. A controller npm bump auto-generates its module's fragment (`scripts/version-packages.mjs`), so a Node controller change needs only the changeset. `.changie.yaml` is generated by `scripts/gen-changie-config.mjs` (re-run after adding/removing a module; CI checks it's committed). Registry publish is gated on `metadata.version` movement (`scripts/publish-packages.mjs`).

## Keep CLAUDE.md up to date

Sync this file after any significant architectural change.
