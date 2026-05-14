# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs `test-suite.yaml` which discovers all `tests/*.yaml` across the repo).
Tests should live in the module they test: `modules/<name>/tests/*.yaml`.
Test fixtures go in `__fixtures__/` subdirectories (excluded from test discovery).
Implementation plans should live in the package they affect the most, eg. `apps/telo-editor/plans/some-plan.md`.

Follow this strictly:

- **NEVER edit, write, or modify any file until the user has typed an explicit trigger word in their most recent message: `fix`, `apply`, `update`, `implement`, `add`, `remove`, `go ahead`, or `do it`. This rule overrides Auto Mode and any "execute immediately" directive. Discussing options, proposing approaches, answering "would X be better?" questions, or receiving a critique is NEVER permission. When uncertain, ask: "Apply this?"**
- never add underscores to unused function arguments
- never look at commit history
- never use git stash
- never fix linting problems, and never mention it
- keep code comments very concise and add them only when necessary; prefer self-documenting code and module documentation
- never implement logic that swallows errors
- telo manifests MUST be type safe
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
- `controllers/module/import-controller.ts` — handles `kind: Telo.Import` (external modules, export CEL eval)
- `controllers/resource-definition/` — handles `kind: Telo.Definition` and parameterized templates
- `capabilities/` — base interfaces: runnable, invokable, listener, provider, template, mount
- `manifest-schemas.ts` — JSON Schema for YAML validation

## Resource Kinds

Every module file must start with exactly one `Telo.Application` OR `Telo.Library` doc. Applications are runnable entry points, Libraries are importable units of kinds/definitions. The two kinds share most fields; what differs is runtime role.

### `kind: Telo.Application`

A runnable entry point. Loaded via `Kernel.loadFromConfig` (directly, or by the test suite spawning a fresh kernel). **Never** the target of a `Telo.Import` — importing an Application is rejected at load time.

- `metadata.name` — kebab-case; becomes the kind prefix (e.g. `MyModule.*`)
- `metadata.namespace` — optional grouping prefix for `x-telo-ref` resolution
- `lifecycle` — `"shared"` (default) | `"isolated"`
- `keepAlive` — prevent kernel exit when idle
- `include` — array of file paths/globs to load as partial files into the same module scope; partial files must not contain `Telo.Application`, `Telo.Library`, `Telo.Import`, or `Telo.Definition`
- `targets` — optional; run after all resources init; must reference `Telo.Runnable` or `Telo.Service`. A no-targets Application is valid when its work is carried by Services that auto-start on init.
- Receives `env: process.env` when it is the root loaded manifest.
- `variables` / `secrets` / `exports` are **forbidden** — an Application is a root with no parent to supply inputs. Use `env` for runtime config. If you want to export or accept variables/secrets, the file is a Library.

### `kind: Telo.Library`

An importable unit of kinds/definitions. Loaded **only** as the target of a `Telo.Import`. Cannot be run directly; `loadFromConfig` on a Library manifest is a hard error.

- `metadata.name` / `metadata.namespace` — as Application.
- `variables` / `secrets` — JSON Schema property map; public contract for importers.
- `include` — same semantics as Application.
- `exports.kinds` — which kinds importers may reference.
- `targets` is **forbidden**. `lifecycle` / `keepAlive` are also forbidden — libraries are not lifecycle participants.
- No `env` access.

### `kind: Telo.Import`

Loads a `Telo.Library` into the current scope under a PascalCase alias.

- `source` — relative path / registry ref / URL; resolved to `telo.yaml` automatically.
- `variables` / `secrets` — values passed into the child library.
- Creates an isolated child `EvaluationContext`; child resources not visible to root scope.
- Importing a `Telo.Application` is a hard error — applications are run directly, not imported.
- Only root module gets `env: process.env`; child modules are isolated from the host environment.

### `kind: Telo.Definition`

Registers a new resource kind. Defined inline in a module's `telo.yaml`.

