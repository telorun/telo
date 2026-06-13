# @telorun/run

## 0.7.0

### Minor Changes

- e398d4d: Add `Run.Value`, a pure value/binding invocable. It returns a CEL expression — or
  a structure with CEL leaves, or a plain constant — evaluated over the caller's
  `inputs`, with no JavaScript. It is the declarative, type-safe replacement for a
  `Js.Script` that only shapes a value (concat, field mapping, arithmetic, a constant
  literal); I/O and branching still belong in `Js.Script`.

## 0.6.0

### Minor Changes

- ee8926f: Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
  and bare-string references are removed: the analyzer rejects them up front
  (`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
  authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
  whole manifest tree (including step `invoke`s and refs nested in inline
  definitions), so every consumer sees the uniform resolved shape. The
  http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
  mcp transports / clients read their Phase-5-injected ref instances directly.

  Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
  slot may still pin (older published modules encode references as `type: string`)
  before running AJV, so a resolved reference object validates against a legacy
  `x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
  dependency analyzable and bootable during the migration. Object-typed ref slots
  that also accept an inline value (e.g. `inputType` / `outputType`) are left
  untouched.

  `Run.Sequence` reference slots are brought onto the same enforcement path: a
  step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
  slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
  to `/targets`), so a bare-string ref at either is rejected with
  `INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
  targets — instead of failing as an obscure runtime error. The controller reads
  the resolved reference rather than a bare name.

## 0.5.0

### Minor Changes

- 2864c4d: Expose a `Run.Sequence`'s caller inputs under the `inputs` CEL variable inside steps. Previously the controller spread caller inputs flat into the CEL scope, so `${{ inputs.x }}` (the documented contract) failed at runtime with "Unknown variable: inputs"; only sequences run directly (no inputs) were unaffected. Steps now read caller inputs as `${{ inputs.x }}`, matching the docs, while `error` continues to be threaded as a sibling key inside `try`/`catch`/`finally`.

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Minor Changes

- 222b3d6: `Run.Sequence` now guarantees a non-empty `error.code` and `error.message` inside
  every `catch` block. A caught failure that is not a structured `InvokeError`
  (e.g. a plain `Error` thrown by an invoked resource) is surfaced as
  `error.code === "INTERNAL_ERROR"` instead of `null`. A `throw: { code: "${{
error.code }}" }` rethrow can therefore never resolve to `null` — previously such
  a rethrow failed at runtime with `INVALID_THROW_STEP`, masking the underlying
  error.

  The analyzer's throws resolver mirrors this: a `try` block containing an
  `invoke:` step folds `INTERNAL_ERROR` into the union a `catch` re-raises via
  `error.code`, so an HTTP route's `catches:` list must cover it (or include a
  catch-all). The resolver also now recognises the `!cel`-tagged code form in
  `throw:` steps and passthrough call sites, matching the existing `${{ … }}`
  string handling.

  The analyzer now type-checks the `error` object inside `catch:` / `finally:`
  blocks via a new `x-telo-error-context` schema annotation. CEL expressions like
  `${{ error.cdoe }}` (a typo) are flagged with `CEL_UNKNOWN_FIELD` at any nesting
  depth; valid fields (`code` / `message` / `step` / `data`) pass. Inside `finally`
  `error` is typed as nullable (it is `null` on the success path), faithful to the
  runtime contract. The annotation is generic — any composer that declares
  error-bearing branch fields opts in the same way, with no resource kind hardcoded
  in the analyzer.

  CEL chain validation now also enforces null-safety: dereferencing a value whose
  schema admits `null` (e.g. `error` inside `finally`) without a null-guard is a
  static error (`CEL_NULLABLE_ACCESS`). Guards are recognised through `?:`
  ternaries and `&&` / `||` short-circuits (`error != null && error.code`,
  `error == null ? … : error.code`). This is general — it applies to any nullable
  value in any CEL context, not just `Run.Sequence`.

### Patch Changes

