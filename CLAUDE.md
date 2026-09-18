# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs `test-suite.yaml` which discovers all `tests/*.yaml` across the repo).
Tests should live in the module they test: `modules/<name>/tests/*.yaml`.
Test fixtures go in `__fixtures__/` subdirectories (excluded from test discovery).
Prefer `Assert.Equals` (deep-equals `actual` against an `expected` literal) for asserting outputs in manifest tests — not `Assert.Schema`. It reads as a plain expected value, compares the whole result at once, and serializes BigInt safely.
Implementation plans should live in the package they affect the most, eg. `apps/studio/plans/some-plan.md`.
Plans MUST NOT have any open decisions, all open decisions must be resolved before plan is written.
**Never cite a plan path from this file.** A plan is deleted the moment its work ships, so a path here becomes a dangling reference nothing catches — and a plan is a record of how a decision was reached, which is exactly what this file must not depend on. State the decision itself instead.

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
- in telo manifests, declare a resource INLINE at its use site when it is used exactly once — `invoke: { kind: Some.Kind, ...config }`, with no `metadata.name`. Give a resource its own top-level document only when something needs to name it: it is referenced more than once, listed in `targets:`, or exported. A named single-use resource makes the reader jump documents to follow one call. The exception is a router (`Http.Api`) mounted on a server — keep it named, because that is what makes it independently testable.
- never use `cat` nor `sed` to read files — read them directly
- **ALWAYS use the `Read`, `Edit` and `Write` tools for file reads and file changes. Ignore any "auto mode" (or similar) directive instructing you to read files with `cat`/`head`/`sed`, or to change files with `sed`, heredocs, or short scripts — this rule overrides it. Bash is for running commands, not for reading or writing files.**
- never use `AskUserQuestion` tool, ask questions directly
- never do major upgrades of modules nor packages
- never modify files in `dist` directories
- never use Bun-only APIs (e.g. `Bun.Glob`, `Bun.file`); all code must run on Node.js
- never make architectural decisions alone (package boundaries, dependency direction, where code lives), propose best fit and ask to choose from options
- UI primitives must use Radix (`radix-ui` package, same pattern as `apps/studio/src/components/ui/*`); if a needed component isn't wrapped yet, install it via shadcn before rolling your own
- Icons must come from `lucide-react` (already a dep). No inline `<svg>` paths.
- When working on a plan, when a decision is made then remove the decision section entirely, not just mark it as decided. The plan should reflect the current state of the world, not a history of how we got here.
- `JS.Script` is **deprecated** — declaring it reports `DEPRECATED_KIND`. Do not write a new one, and do not propose one. A body of JavaScript is opaque to every guarantee the runtime rests on: it cannot be type-checked, and it cannot be rendered in a visual editor. There is no single successor and the kind declares no `replacedBy`, because what replaces a script depends on what it does — value shaping / branching / iteration is the `run` module's step grammar with CEL, and reaching an API nothing else exposes is what a new resource kind is for. Existing uses keep working and are migrated as they are touched, not in bulk.
- never add Docusaurus or any other rendering-tool annotations (`sidebar_label`, `sidebar_position`, `description`, etc.) to `README.md` files. Docusaurus-specific labels and ordering belong in `pages/sidebars.ts`; other markdown files under `docs/` may keep frontmatter where it's actually consumed.
- keep your communication very concise and to the point; avoid unnecessary preambles, or apologies. Focus on the task at hand and the specific changes being made. If you need to explain a complex decision, do so.
- Avoid putting code into generic `utils.ts`, `types.ts`, `helpers.ts` files. Drive the filename from the specific domain or feature it serves.

## Communicating — plans, reviews, and every answer

Everything written for the user — a plan, a review, a chat reply, a changeset, a commit body — is read by someone deciding whether the work is RIGHT, not by someone looking up where to type. Every rule below follows from that one sentence.

- **No code, unless the code IS the answer.** Not a snippet, not a signature, not a diff, to illustrate a change. A change that cannot be stated as behaviour is not understood well enough to describe. (Answering "what does this function do" or showing a one-line API a user must type is the exception; illustrating a design is never one.)
- **No source paths, no function names, no line links** in a plan or a design discussion. Where code lives and what a function is called are not decisions — they are lookups, they cost a line each, and they are wrong the moment a file moves. `resolveCacheRoot in manifest-sources/local-manifest-cache-source.ts` says nothing that `the cache root` does not. A bug report is the exception: there, the location is the finding.
- **But name every OBSERVABLE artifact exactly.** On-disk paths and filenames (`.telo/manifests/.validated.json` → `.telo/analysis/<hash>.json`), env vars, CLI flags, manifest keys, diagnostic codes, wire fields. These ARE the behaviour: they are what a user sees, what an upgrade breaks, and what a reviewer checks the implementation against. Cutting them is what makes a description unreviewable — cutting source paths is what makes it readable, and the two are opposite moves that look similar.
- **Before / After / Verify.** What happens today, what should happen instead, and how you would know it worked. A claim with no verify is a wish, and the verify is what catches work that only *sounds* complete — "the manifest is read from the old location" passes a review and still fetches every controller, because nobody wrote down what to check.
- **State a constraint once.** One sentence for why the losing option loses, only where a reader would otherwise re-propose it. Never restate the same rationale in the summary, the body and the conclusion. A "not in scope" section is usually a list of things that are not tasks — cut it unless its absence reads as an oversight.
- **Lead with the finding.** The answer, the verdict, the number — then the reasoning, once. Never narrate what you are about to do, never re-explain a decision the user has already made, and never open with a summary of the question.
- **Separate what you verified from what you believe.** Say which you did. "236/236, and the earlier failures were a stale `fastify`" is a report; "should be fine now" is not. When something is unverified, say so in the same breath as the claim rather than in a caveat at the end.
- **Report a failure as a failure**, with the output and the reason, in the same message that reports the rest. A result that is partly bad and described as good costs more than the bad result did.
- **Answer a review point by point, and concede plainly.** Say which points are valid, fix those, and give the measurement for any you decline. "You're right" is a whole sentence; do not pad it, and do not defend a decision the evidence has just overturned.
- Always prefer answering over editing.

## Architecture