- `metadata.name` — kind suffix; full kind = `<module-name>.<Name>`
- `capability` — one of the kernel capabilities (see below). Names the lifecycle role only; never a user-declared abstract kind.
- `extends` — alias-form reference to a `Telo.Abstract` this definition implements (e.g. `Ai.Model`, `Self.Encoder`). The prefix must be a `Telo.Import` declared in the same file. **`Self`** is auto-registered as an alias pointing at the declaring library's own module name — use `extends: Self.<Abstract>` when the abstract lives in the same `Telo.Library` as the definition (no Telo.Import to alias against, since a self-import would loop the loader). Honours the library's `exports.kinds` list, so `Self.<Abstract>` only resolves to abstracts the library has chosen to export.
- `controllers` — `pkg:npm` locator; `local_path` is a relative fallback for local development
- `schema` — JSON Schema with `x-telo-*` annotations

## Capabilities

- `Telo.Service` — `init()` + optional `teardown()`; long-lived servers, pools
- `Telo.Runnable` — `run()`; one-shot tasks, pipelines
- `Telo.Invocable` — `invoke(inputs)`; request handlers, scripts
- `Telo.Provider` — `init()`; config/secret providers; all fields implicitly `x-telo-eval: compile`
- `Telo.Mount` — mounted into a Service (e.g. HTTP APIs, middleware)
- `Telo.Type` — pure schema definition, no runtime instance

Defined as `Telo.Abstract` entries in `builtins.ts`.

## x-telo-\* Schema Annotations

Inside `Telo.Definition` schema blocks:

- `x-telo-eval: "compile" | "runtime"` — when `${{ }}` expressions are evaluated: at load time (compile) or per invocation (runtime). Without annotation, strings pass through raw.
- `x-telo-ref: "namespace/module-name#TypeName"` — field must be a named reference to a resource of that capability/type. Validated at Phase 3; replaced with live `ResourceInstance` at Phase 5.
- `x-telo-scope: "/json/pointer"` — marks an execution scope; resources inside are initialized on-demand, not at boot. Controller receives a `ScopeHandle`.
- `x-telo-schema-from: "refProp/$defs/Name"` — derives field validation schema from a sibling `x-telo-ref` resource's definition schema. Used for polymorphic config.
- `x-telo-context: <JSON Schema>` — annotates a handler field with the CEL context available inside it. Analyzer-only; no runtime effect.
- `x-telo-step-context: { invoke, outputType }` — on an array field, tells the analyzer to build typed `steps.<name>.result` context from each item's invoked resource's output type.
- `x-telo-widget: "code"` — on a string field, tells the telo editor to render a Monaco code widget instead of a single-line input. The language is resolved from the field's standard `contentMediaType` (e.g. `application/javascript`) via Monaco's own language registry, so adding a new language is purely a schema change — no editor code to touch.
- `x-telo-stream: true` — on a property in an `inputType` or `outputType` schema, marks it as carrying a `Stream<T>` (the class exported by `@telorun/sdk`). Producers wrap their `AsyncIterable` in `new Stream(...)` so the value's constructor is recognized — CEL's runtime type-checker rejects unrecognized object constructors, and the analyzer's `buildCelEnvironment` registers `Stream` so `${{ steps.X.result.output }}` evaluations pass through as opaque values. The analyzer's chain validator forbids member access _past_ a stream-marked property (`result.output` is fine; `result.output.text` / `result.output[0]` are diagnostics). Convention: streaming Invocables put their stream on the `input` property of `inputs` and the `output` property of the result. Consumers iterate with `for await`. Forward-compatible: today a boolean; later may evolve to `x-telo-stream: { items: <JsonSchema> }` for element-type validation under the typed-abstracts plan, with `true` aliasing to `{ items: any }`.

## CEL Templates (`${{ }}`)

Pure expression: `"${{ variables.port }}"` → typed value. Inline: `"Hello ${{ variables.name }}!"` → string.

Available in `${{ }}`:

- `variables`, `secrets` — always available (module inputs)
- `resources.<name>` — after that resource's `snapshot()`
- `steps.<step>.result` — inside `Run.Sequence` steps
- `request` — inside handler CEL (HTTP: query, body, params, headers, path, method)
- `env` — only in root module (compile context)

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

## Changesets — MANDATORY

**Every change to a published package MUST ship a changeset** — CI gates on `pnpm changeset status --since=origin/main`. Add one file under `.changeset/` (one per logical change, listing every affected package) and `git add` it so the diff against `main` sees it. Use `pnpm changeset add --empty` when a change genuinely needs no release.

## Keep CLAUDE.md up to date

Sync this file after any significant architectural change.