- ae0bf77: Add flat invoke steps and conditional `when` guards to Application `targets`, so a
  runnable app can sequence and gate boot-time work without importing `std/run`.

  Alongside the existing bare reference, a `targets` entry now accepts:

  - a gated reference `{ ref: <Runnable/Service>, when?: <CEL> }` — `run()` only when
    the guard holds;
  - an inline invoke step `{ name?, invoke: <Invocable/Runnable ref>, inputs?, when? }`
    — call an Invocable on boot, with `steps.<name>.result` plumbed into later
    targets and an optional `when` guard.

  The flat invoke leaf (`when` + `inputs` expansion + ref resolution + `retry` +
  `steps.<name>.result`) is now a single shared primitive `executeInvokeStep` in
  `@telorun/sdk`. The kernel boot runner and the `Run.Sequence` controller both
  consume it, so the leaf semantics are single-sourced — `Run.Sequence` keeps
  control flow (`if`/`while`/`switch`/`try`), `with:` scopes, and the callable
  `inputs`/`outputs` wrapper.

  The analyzer's reference-field-map descends into object `anyOf` variants on a ref
  node, so nested refs like `targets[].invoke` register and resolve; reference
  validation skips the item-level `{kind, name}` check for the inline/gated object
  forms.

  `targets` are ref-only for now: inline targets reference declared resources
  (`!ref` / `{kind, name}`); inline resource definitions remain a `Run.Sequence`
  feature. Static CEL type-checking of target `when`/`inputs` and editor support
  for the new target forms are follow-ups.

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.2.7

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.6

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.5

### Patch Changes

- 543b91f: Surface duplicate inline resource registrations as `ERR_DUPLICATE_RESOURCE` instead of silently skipping the second registration. `resolveChildren` previously suppressed the throw from `registerManifest` when the target name was already taken, which hid real bugs — most notably inline resources inside sibling `Run.Sequence` steps colliding on auto-generated names, where only the first sequence's invocations actually ran while the rest were silently aliased onto it.

  Three changes ship together:

  - `@telorun/kernel`: removed the `!hasManifest(name)` guard in `resolveChildren`. Duplicate registrations now throw at boot.
  - `@telorun/run`: inline-step auto-names now include the parent sequence's name and follow the project's PascalCase resource-naming convention — e.g. `SequenceHealthLivenessSteps1Assert` rather than `__sequence_steps_1__assert`. Sibling sequences with identical step names no longer collide.
  - `@telorun/kernel`: the unnamed-resource fallback was renamed from `__unnamed_<hex>` to `Unnamed<hex>` for the same convention.

## 0.2.4

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.2.0

### Minor Changes