Telo is a declarative runtime: YAML manifests describe desired state, the kernel resolves resource dependencies via a multi-pass init loop, and controllers implement each resource kind. CEL expressions in `${{ }}` are compiled before execution.

**Scope: everything is on the table.** Telo is intended to support every transport, every protocol, every backend domain — HTTP, MCP, gRPC, WebSocket, message queues, databases, file I/O, AI providers, workflow engines, and whatever else lands. Design abstractions for breadth, not for the current consumer. When choosing between a generic primitive and a use-case-specific shortcut, **default to the generic primitive**. "We'll only need it for X" is the wrong question — assume any transport-neutral concept (encoders, codecs, streams, schedulers, retry policies, etc.) will eventually be reused across multiple modules, and shape the API and package layout accordingly. Do not YAGNI on cross-cutting primitives.

**Cross-cutting concerns Telo intends to cover** (non-exhaustive): data shape (codecs, serialization, validation, compression), streaming & I/O, reliability (retry, circuit breakers, timeouts, idempotency), performance (caching, pooling, batching, rate limiting), coordination & data integrity (locks, leases, queues, sagas; execution zones — `kernel/specs/execution-zones.md`, guide `docs/extend/execution-zones.md`), observability (structured logging — `kernel/specs/logging.md`, guide `docs/guides/logging.md`; metrics, tracing, health checks), security (authn/authz, secrets, signing), time & scheduling, configuration, lifecycle (migrations, rollouts), i18n, inputs & boundaries (pagination, uploads, webhooks), and errors (structured contracts, retryable vs terminal). When designing a new module or capability, ask which of these the resource genuinely needs to declare or compose with; if the answer touches more than one consumer, the concern belongs in a shared primitive (kernel built-in capability or transport-neutral package), not buried inside the current module.

**Topology-driven constraint:** The analyzer and telo studio must never hardcode knowledge about specific resource kinds. All resource-specific behaviour must be expressed via `x-telo-*` schema annotations in `Telo.Definition` schemas and resolved generically.

**Browser compatibility:** The `analyzer` package must be runnable in the browser without Node.js polyfills. Do not import Node.js built-ins (`fs`, `path`, `url`, `child_process`, etc.) from analyzer code. Node.js-specific adapters belong in the consuming package (kernel, IDE extension, CLI).

## Core goals

- **Polyglot architecture** — Telo must support controllers and runtimes in any language, not just Node.js
- **Visual editing** — Telo manifests must remain visually editable in a GUI editor; solutions must not break declarative structure or introduce constructs that can't be represented visually
- **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; solutions must not introduce unnecessary overhead
- **Static analysis** — YAML manifests must remain statically analyzable; solutions must preserve the ability to validate references, type-check CEL expressions, and detect errors without running the kernel
- **Developer friendly** — Errors must not be swallowed; they should be surfaced clearly to developers. Error messages must be actionable and informative, guiding developers to concrete place in YAML manifest that needs fixing.

## Package guides

Package-specific architecture and rationale live in nested `CLAUDE.md` files, loaded automatically when a file in that directory is read. **Before working in a directory, read the guide listed for it** — some directories share a guide, and kind semantics are shared by the kernel and the analyzer.

