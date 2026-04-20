# Structured Errors on Invocables

## Goal

Give invocables a first-class structured-error channel so route handlers can branch on named failure modes. Today a throw from an `Invocable` is opaque — HTTP catches it and re-throws to Fastify's 500 handler; the response matcher never sees it.

This document describes the full target. Implementation lands in two rollout phases (see "Rollout phases" at the end) — the split is a sequencing decision, not a scope reduction. Every section below is part of the final design.

## Non-goals

- No change to the `Invocable<TInput, TOutput>` signature — still `invoke(inputs): Promise<TOutput>`.
- No backward compat for the `response:` field. It is removed and replaced with two channel lists: `returns:` and `catches:`. Every in-repo manifest is migrated in this change.
- No changes to `HttpClient.Request` or other modules' thrown-error behavior. Modules adopt `InvokeError` on their own timelines; this plan only guarantees the _channel_ works end to end. Adoption per module is out of scope here.

## The `InvokeError` class

```ts
// sdk/nodejs/src/invoke-error.ts
const INVOKE_ERROR = Symbol.for("telo.InvokeError");

export class InvokeError extends Error {
  readonly [INVOKE_ERROR] = true as const;
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "InvokeError";
  }
}

export function isInvokeError(err: unknown): err is InvokeError {
  return typeof err === "object" && err !== null && (err as any)[INVOKE_ERROR] === true;
}
```

`Symbol.for("telo.InvokeError")` is the discriminator, not `instanceof`. This is dual-realm-safe: pnpm hoist splits, registry-loaded modules with their own `@telorun/sdk` copy, and future sandbox isolation all produce objects that are semantically `InvokeError` but fail `instanceof`. Every boundary (`Http.Api`, `toSequenceError`, future consumers) uses `isInvokeError(err)`.

`RuntimeError` and plain `Error` throws are not tagged and keep the current 500 path unchanged.

`code` is a free-form string chosen by the controller author. `data` is optional structured payload; its shape is constrained by the invocable's `throws:` declaration (see next section).

### Vocabulary

The plan uses two verb pairs consistently:

- **Definition layer (contract).** `returns:` — what the invocable resolves with (declared via the existing `outputType`); `throws:` — what it may throw.
- **Route layer (handling).** `returns:` — how to render returned values; `catches:` — how to render thrown `InvokeError`s.

Throw/catch is the natural pairing: the invocable throws, the route catches. Same vocabulary reused across Run.Sequence (`try`/`catch` inside the composer, singular because each is one block of steps, not a list of match entries).

Why not keep `response:` on the route? A 401 is also an HTTP response; reusing `response:` for return-channel entries only would force readers to redefine what "response" means in this schema. `returns:` is literal — an entry fires when the handler returned — and pairs symmetrically with `catches:`.

## `Telo.Definition.throws:` — declared throw contract

Every invocable or runnable that may throw `InvokeError` **must** declare its codes in its `Telo.Definition`. The analyzer enforces this; a manifest that references an undeclared code in a `when:` or `body:` CEL expression is a type error.

`throws:` is valid only on definitions whose `capability:` is `Telo.Invocable` or `Telo.Runnable` — the two surfaces that return-or-throw during normal use. On `Telo.Service`, `Telo.Mount`, `Telo.Provider`, or `Telo.Type` it is a schema error. `init()` failures on those capabilities are boot-time errors, not structured runtime errors for a downstream caller.

```yaml
kind: Telo.Definition
metadata: { name: VerifyToken }
capability: Telo.Invocable
controllers: [...]
schema: { ... }
throws:
  codes:
    UNAUTHORIZED:
      description: Token missing, invalid, or namespace not owned by the token's user.
    EXPIRED:
      description: Token is past its expires_at.
      data:
        type: object
        properties:
          expiredAt: { type: string, format: date-time }
        required: [expiredAt]
```

### Shape

`throws:` is an object with three optional fields, none mutually exclusive:

- `codes:` — map of code → `{ description: string, data?: JSONSchema }`. Code keys match `^[A-Z][A-Z0-9_]*$`. This is the invocable's own contract.
- `inherit:` — boolean. When `true`, the definition's effective throw union includes every code thrown by any invocable it calls (see `inherit: true` below).
- `passthrough:` — boolean. When `true`, the union is whatever `inputs.code` resolves to statically (see `passthrough: true` below). Reserved for `Run.Throw`-style adapters.

A wrapping invocable that propagates inner throws **and** declares its own:

```yaml
throws:
  inherit: true
  codes:
    BUDGET_EXCEEDED:
      description: Per-request compute budget exhausted.
```

Unknown top-level keys under `throws:` are a schema error. `throws: {}` (all three fields absent) is equivalent to omitting the block: the invocable is asserted not to throw `InvokeError`. A runtime throw from such an invocable still propagates, but emits a `${kind}.${name}.InvokeRejected.Undeclared` event for observability. We don't reject at runtime — correctness is an analyzer concern, not a runtime gate.

### `inherit: true`

Meaning: "my throw union includes every code thrown by every invocable I call, minus codes caught in an enclosing `try`/`catch`."

**Topology-driven traversal.** The analyzer must not special-case `Run.Sequence`. Instead, `inherit: true` is only valid on a `Telo.Definition` whose schema contains at least one `x-telo-step-context` array — the existing annotation that already marks a field as "array of step-invokers." The analyzer walks that annotation generically: for each step item, resolve the `invoke.kind`, look up its `throws:` declaration via the same definition-registry path `x-telo-ref` uses, union the codes. Any future composer (`Run.Parallel`, `Run.Race`, etc.) opts in by declaring both `throws: { inherit: true }` and an `x-telo-step-context` field — no analyzer changes required.

Schema rule: `inherit: true` on a definition whose schema has no `x-telo-step-context` field is a schema error. This keeps the generic-traversal contract honest.

The resolver then:

1. Walks each step in every `x-telo-step-context` array.
2. Resolves each step's `invoke.kind` through the analyzer's `DefinitionRegistry`.
3. Recurses through nested composers, with memoization keyed on kind.
4. Subtracts codes caught in any enclosing `try` whose `catch` block doesn't re-throw them (this step is sequence-shape-aware — `try`/`catch` is a `Run.Sequence` schema feature, so subtraction lives in the sequence's own schema traversal, not the generic resolver).
5. Adds any codes thrown by `Run.Throw` steps (see below).

Module-boundary lookups, cycle detection (a composer transitively referring to itself), and memoization live in `resolve-throws-union.ts` in the analyzer — on the order of several hundred lines. The `try`/`catch` subtraction is a thin layer on top, specific to `Run.Sequence`'s schema shape.

### `passthrough: true` (Run.Throw only)

Meaning: "my throw union is whatever `inputs.code` resolves to statically." Used on `Run.Throw`. The analyzer resolves the union per call site:

- **Constant `inputs.code`** (e.g. `code: "UNAUTHORIZED"`) → contribution is exactly `{"UNAUTHORIZED"}`.
- **`inputs.code: "${{ error.code }}"` inside a `catch` block** → contribution is the enclosing `try` block's propagated union, minus codes already handled by sibling catch entries (via `when:` coverage analysis). This is the only other statically-resolvable form.
- **Any other CEL expression** → analyzer error. Authors must either use a constant, or rethrow within a catch that bound `error.code`.

Outside a `catch`, a non-constant `inputs.code` on `Run.Throw` is always a static error.

## `Http.Api` route outcomes

Routes have two outcome lists. `response:` is removed.

```yaml
- request: { path: /{namespace}/{name}/{version}, method: PUT }
  handler: ...
  inputs: ...

  returns:
    - status: 201
      body: { published: "${{ result.published }}" }

  catches:
    - when: "${{ error.code == 'UNAUTHORIZED' }}"
      status: 401
      body: { error: "${{ error.message }}" }
    - when: "${{ error.code == 'VERSION_EXISTS' }}"
      status: 409
      body:
        error: "${{ error.message }}"
        conflict: "${{ error.data.existing }}"
    - status: 500   # no when: = catch-all for any declared code
      body: { error: "${{ error.message }}", code: "${{ error.code }}" }
```