- 353d7e5: feat: invocable errors — structured error channel end-to-end

  Invocables and runnables now have a first-class structured-error channel for domain failures (`InvokeError`), distinct from operational failures (plain `Error` / `RuntimeError`). Route handlers branch on named codes via `catches:`; sequences catch with `error.code` / `error.message` / `error.data` / `error.step` context.

  **SDK** (`@telorun/sdk`)

  - New `InvokeError` class + `isInvokeError` guard. Symbol-based discrimination (`Symbol.for("telo.InvokeError")`) is dual-realm-safe across pnpm hoist splits, registry modules, and future sandbox isolation.
  - `ResourceDefinition.throws`: declared-throw contract (`codes` map, `inherit: true`, `passthrough: true`).
  - `ResourceContext` / `EvaluationContext` gain `invokeResolved(kind, name, instance, inputs)` for callers that already hold a resolved instance.

  **Kernel** (`@telorun/kernel`)

  - Single emission point for invoke-level events: `Invoked` / `InvokeRejected` / `InvokeFailed` / `InvokeRejected.Undeclared`. All call paths (direct invoke, sequence scope path, HTTP route handler) route through the same wrapper.
  - `Telo.Definition.throws:` schema with per-capability restrictions (rule 8: only on Invocable / Runnable).
  - `resolveChildren` now auto-registers bare-kind inline refs when a resource name is supplied without an explicit name on the ref — lets stateless invocables like `Run.Throw` be used inline via `invoke: {kind: Run.Throw}`.

  **Analyzer** (`@telorun/analyzer`)

  - New dataflow resolver (`resolve-throws-union.ts`) for `inherit: true` / `passthrough: true` declarations. Walks `x-telo-step-context` arrays generically, applies `try`/`catch` subtraction, detects cycles, memoises per manifest.
  - New coverage validator (`validate-throws-coverage.ts`) — rules 1/2/4/7 for `catches:` lists. Coverage-proving CEL parser recognises `error.code == 'X'`, disjunctions, and `error.code in [...]`. Typed `error.data.<field>` access against per-code `data:` schemas, with intersection narrowing for disjunctive `when:` clauses.
  - New error codes: `UNDECLARED_THROW_CODE`, `UNCOVERED_THROW_CODE`, `UNBOUNDED_UNION_NEEDS_CATCHALL`, `CATCHALL_NOT_LAST`, `INHERIT_WITHOUT_STEP_CONTEXT`.

  **Run module** (`@telorun/run`)

  - `Run.Sequence` declares `throws: { inherit: true }`. Its effective union is resolved from step invocables at analysis time.
  - New `Run.Throw` invocable: takes `{code, message, data?}` and throws `InvokeError`. Declared with `throws: { passthrough: true }`; the analyzer resolves constant / `error.code`-inside-catch forms at each call site.
  - Sequence `try`/`catch` `error` context gains `data?: unknown` and now branches on `isInvokeError`.

  **HTTP server module** (`@telorun/http-server`) — **breaking**

  - Route-level `response:` is replaced by two channel lists: `returns:` (how to render handler results) and `catches:` (how to render `InvokeError` throws). Applies to both `Http.Api` routes and `Http.Server.notFoundHandler`.
  - Plain `Error` / `RuntimeError` throws skip `catches:` and fall through to Fastify's default 5xx renderer — operational vs. domain failures are now distinct on the wire.
  - `catches:` entries reject `mode: stream` at schema validation (structured errors always render as JSON).
  - Unmatched `returns:` dispatch now throws (surfaces via Fastify's error handler) instead of rendering a silent 500.
  - Every `response:` occurrence across the repo (apps, benchmarks, examples, tests) migrated to `returns:` — no manifest carries the old shape.

  See `sdk/nodejs/plans/invocable-errors.md` for the full design and rollout phasing.

- 31d721e: feat: bearer-token auth for the Telo module registry publish endpoint

  The registry's `PUT /{namespace}/{name}/{version}` now requires an `Authorization: Bearer <token>` header. Reads stay anonymous. Tokens are provisioned declaratively at boot via `TELO_PUBLISH_TOKEN` and stored as SHA-256 hashes in a `tokens` table joined to `users` and `namespaces`.

  **Analyzer** (`@telorun/analyzer`) — **breaking for direct API consumers**

  - `StaticAnalyzer` and `Loader` now accept an optional `{ celHandlers }` in their constructors. Analyzer-only callers (VS Code extension, Docusaurus preview, CLI `check`/`publish`) can omit it and get throwing stubs. Runtime callers (kernel) must supply real handlers.
  - The module-level `celEnvironment` singleton is removed — `precompile.ts` now takes the `Environment` as a parameter.
  - New CEL stdlib function: `sha256(string): string`. Always registered with the correct signature so `env.check()` type-checks; behaviour depends on the supplied handler.
  - The throws-union resolver recognises the new `throw:` step shape (see Run module) and resolves its code at the call site using the same rules as passthrough invocables (literal / `${{ 'LIT' }}` / `${{ error.code }}` in catch).
  - CEL type-check failures now surface as diagnostics. Previously the analyzer only reported schema/type mismatches on valid expressions; `env.check(...)` returning `{ valid: false }` (wrong method, wrong operand types, wrong overload — e.g. `s.slice(7)` on a dyn) was silently dropped. Now surfaces as `SCHEMA_VIOLATION` with a `CEL type error:` message.

  **Kernel** (`@telorun/kernel`)

  - Constructs `StaticAnalyzer` and `Loader` with a `node:crypto`-backed `sha256` handler, so CEL templates invoking `sha256()` evaluate at runtime.

  **Run module** (`@telorun/run`) — **breaking**

  - `Run.Sequence` gains a first-class `throw:` step variant: `- name: X; throw: { code, message?, data? }` — throws `InvokeError` directly from inside the sequence. Works inside `catch:` blocks via `code: "${{ error.code }}"` for re-raise. A malformed `throw.code` (non-string or empty after expansion) is itself reported as `InvokeError("INVALID_THROW_STEP", …)` rather than a plain Error, so the failure stays in the structured-error channel and a surrounding `catches:` can map it.
  - The `Run.Throw` invocable is removed. Existing `invoke: { kind: Run.Throw }` call sites must migrate to `throw:` steps. The separate kind was redundant with the new step form, and the `throw:` step expresses the intent more directly inside sequences.
  - **Event-stream change:** `throw:` steps do **not** emit a scoped `<Kind>.<name>.InvokeRejected` event the way `Run.Throw` did. The error is thrown from inside the sequence's own `invoke()`, so the enclosing kind's event is what fires (e.g. `Run.Sequence.<handlerName>.InvokeRejected` — or nothing, when an enclosing `try` absorbs the throw). Downstream observers that filtered on `Run.Throw.*.InvokeRejected` must switch filters.

  **CLI** (`@telorun/cli`)

  - `telo publish` reads `TELO_REGISTRY_TOKEN` and sends it as `Authorization: Bearer <token>`. Without the env var, publishes to auth-gated registries fail with 401.

  See `apps/registry/plans/registry-auth.md` for the full plan.

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6