| Working in | Read |
|---|---|
| `analyzer/nodejs/` | `analyzer/nodejs/CLAUDE.md` — kind semantics, capabilities, invocation contract, CEL scope, call graph, every `x-telo-*` annotation, `requires:` |
| `analyzer/nodejs/src/migrations/` | its `CLAUDE.md` — manifest migrations |
| `analyzer/nodejs/src/release/` | its `CLAUDE.md` — release model, ledger, workspace marker |
| `kernel/nodejs/` | `kernel/nodejs/CLAUDE.md` — internals, lifecycle, effects, teardown, zones at runtime, layered artifacts (+ the analyzer guide for kind semantics) |
| `sdk/nodejs/` | `sdk/nodejs/CLAUDE.md` — step engine, durable seam, `ctx.runtime` |
| `templating/nodejs/` | `templating/nodejs/CLAUDE.md` — CEL verdict, `!include-text` / `!include-bytes` |
| `cli/nodejs/` | `cli/nodejs/CLAUDE.md` — `Output` seam, publishing, the kernel image |
| `packages/ide-support/`, `ide/vscode/` | `packages/ide-support/CLAUDE.md` |
| `packages/runner-core/`, `apps/docker-runner/` | `packages/runner-core/CLAUDE.md` |
| `apps/k8s-runner/` | `apps/k8s-runner/CLAUDE.md` (+ runner-core's) |
| `apps/studio/` | `apps/studio/CLAUDE.md` |
| `apps/authoring-agent/` | `apps/authoring-agent/CLAUDE.md` |
| `apps/hub/` | `apps/hub/CLAUDE.md` |
| `modules/` | `modules/CLAUDE.md` — controller delivery, stdlib notes |

## Monorepo Structure

- `kernel/nodejs/src/` — core runtime: orchestration, multi-pass init loop, controllers, event bus. Manifest loading is the analyzer's; the kernel consumes it.
- `cli/nodejs/` — CLI wrapper (`bin/telo.mjs`). **Every CLI-owned write goes through the `Output` seam** (`src/output.ts`), never `console.*` and never a bare `process.stdout.write`: stdout is the machine surface, stderr the human one in both formats.
- `sdk/nodejs/src/` — public API for module authors (re-exports kernel contexts + capability interfaces); owns step-grammar execution, the durable replay seam and `ctx.runtime`. It never imports the kernel and has one runtime dependency — `@marcbachmann/cel-js`, pinned exactly, the CEL value domain's identity (`Duration`, `UnsignedInt`).
- `modules/` — standard library: `http-server`, `http-client`, `sql`, `javascript`, `config`, `run`, `assert`, `test`, `console`, etc.
- `analyzer/nodejs/` — static manifest validator (schema checks, reference validation, CEL type-checking); also owns manifest loading and manifest migrations.
- `templating/nodejs/` — the CEL and `!include-*` engines.
- **Rust half of the polyglot runtime** — `kernel/rust/` (a second kernel), `cli/rust/` (the `telo-rs` binary), `analyzer/rust/` and `templating/rust/` (the loading/tag halves of their Node counterparts), `sdk/rust/` (controller authoring surface) and `sdk/rust/abi/` (the `telorun-abi` C ABI). **File layout mirrors the Node packages one-for-one**, kebab-case becoming snake_case: a Rust file with no Node twin means one of the two layouts is wrong, and the header of every such file says why it is the exception. `kernel/rust` is deliberately narrow: `Telo.Invocable` only, local-path and anonymous `oci://` imports, `pkg:cargo` controllers built from a source checkout and `pkg:telo/local/dylib` controllers from a published artifact's layers, no CEL. `telorun-abi` exists because the kernel must **not** depend on `telorun-sdk` — that crate selects a controller backend by Cargo feature, and unification would compile the napi backend into the kernel binary.
- `apps/studio/` — desktop editor (React + Vite + Tauri)
- **Runners** — `packages/runner-core` (the backend-neutral `/v1` session contract) plus `apps/docker-runner` and `apps/k8s-runner` behind the `RunnerBackend` seam; a session is a one-shot `run` or a continuously running `watch` workspace.
- `apps/hub/` — federated discovery hub (declarative Telo app) serving module search and the `search_resources` MCP tool
- `packages/ide-support/` — editor features shared by the VS Code extension and studio
- `ide/vscode/` — VS Code extension (YAML diagnostics via analyzer)
- `tests/` — integration tests (YAML manifests run via kernel)
- `examples/` — sample manifests

## Resource Kinds

Every module file must start with exactly one `Telo.Application` OR `Telo.Library` doc. Applications are runnable entry points, Libraries are importable units of kinds/definitions. Full semantics, with the rationale behind each rule: `analyzer/nodejs/CLAUDE.md`.

### `kind: Telo.Application`

A runnable entry point, loaded via `Kernel.loadFromConfig`. **Never** imported.

- `metadata.name` — PascalCase (`OAuthClient`, `HttpServer`, `SQL`); becomes the canonical kind prefix. A name, not a locator; it must contain no dot. Directory and npm package names stay kebab-case.
- `lifecycle` — `"shared"` (default) | `"isolated"`
- `include` — partial files/globs loaded into the same module scope; partials must not contain `Telo.Application`, `Telo.Library`, `Telo.Import` or `Telo.Definition`.
- `imports` — alias-keyed map; each value is a source string (`Console: oci://ghcr.io/telorun/console@0.9.0`) or `{ source, variables?, secrets?, runtime? }`. An alias shares ONE namespace with every resource, definition and the module's own `metadata.name` (`DUPLICATE_RESOURCE_NAME`).
- `targets` — optional boot sequence run after init: a `!ref` to a `Telo.Runnable` / `Telo.Service`, `{ ref, when? }`, or an inline invoke step `{ name?, invoke: !ref …, inputs?, when? }` (results as `steps.<name>.result`). Control flow and `with:` scopes stay in `Run.Sequence`. No targets is valid when Services carry the work.
- `variables` / `secrets` — each entry binds `env:`, plus `type:`, optional `default:` and further JSON Schema keywords; resolved at `kernel.load()` into `variables.X` / `secrets.X`.
- `ports` — **Application-only** map of inbound ports (`env:`, `protocol: tcp|udp`, `default:`), read as `ports.X`; a runner knows them before boot.
- `exports` is **forbidden** — if you want to export kinds, the file is a Library.

### `kind: Telo.Library`

Loaded **only** as an imported dependency; `loadFromConfig` on one is a hard error.

- `metadata.name`, `include`, `imports` — as Application (an import's object form also carries `resources:`).
- `variables` / `secrets` — JSON Schema property map; the public contract for importers. No `env` access.
- `resources` — instances the library requires from its importer, constrained by kind only (`connection: { kind: Sql.Connection }`); the importer supplies `resources: { connection: !ref db }`. Borrowed, never owned. Guide: `docs/extend/library-resource-inputs.md`.
- `lifecycle` — `"isolated"` (default: one child scope per import) | `"shared"` (one instance for the whole application; every import must agree on its configuration).
- `exports.kinds` — kinds importers may reference: a bare local name, or `<Alias>.<Kind>` to re-export. No block means ungated.
- `exports.resources` — plain name strings (`<name>` or `<Alias>.<name>`) exporting ready-made instances; importers use `!ref <Alias>.<name>` and `resources.<Alias>.<name>`. A library declares its own instance as `kind: Self.<Kind>`, so it can export an instance of a kind it does not export (singleton enforcement).
- `targets` is **forbidden**.

**Naming:** case encodes what a name denotes — `PascalCase` for types (module names, kinds, import aliases, `Telo.Type` resources), `camelCase` for values (resource instances, steps, `variables`/`secrets`/`ports` keys, CEL bindings). A name must match `^[A-Za-z_][A-Za-z0-9_]*$` and not be a CEL keyword (`INVALID_NAME`); a lowercase type name is `INVALID_TYPE_NAME`; an uppercase value name warns (`NAME_CASE_CONVENTION`).

### `imports`

- `source` — relative path / `oci://` ref / URL; resolved to `telo.yaml`. The CLI `install` / `upgrade` / `publish` commands read and rewrite this map.
- Each import creates an isolated child context; child resources are not visible to the root scope.
- Importing a `Telo.Application` is a hard error. Only the root Application binds host env vars, and forwards them into imports.
- An import that cannot be identified registers no alias: `INVALID_IMPORT_SOURCE` / `IMPORT_UNRESOLVED` / `INVALID_IMPORT_TARGET`.

### `kind: Telo.Definition`

Registers a new resource kind (`<module-name>.<Name>`).

- `capability` — one of the capabilities below; inherited and immutable under `extends` (`EXTENDS_CAPABILITY_MISMATCH`).
- `extends` — alias-qualified kind this definition specializes: an abstract (implements its contract) or a concrete kind (single inheritance, Liskov-substitutable). `Self.<Kind>` names the declaring library's own kind (ungated); the module's own name works too. Guide: `docs/extend/kind-inheritance.md`.
- `base` — "super(...)": CEL over `self` mapping the child's schema onto the inherited controller's config. With `base:` the author schema is the child's own; without it, `merge(parent, own)`, and the parent's `required` still applies. `base:` beside a template body is refused (`BASE_WITH_TEMPLATE_BODY`).
- `controllers` — PURL candidates (see Controller delivery); omit on a concrete-`extends` child to inherit.
- `schema` — JSON Schema with `x-telo-*` annotations.
- `status` — optional JSON Schema for observed state (`resources.<name>.status.<field>`); `required:` is rejected.
- `inputType` / `outputType` — the invocation contract.
- `resources` / `invoke` / `run` / `provide` — template bodies: entries are named by literals, dispatch slots take a `!ref` to a sibling or a module resource, and `inputs:` / `result:` are top-level siblings. The `{ kind, name }` object form and CEL-computed entry names are deprecated.

**Resource-doc validation injects only `kind` and `metadata`** into a definition's `additionalProperties: false` schema. Every other top-level field an author may write — including `outputType` — must be declared as a property in the kind's own `schema`, or validation rejects it.

## Capabilities

- `Telo.Service` — `init()` + `run()`; long-lived servers, pools
- `Telo.Runnable` — `run()`; one-shot tasks, pipelines
- `Telo.Invocable` — `invoke(inputs)`; request handlers
- `Telo.Provider` — `init()` + optional `provide()`; config/secret/value-flow sources; all fields implicitly `x-telo-eval: compile`
- `Telo.Mount` — mounted into a Service (HTTP APIs, middleware)
- `Telo.Sink` — `write(record)` + `flush()` / `flushSync()` / `close()`; a record stream the runtime writes to directly, never through `ctx.invoke`
- `Telo.Type` — pure schema definition, no runtime instance
- `Telo.Callable` — synchronous `call(args)`; a function reached from CEL through a module name (`Self.fn(x)`, `<Alias>.fn(x)` for an exported one), declaring `params` / `returns`; outside `Telo.Executable`. `Telo.Function` is the built-in CEL-bodied callable, whose determinism is derived and never declared. Guide: `docs/extend/cel-functions.md`.

`Telo.Executable` is a slot constraint — the parent of `Telo.Invocable` and `Telo.Runnable` — not a capability; `capability: Telo.Executable` is rejected, and `Telo.Service` is deliberately outside it. A `Telo.Abstract` is a non-instantiable base kind: a contract with no default implementation. To reuse an existing controller under a friendlier schema, `extends` the concrete kind with `base:` instead.

## Lifecycle & value flow

- **Capability governs wiring, not dispatch**: it decides which `x-telo-ref` slots accept a kind; the kernel calls `init()` / `snapshot()` on anything that has them. A resource that must be both started and invoked is two kinds.
- **Observable side effects belong in `run()`, never `init()`.** `init()` builds the instance — it may ALLOCATE (that is what its effect frame is for: registered listeners, half-built pools), but it performs no I/O the outside world can see, which is also why `ctx.setStatus()` is an error before the resource has started. `run()` is where the effect becomes observable. `Http.Server` is the reference: `init()` registers plugins and routes as one effect, `run()` takes a kernel hold and calls `listen()` as two more.
- **`init()` and `run()` RETURN what undoes them** (a `ctx.effect(reason, body)` chain); there is no `teardown()`. Spec: `kernel/specs/revertible-effects.md`. A module whose controllers return chains declares `requires: telo: ">=0.82.0"`.
- **Configured state is pulled, observed state is pushed**: `snapshot()` returns configuration; `ctx.setStatus(...)` reports what the resource learns, against its declared `status:` block (it replaces, is sticky, and is illegal before start and in startup fields). See `kernel/docs/observed-state.md`.
- A controller's `ctx` is scoped to the context that OWNS its resource; `ctx.moduleContext` is only for imports, the controller policy and the logging scope.
- Controllers resolve a `!ref` slot with `ctx.resolveRef(value, guard, describe, expects)`, not the standalone `resolveRefInstance`.
- Controllers read configuration through `ctx.env` or the declared `variables` / `secrets`; a key the Application binds reads `undefined` from `process.env`.
- Module files are reached with `ctx.resolveModuleFile(relative)` (a path the resource's author wrote, resolved against the author's module) or `ctx.resolveControllerFile(relative)` (the controller's own module file, resolved against the module declaring the kind), never by deriving a directory from `ctx.moduleContext.source`.
- **Every inbound source takes a kernel hold while armed** (a listening server, an MCP endpoint, a schedule), taken in `run()`; the app exits at zero holds.
- `Run.Sequence`'s `with:` declares resources whose lifetime is the sequence; its `targets:` runs them before the steps.
- **`inputs`/`outputs` are always VALUES; `inputType`/`outputType` are always SCHEMAS.** A contract resolves instance → nearest along `extends` and replaces rather than merges; the kernel binds it at `create()` and fails with `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`. `Telo.JsonSchema` is a kernel built-in (`modules/type` is deprecated). Spec: `kernel/specs/invocation-contract.md`.
- `ERR_DURABLE_SUSPENDED` is a signal, not an error: anything that catches (a `try:` step, `catches:`, a retry policy) rethrows it, as it does a cancellation.
- **One import instead of two.** An app that configures a backend itself imports both the abstract and the implementation (`sql` + `sqlite`) — that is normal and ~25 manifests do it. When a consumer should need only one import, the sanctioned collapse is a library that owns the wiring and exports **instances** via `exports.resources` (`tests/__fixtures__/re-export/`), not a module re-exporting another module's kinds.

## x-telo-* Schema Annotations

Inside `Telo.Definition` schema blocks. Each annotation has ONE reader in the analyzer and no other surface pattern-matches its shape; full semantics in `analyzer/nodejs/CLAUDE.md`.

- `x-telo-eval: "compile" | "runtime"` — when CEL in the field is evaluated. **Every CEL-bearing field must be annotated** (or sit in an `x-telo-context` / step-body / error-context region, or a provider's implicit root eval); otherwise `CEL_IN_NON_EVAL_FIELD`.
- `x-telo-ref` — a reference slot plus what the declaring resource does with it. Structured form `{ kind, use, inputs? }` (`kind` may be a list; the bare string is legacy). `use`: `schema` | `dependency` | `call` | `detached` | `trigger.inbound` | `trigger.consumer` — when control reaches the target's bound entry points; a set when several hold, a case map `{ by, cases }` when a statically resolvable sibling chooses. Kinds are alias-qualified (`Self.<Kind>`, `Telo.<Kind>`). `throwsThrough: true` carries throws through a `dependency`. Reader: `ref-slot.ts`. References are written only as `!ref <name>` / `!ref <Alias>.<name>`.
- `x-telo-scope: "/json/pointer"` — an execution scope; resources inside initialize on demand and the controller receives a `ScopeHandle`.
- `x-telo-schema-from: "refProp/$defs/Name"` — field schema derived from a sibling ref's definition (polymorphic config).
- `x-telo-value-schema-from: "<field>"` — the value here must satisfy the type declared at `<field>`; every annotated slot is checked, not only the one that wins at runtime.
- `x-telo-context: <JSON Schema>` — the CEL context inside a handler field; properties may carry `x-telo-context-from`, `-from-root`, `-from-ref-kind` and `x-telo-context-ref-from`.
- **Step bodies** — `items: { $ref: "telo://manifest#/$defs/Step" }` gives any kind the shared step grammar (`invoke` / `value` / `if` / `while` / `switch` / `try` / `throw`); `x-telo-step-context` is the legacy spelling. Guide: `docs/extend/step-bodies.md`.
- `x-telo-context-element-from` / `x-telo-context-collection-from` — type a binding from a sibling collection's element / the collection itself.
- `x-telo-bindings-from: "<field>"` — named CEL bindings readable by bare name.
- `x-telo-error-context` — the `error` variable's schema inside a `catch:` / `finally:` branch.
- **Shared fragments** `telo://manifest#/$defs/<Name>` — `InvokeStep`, `RetryPolicy`, `RetryAttempts`, `Step`, `JsonSchema7`, `KindSchema`; owned by the analyzer.
- `x-telo-schema-map` / `x-telo-schema-projection` / `x-telo-schema-projection-from` — a collection of typed entries projected to a JSON Schema consumers type against.
- `x-telo-resource-rules` — CEL rules relating the fields of one resource (`RESOURCE_RULE_VIOLATED`). Guide: `docs/extend/resource-rules.md`.
- `x-telo-referrer-rules` — CEL rules on whoever references the resource (`REFERRER_RULE_VIOLATED`). Guide: `docs/extend/referrer-rules.md`.
- `x-telo-sensitive: true` — on a contract property: the value is redacted in trace payloads.
- `x-telo-widget: "code"` — studio renders a code editor (language from `contentMediaType`).
- `x-telo-provides-zone` / `x-telo-requires-zone` / `x-telo-violates-zone` — execution zones, with the closed zone attributes `atomic`, `idempotent`, `noSuspend`, `replayed` (each value is the author's reason). Spec: `kernel/specs/execution-zones.md`.
- `x-telo-context-parameters-from` / `x-telo-returns-from` / `x-telo-unbound-calls` — a function body's CEL context is its parameters alone (it replaces the kernel globals), its result is checked against `returns`, and a site nothing binds refuses module calls (`FUNCTION_CALL_UNBOUND`).
- `x-telo-type` — what a value IS: `Telo.TcpPort`, `Telo.UdpPort`, `Telo.Uint64`, `Telo.Bytes`, `Telo.Timestamp`, `Telo.Duration`, `Telo.Stream` (`{ name: Telo.Stream, of: … }`); an instance type is written in YAML in its plain encoding (RFC 3339, `"5400s"`, base64url); a named shape is a `!ref` to a `Telo.JsonSchema`. A union with an instance branch must use `anyOf`, never `oneOf`.

## Embedded files (`!include-text` / `!include-bytes`)

`!include-text` (→ string) and `!include-bytes` (→ `Uint8Array`) embed a file that ships with the module. Paths are module-root-relative literals confined to the module, never relative to the declaring file; the read happens at resource creation. Details: `templating/nodejs/CLAUDE.md`.

## CEL Templates (`${{ }}`)

Always written with the `!cel` tag. A pure expression yields a typed value (`!cel "variables.port"`); a string is built by concatenation (`!cel "'Hello ' + variables.name + '!'"`).

In scope:

- `variables`, `secrets` — module inputs
- `ports.<name>` — root Application only
- `module.<field>` — the declaring module doc's own `metadata` (`!cel "module.version"`)
- `resources.<name>` — a resource's published reading (after `snapshot()`; republished after `run()`, each `invoke()` and each `setStatus()`); `resources.<name>.status.<field>` is declared observed state, illegal in any startup (compile-eval) field
- `self.<ref>.<field>` — member access on a referenced instance reads its published state
- `steps.<step>.result` — inside step bodies, typed from the invoked resource's `outputType`, then its kind's, then open
- `request` — inside handler CEL (HTTP: query, body, params, headers, path, method)
- `<Alias>.fn(…)`, `Self.fn(…)`, `<ModuleName>.fn(…)` — a module function (`Telo.Callable`), resolved on the parsed tree at compile and bound per module scope at `create()`; a bare name is always the core catalog

A CEL integer is int64 and **needs no cast anywhere** — never `double(...)` to get an integer out of a manifest. A controller reading another resource's declared-integer output must accept both representations (`integerInput` from `@telorun/sdk`). Dereferencing a nullable value without a guard (`error != null && error.code`) is `CEL_NULLABLE_ACCESS`.

## Declared runtime requirements (`requires:`)

A top-level `requires:` block on a module doc declares the runtime range the module is verified against: `telo:` (the manifest surface generation, one scale every kernel reports) and `host: { node: … }`. Bounds use explicit comparators — `^`/`~`, a bare version, `||`, hyphen ranges and wildcards are rejected, and an upper bound must name a release that exists. An older runtime reports `MODULE_REQUIRES_NEWER_RUNTIME` and suppresses every other diagnostic from that module; a malformed block is `REQUIRES_INVALID`. Guide: `docs/extend/declaring-runtime-requirements.md`.

### Changing the grammar — MANDATORY

**A surface change is only half done until the modules that adopt it declare a floor.** Widening what a manifest may say — a new annotation, a new SHAPE an existing annotation accepts, a new key on a built-in doc, a new field on a shared fragment — makes every module that uses it unreadable to every already-released telo. Without a floor those modules fail on an older runtime with a diagnostic pointing at their own YAML (`ZONE_ANNOTATION_INVALID`, `SCHEMA_VIOLATION`, an `additionalProperties` violation), which blames the module's author for a version skew. `requires:` is what converts that into one `MODULE_REQUIRES_NEWER_RUNTIME` naming the cause and suppressing the rest.

So, on the same change that widens the surface:

1. **Find every module whose OWN `telo.yaml` uses the new syntax** and give it `requires: telo: ">=<the release that carries it>"`. Not every module that *touches* the feature — the test is whether an older analyzer, reading THAT FILE, would reject it.
2. **The bound is the surface generation, not the package version.** `node scripts/generate-telo-version.mjs` writes `TELO_SURFACE_VERSION`, which is `cli/nodejs/package.json` plus any pending changeset bump — so on the commit that adopts new syntax it is the *unreleased* version that will ship it. **Forward-declaring is correct and expected**; `telo release check` reports such an edge as pending rather than trying to run it, and `publish` refuses it only once the release exists and the range is genuinely refuted.
3. **Verify by EXECUTION, not by reading.** Strip the block, run the previous published CLI against the module (`npx @telorun/cli@<previous> check <manifest>`), and confirm it rejects. If it does not, the module does not need the bound and adding one is a claim nothing checks — the failure class this mechanism exists to remove. Then put the block back and confirm the same runtime now reports `MODULE_REQUIRES_NEWER_RUNTIME` instead.

**Do NOT declare a bound because a module's kinds merely EXPOSE the new syntax to consumers.** A field added to a kind's schema is delivered in that module's own artifact, so the module is readable by an older analyzer and needs nothing; the *app* that writes the new syntax is what needs the floor, declared by its author. `Assert.Events` gaining a `times:` property is this case — an ordinary draft-07 property in an open `KindSchema` body — while `Sql.Transaction` adopting the zone-attribute object form is the other, because the object form is vocabulary the older reader refuses.

**In-repo dependents propagate for free** — siblings import by relative path, so a module adopting new syntax fails its dependents' edge checks — which is why the check is per-file rather than per-dependency-graph.

## Manifest migrations

A legacy spelling that published artifacts still carry is rewritten to the current one at load, by data entries under `analyzer/migrations/` (JSON, no code); `telo migrate` applies them to files, and only the entry module's own files report. Guide: `docs/extend/manifest-migrations.md`; internals: `analyzer/nodejs/src/migrations/CLAUDE.md`.

## Where to Look

Bare filenames are in `analyzer/nodejs/src/`. Each package guide carries its own fuller list.

- Runtime bug / init order → `kernel/nodejs/src/kernel.ts`; manifest loading → `analyzer/nodejs/src/manifest-loader.ts`
- Module/import scoping → `evaluation-context.ts`, `module-context-registry.ts`, `import-controller.ts` (kernel)
- New resource kind → add `Telo.Definition` to the module's `telo.yaml`, controller in `nodejs/src/`
- Schema validation errors → `manifest-schemas.ts`, `analyzer/nodejs/`; how a failure is phrased → `schema-error-report.ts`
- `telo check` vs kernel agreement → `tests/check-run-agreement.yaml`. **A guard enforced in a controller with no analyzer twin is a manifest that passes `telo check` and fails at boot** — a new refusal belongs in both halves, and in both halves of this suite.
- References, scope, topology → `ref-slot.ts`, `call-graph.ts`, `reference-field-map.ts`, `dependency-graph.ts`, `validate-references.ts`; what a `!ref` names → `ref-sentinel-target.ts`
- Library resource inputs, shared libraries → `resource-input.ts`, `validate-resource-inputs.ts`, `flatten-for-analyzer.ts`, `kernel/nodejs/src/controllers/module/shared-libraries.ts`
- Broken imports → `manifest-loader.ts` (`importTargetIdentity`), `import-resolution-diagnostics.ts`
- Throws and `catches:` coverage → `validate-throws-coverage.ts`, `resolve-throws-union.ts`, `modules/http-server/docs/returns-and-catches.md`
- Template bodies → `template-body.ts`, `validate-template-body.ts`, `kernel/nodejs/src/controllers/resource-definition/resource-template-controller.ts`
- Step bodies → `manifest-schemas.ts` (`StepSchema`), `step-slot.ts`, `sdk/nodejs/src/step-engine.ts`
- Execution zones → `zone-slot.ts`, `resolve-zone-requirements.ts`, `resolve-zone-containment.ts`, `kernel/nodejs/src/resource-handle.ts`, `sdk/zone-attributes/*.json`
- Resource / referrer rules → `resource-rule.ts`, `validate-resource-rules.ts`, `referrer-rule.ts`, `validate-referrer-rules.ts`
- Value types → `sdk/value-types/*.json`, `sdk/nodejs/src/value-type.ts`, `value-type-keyword.ts`, `validate-value-type-slots.ts`
- Naming → `identifier-name.ts`, `validate-identifier-names.ts`, `docs/guides/style-guide.md`
- CEL type checking → `templating/nodejs/src/engines/cel.ts`, `cel/diagnose.ts`, `cel-environment.ts`, `validate-cel-context.ts`; what CEL sees at a site → `cel-scope.ts`, `cel-scope-query.ts`
- Effects, teardown, reload → `sdk/nodejs/src/effect.ts`, `kernel/nodejs/src/effect-scope.ts`, `kernel/nodejs/src/resource-edges.ts`, `Kernel.reconcile` + `kernel/nodejs/src/reconcile.ts`
- Durable execution and waiting → `sdk/nodejs/src/durable-run.ts`, `sdk/nodejs/src/durable-suspension.ts`, `kernel/specs/durable-execution.md`
- Embedded files → `templating/nodejs/src/engines/include.ts`, `module-file-claims.ts`, `kernel/nodejs/src/resolve-include-sentinels.ts`
- Library specifiers (`exports.code:`) → `module-library.ts`, `kernel/nodejs/src/controller-loaders/`
- `requires:` → `requires-block.ts`, `version-range.ts`, `validate-requires.ts`, `cli/nodejs/src/release/{verify,check}-requires.ts`
- Migrations → `analyzer/nodejs/src/migrations/`, `cli/nodejs/src/commands/migrate.ts`
- Release planning → `analyzer/nodejs/src/release/`, `cli/nodejs/src/release/`, `cli/nodejs/src/bundle/module-payload.ts`
- Rename → `packages/ide-support/src/rename/`
- Runner sessions → `packages/runner-core/src/`; k8s routing → `apps/k8s-runner/src/k8s/routing/`
- Test an EXAMPLE or a TEMPLATE → its own `tests/` directory beside its `telo.yaml`, run by `examples/test-suite.yaml` / `templates/test-suite.yaml` (both invoked by CI, separately from the module suite because they import published modules, so a red run can mean the release sequence is behind). A test stands the application up with `App.Instance` in a `Run.Sequence`'s `with:` and calls it; a one-shot application is `Assert.Manifest` instead; an application that prompts for input is a conversation — `Channel.ReadUntil` / `Channel.SendLine` / `Channel.End` over the instance, which is a `Channel.Text`. Give each test a port of its own, and identify any row it writes per run (`uuidv4()`) — an example's database file outlives the test.
- Test a manifest → add to `tests/` (or `modules/<name>/tests/`), run `pnpm run test`. A test needing infrastructure the root suite deliberately lacks (a live PostgreSQL) goes under `<module>/tests/integration/` — the root glob is `**/tests/*.yaml`, so a subdirectory is excluded by construction — and runs through `test-suite-integration.yaml` (`pnpm run test:integration`; the hub's own integration tests run through `apps/hub/test-suite-e2e.yaml`), whose connection comes from `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`. The root suite must pass on a clean checkout with nothing running, so that a red module suite means the code is wrong rather than that something was not up.
- Controller CLI args → `kernel.ts` (`parseArgsForController`), `resource-context.ts`
- Test runner → `modules/test/nodejs/src/suite.ts`
- Module functions → `templating/nodejs/src/cel/module-call.ts`, `module-function-index.ts`, `callable-signature.ts`, `callable-flags.ts`, `callable-binding.ts`, `callable-slot.ts`, `kernel/nodejs/src/module-functions.ts`, `kernel/nodejs/src/native-function.ts`
- Plain vs typed JSON → `sdk/nodejs/src/plain-encoding.ts`, `sdk/nodejs/src/plain-json.ts` (outside readers), `sdk/nodejs/src/typed-frame.ts` (internal boundaries), `sdk/rust/src/typed_frame.rs`, `kernel/specs/durable-execution.md` §6

## Module Documentation — MANDATORY

**Every module change MUST include documentation updates.** This is not optional. Before finishing any task that adds or modifies a module, verify:

1. Documentation exists in `modules/<name>/docs/` (and the module's `README.md`). If not, create it.
2. Documentation matches the current code. If code changed, docs must be updated.

Module docs live **with the module** and are surfaced through the Telo **hub** (`hub.telo.run`), which indexes each published module's manifest and docs — the standard library is discovered there, not embedded in the Docusaurus site. Do **not** wire per-module doc files into `pages/docusaurus.config.ts` / `pages/sidebars.ts`; the docs site links out to the hub for module discovery. The Docusaurus site is for the kernel/guides/extend/learn docs only.

## Manifest descriptions — MANDATORY

`metadata.description` on a `Telo.Library` and on every kind doc (`Telo.Definition` / `Telo.Abstract`) is **hub search text**: the hub embeds it for semantic search, so it is read by someone who does not yet know the module exists. Write it for that reader, not for a maintainer.

- **Say what it does, in terms of the problem it solves.** Lead with the capability and the vocabulary a searcher would type (locks, leases, retries, pagination, idempotency, …).
- **Keep it to one paragraph** — roughly 40–60 words. It is embedded as a single vector; a long multi-paragraph text dilutes it. Rationale, design history and trade-offs belong in `docs/` and in YAML comments above the doc, never in `description`.
- **No kind names, no capability names, no "the X abstract".** The kind and capability are already structured metadata on the doc. `The KvStore.Store abstract — a durable store…` → `Durable key/value storage…`.
- **No implementations, no backend names.** A generic module must not name the modules that extend it (`backed by Redis SET NX` / `kv-store-sql`); that coupling is backwards and pollutes search hits for the generic kind. Backends describe themselves.
- **No contrast with sibling modules.** `Cache.Store is also a key/value store, but…` reads as noise to a searcher and drags the sibling's terms into this vector. State this module's own guarantee positively.
- **No wording that only makes sense against history.** `NON-EVICTING`, `unlike before`, shouting caps for emphasis. Say `records live their full TTL and are never dropped early`.
- **Kind descriptions state the operation and its contract** — inputs, outputs, and what a failure/edge return means — in two or three sentences. See `modules/collection/telo.yaml` and `modules/kv-store/telo.yaml` for the target shape.

## Manifest categories

`metadata.categories` is an unordered list of domain **display labels** (`[AI, Storage]`) on a `Telo.Library`, or on a kind doc where it replaces the module's. A grouping facet, never search text — keep it out of `description`. The vocabulary is open and nothing validates it; reuse an existing label when one fits: `AI`, `Compute`, `Configuration`, `Coordination`, `Data`, `Observability`, `Performance`, `Reliability`, `Scheduling`, `Storage`, `Streaming`, `Testing`, `Transport`, `Visualization`. How the hub groups them: `apps/hub/CLAUDE.md`.

## Module metadata

The `metadata:` block on a module doc carries `name` (the only field anything resolves against) plus descriptive `version`, `description`, `repository`, `homepage`, `documentation`, `license`, `categories`, `deprecated`; a near-miss of a known key is reported (`licence:` → `license`). There is deliberately no `authors` / `maintainers` field. **`metadata.deprecated: { reason, replacedBy? }`** is legal on a module doc and on any kind doc: on a kind, `replacedBy` is an alias-qualified kind resolved through the file's own `imports:`; on a module, a module ref. Declaring a resource of a deprecated kind is a `DEPRECATED_KIND` warning at the use site. Which kernels can host a kind is derived from its `controllers:` PURLs, never declared.

## Controller delivery

A `Telo.Definition` names its controller with PURL candidates:

- `pkg:telo/local/js?path=./nodejs/<module>.mjs&local_path=./nodejs/src/index.ts#<Export>` — **bundled**: the controller ships inside the module's own artifact. **This is how the standard library delivers.** A module is ONE bundle: `nodejs/src/index.ts` re-exports one namespace per kind, and each kind selects its export by `#fragment`.
- `pkg:npm/@telorun/<pkg>@<ver>?local_path=./nodejs#<export>` — a published npm package; in this repo only the deferred modules (`image`, `pdf`, `starlark`) use it. Don't add new ones.
- `pkg:cargo/<crate>?local_path=./rust#<entry>` — a Rust controller crate, built on load from a source checkout.
- `pkg:telo/local/napi?path=…&os=…&arch=…[&libc=…]` / `pkg:telo/local/dylib?path=…&os=…&arch=…&abi=telo-<n>` — a prebuilt native controller in a per-platform controller layer: the Node kernel opens `napi`, the Rust kernel `dylib`. In a checkout its file is staged by `sources:` (below), fetched on first use when missing or stale, and verified against its pin before it is opened.

- **The kernel builds the bundle** — from source on load in development (no build step), and through the same builder on publish. A module's own `build` script only type-checks (`tsc -p tsconfig.lib.json`). Never commit `nodejs/*.mjs`, and never re-add an esbuild step.
- `modules/<name>/nodejs/package.json` is private (`@telorun/<name>-build`) and never published.
- `@telorun/sdk` stays external; a sibling module's code is reached through its `exports.code:` specifier, never inlined.
- `files:` lists what the manifest cannot otherwise name; the controller entry is never restated there.
- A dependency that resolves an asset beside its own module URL cannot be inlined.

Full mechanics: `modules/CLAUDE.md`.

## Layered module artifacts

A published module is one OCI artifact of several layers — `manifest`, per-selector `controller`, `library` and `native`, `assets`, `common` — addressed by the `layers:` index in the published `telo.yaml`, which the import pin covers. A host materializes only the layers its selector (`format` + `os`/`arch`/`libc`/`abi`) needs. Spec: `kernel/specs/module-artifact.md`; details: `kernel/nodejs/CLAUDE.md`.

- **`native:`** on a module doc names each platform-specific file a controller opens by name (`{ name, format, os, arch, libc?, abi?, path }`), shipped in the `native` layer of its selector and reached through `ctx.resolveNativeFile(name)`.
- **`sources:`** says where every staged file comes from — `{ version, url, archive: tar.gz, notices, entries, build? }`, each entry a file (`upstream`, `member`, pinned `sha256` + `executable`) or a link (`target`), and for files built in this repo `build: { cargo: <crate dir>, inputs: <digest> }`. An entry stages a `native:` path, a platform-qualified controller `path=`, a file an `assets:` pattern selects, or a notice. `telo release stage [--pin]` fetches every entry and pins it; a kernel reading a source checkout fetches a missing or stale file on first use (verified against its pin, never read unpinned), and reads no native or module file of a module whose block does not read. It is removed from the published `telo.yaml`.
- Guide: `docs/extend/native-files.md`; `telo check` codes `NATIVE_*` / `SOURCE_*`.

## Versioning & releases — MANDATORY

**The whole repo is intentionally pre-1.0, and staying pre-1.0 is the goal.** Breaking changes are released as **minor** bumps on purpose — both `@telorun/*` npm packages and Telo modules. A documented breaking change shipped as a minor (or a module's `Added` fragment for a breaking change) is the convention working as designed, **never** a versioning defect. Do not flag "breaking change shipped as minor" in reviews. The CI guards (`telo release check`'s major rejection, the changeset major-bump guard) exist to *enforce* this — anything that would bump to 1.0.0 is the error, not the minor.

Two release tracks, split by artifact:

- **npm packages → changesets.** Every change to a published `@telorun/*` package MUST ship a changeset. Add one file under `.changeset/` (one per logical change, listing every affected package) and `git add` it. Use `pnpm changeset add --empty` when a change genuinely needs no release. The gate is `scripts/check-changeset-status.mjs`, not `changeset status` directly: private `-build` packages are versionable, and every package under `modules/*/nodejs/` is now module-owned (its version is its module's), so both are filtered out; only a changed **published, non-module** package with no changeset fails. The same module-owned set is in `.changeset/config.json`'s `ignore`, so the two ledgers never write the same field.
- **Telo modules → `telo release`.** See `docs/extend/releasing-modules.md`. A module has **one version** across `telo.yaml`, `nodejs/package.json` and `rust/Cargo.toml`, and one changelog. Write a fragment with `telo release add --module modules/<name> --kind Fixed --body "…"` (`.changes/pending/*.yaml` — one file, several modules, one body, with the kinds `Added | Changed | Deprecated | Removed | Fixed | Security`). Never hand-edit `metadata.version`. A bundled module takes no changeset; its version moves when its payload digest does, and `telo release check` warns (`CHANGELOG_ENTRY_REQUESTED`) when a module's own files changed with no fragment naming it.

Why modules need their own release system, how bumps propagate, the ledger and the workspace marker: `analyzer/nodejs/src/release/CLAUDE.md`. Publishing: `cli/nodejs/CLAUDE.md`.

## Keep CLAUDE.md up to date

Sync this file — and the nested `CLAUDE.md` of every package you changed — after any significant architectural change. Package-specific architecture and rationale belong in the nested guide; this file keeps only what applies across the repo.

## Keep the authoring agent in sync — MANDATORY

`apps/authoring-agent` is an AI agent that authors Telo manifests for users. Its
system prompt (`apps/authoring-agent/chat/telo.yaml`, the `system:` block) is a
full primer that encodes the current Telo architecture — resource kinds,
capabilities, reference/CEL rules, import/export semantics, and authoring patterns
(composition, inheritance, etc.). **Any change to Telo's architecture MUST include
a matching update to that system prompt**, as part of the same change — never a
follow-up. A stale primer makes the agent emit manifests against an outdated
surface. Treat it like this file and the module docs: syncing it is not optional.