Rules:

- `returns:` entries see `{ result, request }`. `catches:` entries see `{ error, request }`. CEL scope follows container — cross-references (e.g. `result` inside a `catches:` entry) are a type error.
- Both lists match with `when:`; first match wins. An entry without `when:` is the list's catch-all within that channel.
- Missing `returns:` is invalid (a route must define at least one return outcome). Missing `catches:` is valid iff the handler's throw union is empty.
- If the handler throws an `InvokeError` whose code is declared but no `catches:` entry matches and no catch-all is present, the HTTP response is `500 { error: { code, message, data } }` rendered by the dispatcher (not Fastify's opaque 500).
- Plain `Error` / `RuntimeError` (anything not `isInvokeError`) skips the `catches:` list entirely and is handed to Fastify's error handler (5xx with Fastify-default shape). Operational failures are distinct from domain failures and must not be confusable.

Naming note: `returns:` and `catches:` describe _which channel the outcome arrived on_ (return vs throw), not the HTTP status class. A handler that returns `null` for "not found" is still a `returns:` entry (`when: "${{ result == null }}"` returning 404). Authors who want the miss as part of the invocable's contract throw `InvokeError("NOT_FOUND")` and match in `catches:`. Both are valid; the choice is whether "not found" is part of the contract or just a return shape.

### Stream mode

`mode: stream` is valid on `returns:` entries only. The `Http.Api` schema forbids `mode: stream` on `catches:` entries — structured errors are always serialized as JSON. This is a schema rule, not a runtime check; the analyzer rejects it pre-boot.

**Mid-stream throws.** If a handler's invocation resolves cleanly and a `mode: stream` `returns:` entry matches, the response is committed (status + headers sent) before the stream body begins. If the stream body's source then throws, HTTP headers are already on the wire — no structured error response is possible. The dispatcher's contract:

- `InvokeError` or plain `Error` thrown after headers commit → log the throw, emit `InvokeRejected` / `InvokeFailed` as normal, abort the response (terminate the chunked transfer / close the socket). The `catches:` list is **not** consulted; there is no JSON body to render.
- Pre-commit throws (anything before the first byte of body is flushed) follow the normal `catches:` path.

This asymmetry is unavoidable at the HTTP layer. Authors who need catchable failure inside a streaming pipeline must validate upfront and throw before the stream starts.

## `Run.Sequence` — catching and propagating

`try`/`catch` (existing sequence primitives) catches any throw, including `InvokeError`. Inside the `catch` block, the CEL context is `{ error: { code, message, data, step }, ...parentCtx }`:

- `code` — the thrown `InvokeError.code`, or `null` for plain errors.
- `message` — the thrown message.
- `data` — the `InvokeError.data`, or `undefined` for plain errors.
- `step` — the name of the step that threw.

The `SequenceError` interface at [sequence.ts:59](modules/run/nodejs/src/sequence.ts#L59) gains a `data?: unknown` field. `toSequenceError` at [sequence.ts:331](modules/run/nodejs/src/sequence.ts#L331) uses `isInvokeError(err)` to branch: for `InvokeError` it reads `code`, `message`, and `data` from the tagged instance; for anything else `code` is `null`, `data` is `undefined`. Without this, `data` would be visible inside HTTP but invisible inside sequences, and the `code` extraction would still use the current ad-hoc `(err as any).code` read — an asymmetry the reviewer flagged as a blocker.

```yaml
kind: Run.Sequence
metadata: { name: PublishWithFallbackLog }
steps:
  - name: main
    try:
      - name: auth
        invoke: { kind: Auth.VerifyToken, name: VerifyPublishToken }
        inputs:
          authorization: "${{ request.headers.authorization }}"
          namespace: "${{ request.params.namespace }}"
      - name: upload
        invoke: { kind: S3.Put, bucketRef: { name: ModuleStore } }
        inputs: { key: "${{ inputs.fileKey }}", body: "${{ inputs.body }}" }
    catch:
      # Log any structured failure before re-raising. Plain errors rethrow here too.
      - name: audit
        invoke: { kind: Sql.Exec, connection: { kind: Sql.Connection, name: Db } }
        inputs:
          sql: "INSERT INTO publish_failures (code, message, data, step) VALUES ($1, $2, $3, $4)"
          bindings:
            - "${{ error.code }}"
            - "${{ error.message }}"
            - "${{ error.data }}"
            - "${{ error.step }}"
      # Re-throw so the Http.Api catches: list handles the response shape.
      - name: rethrow
        invoke: { kind: Run.Throw }
        inputs:
          code: "${{ error.code }}"
          message: "${{ error.message }}"
          data: "${{ error.data }}"
outputs:
  published: "${{ inputs.published }}"
```

### `Run.Throw`

A new invocable in the `run` module: takes `{ code, message, data? }` and throws `InvokeError(code, message, data)`. Declared with `throws: { passthrough: true }`. Resolution rules as described above.

Taxonomic note: a step kind (`throw:` alongside `invoke:` / `try:`) would be more cohesive inside `Run.Sequence`, but it would only compose inside sequences. Keeping `Run.Throw` as an invocable lets it be used from any invocation context — direct HTTP handlers, future `Run.Parallel`, test harnesses — at the small cost that "invoke an invocable that throws" reads a bit oddly. Worth the generality.

## Analyzer enforcement

All rules below are errors (not warnings) under the "manifests must be type safe" constraint from CLAUDE.md, except where called out.

### Coverage-proving CEL forms

Rules 1 and 4 below hinge on recognizing when a `when:` clause pins `error.code` to a specific set of codes. The analyzer recognizes these forms as coverage-proving:

- `error.code == 'FOO'` — binds `{"FOO"}`.
- `error.code == 'FOO' || error.code == 'BAR' || ...` — binds the union of all equality clauses; any non-equality disjunct forfeits coverage for the whole expression.
- `error.code in ['FOO', 'BAR']` — binds the listed set.
- Parenthesization and nested `||` over equality/in are flattened.

Anything else (`.startsWith(...)`, arbitrary CEL) is runtime-valid but does not contribute to coverage — authors can still use such expressions, but they must also provide a catch-all or explicit-code entries to satisfy rule 4.

### Rules

1. **Undeclared code in `when:`.** Every code mentioned in a coverage-proving form in a `catches:` entry's `when:` must appear in the handler's declared throw union.
2. **Typed `error.data.*` access.** `error.data.<field>` references inside a `catches:` entry are type-checked against the `data` schema declared for the matched code(s). Disjunctions use the intersection of schemas — fields only present on some codes require narrowing.
3. **Cross-channel references.** `result.*` in a `catches:` entry, or `error.*` in a `returns:` entry, is a type error.
4. **Coverage.** Every code in the handler's declared throw union must be reachable from some `catches:` entry — either by coverage-proving `when:` or by a catch-all (no-`when:`) entry. An unreachable code is a warning (over-declaration); an unhandled code is an error (under-coverage). A handler whose union is unbounded (`passthrough`) must provide a catch-all.
5. **Stream-mode on catches.** `mode: stream` inside a `catches:` entry is rejected at schema validation time.
6. **Missing `returns:`.** An `Http.Api` route without a `returns:` list is rejected.
7. **Catch-all placement.** Within a `returns:` or `catches:` list, a no-`when:` entry must be the last entry. Entries following it are unreachable.
8. **`throws:` capability restriction.** `throws:` on a `Telo.Definition` whose capability is not `Telo.Invocable` or `Telo.Runnable` is a schema error.
9. **Unknown-code throw (runtime observability, not analyzer).** When a controller throws `InvokeError` with a code not in its declaration, the kernel emits `${kind}.${name}.InvokeRejected.Undeclared` but does not reject the throw.

Implementation files in `analyzer/nodejs/src/`:

- `validate-throws-coverage.ts` — rules 1, 4, 7 plus the coverage-proving CEL parser.
- `validate-channel-scope.ts` — rule 3.
- Extensions to `validate-cel-context.ts` for rule 2.
- Extensions to `manifest-schemas.ts` for rules 5, 6, 8.
- `resolve-throws-union.ts` — the `inherit: true` dataflow pass described earlier. Non-trivial: module resolution + cycle detection + memoization. Budgeted as its own work item.

## Event bus

Symmetric with the existing `${kind}.${name}.Invoked` event emitted on successful invocation ([evaluation-context.ts:377](kernel/nodejs/src/evaluation-context.ts#L377)), a failed invoke emits one of:

- `${kind}.${name}.InvokeRejected` with `{ code, message, data }` when an `InvokeError` is thrown.
- `${kind}.${name}.InvokeFailed` with `{ name: err.name, message }` for any other `Error`.
- `${kind}.${name}.InvokeRejected.Undeclared` with `{ code, message, data }` when the thrown code is not in the invocable's declared union (rule 9). Emitted in addition to `InvokeRejected`, not instead.

Event names are deliberately distinct from the class name (`InvokeError`) so grepping for one doesn't return all the other.

**Single emission point.** Events are emitted exclusively from the invoke wrapper in [evaluation-context.ts:377](kernel/nodejs/src/evaluation-context.ts#L377). Three call sites currently bypass this wrapper and must route through it:

1. **`Run.Sequence` normal path** — [sequence.ts](modules/run/nodejs/src/sequence.ts) `executeInvokeStep` already calls `ctx.invoke(ref.kind, ref.name, inputs, { retry })`; this path emits correctly today (the fourth argument is accepted by the `ResourceContext.invoke` signature but not honored by `EvaluationContext.invoke` — unchanged by this plan, noted so readers don't chase it).
2. **`Run.Sequence` scope path** — when a step runs inside an `x-telo-scope`, `executeInvokeStep` calls `scope.getInstance(ref.name).invoke(inputs)` directly. The `kind` is still in hand as `ref.kind`, so the fix is to thread it through a new `EvaluationContext` helper (see below) that accepts an already-resolved instance. No `ScopeHandle` API change needed — the kind travels with the ref, not the handle.
3. **`Http.Api` route handler** — [http-api-controller.ts:207](modules/http-server/nodejs/src/http-api-controller.ts#L207) calls `handler.invoke(invokeInput)` on the live `Invocable` injected at Phase 5. The pre-injection `route.handler` is a `KindRef<Invocable>` carrying `kind` and `name`; those are lost once the kernel overwrites the field with the live instance. The fix mirrors what `notFoundHandler` already does in [http-server-controller.ts:263-272](modules/http-server/nodejs/src/http-server-controller.ts#L263-L272): capture `{ kind, name }` via `ctx.resolveChildren(route.handler)` at resource-creation time, store them on a resolved-route struct alongside the live instance, then invoke via the new helper.

Concretely, `EvaluationContext` gains one helper:

```ts
// kernel/nodejs/src/evaluation-context.ts
async invokeResolved(kind: string, name: string, instance: Invocable, inputs: unknown): Promise<unknown> {
  // Same body as invoke(...) from line 377 onward, minus the kind/name lookup that resolves the instance —
  // caller already has it. Emits Invoked / InvokeRejected / InvokeFailed / InvokeRejected.Undeclared.
}
```

Both the sequence scope path and the HTTP route handler route through `invokeResolved`. `notFoundHandler`'s existing full `ctx.invoke(kind, name, inputs)` lookup continues to work — it's already emission-correct — and is left alone. The emission logic lives once, in `EvaluationContext`. This guarantees exactly one emission per invocation regardless of caller.

## Scope of changes

### SDK

- `sdk/nodejs/src/invoke-error.ts` (new) — `InvokeError`, `isInvokeError`, `INVOKE_ERROR` symbol.
- `sdk/nodejs/src/index.ts` — export both.

### Kernel

- `kernel/nodejs/src/evaluation-context.ts:377` — emit `InvokeRejected` / `InvokeFailed` / `InvokeRejected.Undeclared` events on thrown exception. Still re-throws. This is the single emission point (see "Event bus" above).
- `kernel/nodejs/src/evaluation-context.ts` — add `invokeResolved(kind, name, instance, inputs)` helper. Shares the emission body with `invoke(...)` — both delegate to a common private method that takes an already-resolved `Invocable`. Consumed by the sequence scope path and the HTTP route handler.
- `kernel/nodejs/src/manifest-schemas.ts` — extend `Telo.Definition` schema with `throws:` (object with `inherit?: bool`, `passthrough?: bool`, `codes?: map`). Enforce capability restriction (rule 8) and the `inherit`-requires-`x-telo-step-context` rule.
- **No `controller-registry.ts` changes.** The runtime undeclared-code check (rule 9) reads `throws.codes` directly off the loaded `ResourceDefinition` already accessible via `definitionsByKind`. The analyzer reads the same field off its own `DefinitionRegistry`. Throw-union metadata has a single source — the manifest — and each layer consumes it from its own already-existing definition store. No new cross-layer API.

### Run module

- `modules/run/nodejs/src/sequence.ts:59` — `SequenceError` interface gains `data?: unknown`.
- `modules/run/nodejs/src/sequence.ts:331` — `toSequenceError` branches on `isInvokeError` and populates `code` / `data` accordingly.
- `modules/run/nodejs/src/sequence.ts` — scope-path step-invoke replaces `scope.getInstance(ref.name).invoke(inputs)` with `ctx.invokeResolved(ref.kind, ref.name, scope.getInstance(ref.name), inputs)` so events emit exactly once. The non-scope path is unchanged (already goes through `ctx.invoke`).
- `modules/run/nodejs/src/throw.ts` (new) — `Run.Throw` invocable.
- `modules/run/telo.yaml` — declare `Run.Throw` with `throws: { passthrough: true }`; declare `Run.Sequence` with `throws: { inherit: true }`. The sequence's schema already has (or is extended to have) an `x-telo-step-context` field so `inherit: true` is legal under the new schema rule.

### HTTP server module

- `modules/http-server/telo.yaml` — route schema: `response:` removed; `returns:` and `catches:` added as lists. `catches:` entries schema-forbid `mode: stream`. `Http.Server.notFoundHandler.response` gets the same split into `returns` / `catches`.
- `modules/http-server/nodejs/src/http-api-controller.ts` —
  - `HttpApiRouteManifest`'s `response` field replaced by `returns` (required) and `catches` (optional) arrays; `ResponseEntry` type renamed/duplicated appropriately for the two channels (catches entries disallow `mode`).
  - `registerRoute` captures `{ kind, name }` via `ctx.resolveChildren(route.handler)` at registration time, stores them alongside the live `handler` instance.
  - Replace `const result = handler ? await handler.invoke(invokeInput) : undefined` with `const result = handler ? await this.ctx.invokeResolved(handlerKind, handlerName, handler, invokeInput) : undefined`. Then wrap in try/catch: `isInvokeError(err)` → dispatch via `catches:` list. Other throw → re-throw to Fastify.
  - `dispatchResponse` takes `{ result } | { error }`, picks the matching list, matches by `when:`, falls back to no-`when:` entry. If neither matches AND `isInvokeError`, render `500 { error: { code, message, data } }`; if neither matches AND not `isInvokeError`, re-throw.
- `modules/http-server/nodejs/src/http-server-controller.ts` —
  - `HttpServerResource.notFoundHandler.response?` removed; replace with `returns?` and `catches?` of the same shapes as `Http.Api`.
  - `ResolvedHandler.response?` field (line 57) split into `returns?` + `catches?`.
  - `create()` (line 263) copies `notFoundHandler.returns` / `notFoundHandler.catches` onto `resolvedNotFoundHandler` instead of `.response`.
  - `setupRoutes`'s notFoundHandler dispatch (lines 207-216) wraps the existing `ctx.invoke` in try/catch with the same `returns:` / `catches:` dispatch logic as `Http.Api` routes. `ctx.invoke` already emits events — no helper needed here.

### Analyzer

- `analyzer/nodejs/src/` — five new rule/resolver files listed above.

### Documentation

- `sdk/nodejs/README.md` — "Errors" section: class, tagging, `throws:` contract.
- `modules/http-server/docs/` — `returns:` / `catches:` reference + examples.
- `modules/run/docs/` — `try`/`catch` with structured errors, `Run.Throw`, `throws: { inherit / passthrough }`.
- `analyzer/nodejs/docs/` — the new rules.
- Wire all new doc files into `pages/docusaurus.config.ts` and `pages/sidebars.ts` per CLAUDE.md.

### Manifest migrations

Every manifest currently using `response:` is rewritten to `returns:` + `catches:`. Exhaustive list:

- `apps/registry/telo.yaml`
- `benchmarks/text-api.yaml`, `benchmarks/feedback-api.yaml` (3 occurrences each)
- `examples/feedback-api-repo.yaml` and any other `examples/**/*.yaml`
- `modules/http-server/tests/**/*.yaml`
- Any module's `tests/` that uses HTTP fixtures — grep `response:` under a route.
- `tests/**/*.yaml`
- Documentation code samples in `pages/docs/` and per-module `docs/`.

Migration procedure: `grep -rn "response:" --include="*.yaml"` across the whole repo, excluding `dist/` and `node_modules/`. Every route-level `response:` key becomes `returns:`; if the route has failure branches they become `catches:` entries. Non-route `response:` usages (e.g. field names inside resource schemas) are unaffected — review each hit.

Every invocable and runnable `Telo.Definition` in the repo is audited and gets a `throws:` block as appropriate — `{ codes: {...} }`, `{ inherit: true }`, `{ passthrough: true }`, `{ inherit: true, codes: {...} }`, or omitted (equivalent to "never throws"). Non-invocable/non-runnable definitions (services, mounts, providers, types) are checked to ensure they do not carry `throws:` (rule 8).

## Testing

### SDK unit tests

`sdk/nodejs/src/invoke-error.test.ts`:

- Constructor stores `code`, `message`, `data`.
- `isInvokeError` returns `true` for instances, `false` for plain errors.
- Cross-realm: construct via a second `require()` path (simulate pnpm split); `isInvokeError` still recognizes it via the symbol.

### Run.Sequence integration tests

`modules/run/tests/`:

- `invoke-error-caught.yaml` — `try`/`catch` around a step that throws `InvokeError("FOO", "msg", { detail: 1 })`; catch block asserts `error.code`, `error.message`, `error.data.detail`, `error.step`.
- `invoke-error-propagates.yaml` — uncaught `InvokeError` aborts the sequence; outer `catch` in a parent `try` sees it.
- `run-throw.yaml` — `Run.Throw` rethrows with preserved `code`/`data`.
- `throws-inherit.yaml` — analyzer test: a `Run.Sequence` whose inner invocables declare `[A, B]` and `[C]` has a declared union `{A, B, C}` visible to the containing `Http.Api`.

### HTTP dispatch

`modules/http-server/tests/`:

- `returns-path.yaml` — normal return, first `returns:` entry with matching `when:`.
- `catches-matched.yaml` — `InvokeError("UNAUTHORIZED")` → matched `catches:` entry returns 401 with body containing `error.message` and `error.data`.
- `catches-catchall.yaml` — `InvokeError("UNKNOWN")` with a no-`when:` entry → catch-all matches.
- `catches-unhandled-structured.yaml` — `InvokeError` with no matching entry and no catch-all → dispatcher renders `500 { error: { code, message, data } }` (not Fastify's default).
- `catches-plain.yaml` — plain `Error` → Fastify's opaque 5xx; `catches:` list not consulted.
- `cross-channel-rejected.yaml` — analyzer test: `error.*` in a `returns:` entry or `result.*` in a `catches:` entry fails validation.
- `stream-on-catches-rejected.yaml` — analyzer test: `mode: stream` in a `catches:` entry fails schema.
- `not-found-handler.yaml` — `notFoundHandler` honors `returns:` / `catches:` the same way.

### Analyzer rule tests

`analyzer/nodejs/tests/`:

- `undeclared-code.yaml` — `when: "${{ error.code == 'BOGUS' }}"` against a handler whose union doesn't include `BOGUS` → error.
- `disjunctive-coverage.yaml` — `error.code == 'A' || error.code == 'B'` proves coverage of both; mixing in a non-equality disjunct forfeits coverage.
- `in-list-coverage.yaml` — `error.code in ['A', 'B']` proves coverage.
- `typed-data-access.yaml` — `error.data.expiredAt` on a code whose `data` schema defines it → passes. Misspelled field → error. Schema-intersection narrowing across disjunctive entries.
- `uncovered-code.yaml` — handler declares `[A, B]`; `catches:` covers only `A`; no catch-all → error on `B`.
- `over-declared-code.yaml` — handler declares `[A]`; `catches:` has an entry for `B` → warning.
- `catchall-position.yaml` — no-`when:` entry followed by another entry → error.
- `throws-on-non-invocable.yaml` — `throws:` on a `Telo.Service` definition → schema error.
- `inherit-union.yaml` — `Run.Sequence` containing invocables declaring `[A, B]` and `[C]` exposes union `{A, B, C}` to the enclosing `catches:` list; codes caught inside the sequence are subtracted.
- `inherit-cycle.yaml` — a definition that transitively refers to itself is handled without infinite recursion.
- `passthrough-outside-catch.yaml` — `Run.Throw` with `inputs.code: "${{ request.headers.x }}"` outside a `catch` → error.
- `passthrough-inside-catch.yaml` — `Run.Throw` with `inputs.code: "${{ error.code }}"` inside a `catch` whose `try` block propagated `[A, B]` → the rethrow's contribution is `[A, B]`.

### Event bus tests

`kernel/nodejs/tests/` (or wherever event tests live):

- Successful invoke → `Invoked` event.
- `InvokeError` thrown with declared code → `InvokeRejected` event with `{ code, message, data }`.
- `InvokeError` thrown with undeclared code → `InvokeRejected` plus `InvokeRejected.Undeclared`.
- Plain throw → `InvokeFailed` event with `{ name, message }`.

## Rollout phases

This is a sequencing split, not a scope reduction. Everything above lands; the only question is across how many PRs.

### Phase 1 — Channel and explicit contracts

Lands the core channel end-to-end with explicit per-code declarations only. No dataflow inference.

- `InvokeError` + `isInvokeError` in the SDK; kernel event emission; `throws.codes` map on `Telo.Definition` (no `inherit:` / `passthrough:`).
- `Http.Api` `returns:` / `catches:` schema + dispatcher; `response:` removal.
- `toSequenceError` + `SequenceError.data`; `Run.Sequence` step-invoke routed through the shared emission wrapper.
- Analyzer rules 1, 2, 3, 4 (coverage over explicitly-declared unions only), 5, 6, 7, 8, 9.
- All manifest migrations (`response:` → `returns:`/`catches:`, every invocable/runnable audited for explicit `throws.codes`).
- Docs for the above.

After Phase 1, `Run.Sequence` cannot declare `throws: { inherit: true }`; any sequence used as an HTTP handler must itself declare its codes explicitly.

### Phase 2 — Dataflow inference

Lands `inherit:` and `passthrough:` (and `Run.Throw`), which require the analyzer dataflow pass.

- `resolve-throws-union.ts` with module-boundary lookups, cycle detection, memoization.
- `x-telo-step-context`-driven generic traversal for `inherit: true`.
- `passthrough: true` resolution (constant + in-catch forms).
- `Run.Throw` invocable.
- `Run.Sequence` `throws: { inherit: true }` declaration.
- Analyzer rule 4 extension for unbounded (`passthrough`) unions.
- Docs for `inherit:` / `passthrough:` / `Run.Throw`.

Phase 2 is additive — Phase 1 manifests keep working.

## Open questions

None — every decision above is intended to be final. Flag any in review.
