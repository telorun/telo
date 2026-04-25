# Plan — `Ai.Model` abstract + `Ai.Completion` + first-party provider packages

Final implementation. Not versioned; what ships is the shape the module keeps. Orthogonal features (streaming, tool-use agents) become separate kinds in separate plans, not v0.2 of these ones.

## 0. Scope

**In scope:**

- `Ai.Model` — `Telo.Abstract` declaring the LLM-call contract.
- `Ai.Completion` — `Telo.Invocable` that delegates single-turn LLM calls to any `Ai.Model` implementation.
- First-party provider kind: `Ai.OpenaiModel`.
- Internal test fixture: `Ai.EchoModel`.
- Prerequisite kernel + analyzer work: runtime controller for `Telo.Abstract`, and first-class `extends` on `Telo.Definition` (lifecycle `capability` and abstract-implementation `extends` as orthogonal axes, per the design in [kernel/docs/inheritance.md](../../../kernel/docs/inheritance.md)).

**Out of scope (separate future kinds, not versions of these):**

- Streaming consumer (`Ai.Stream` kind) → a future kind sharing the same `Ai.Model` abstract and the same provider resources; see §12. Providers ship `stream()` on their runtime instance from day 1, so `Ai.Stream` is additive — no provider work, no kernel work, no contract break.
- Tool use / function calling → lives in the `Ai.Agent` / `Ai.Worker` kinds (see [README.md](../README.md) for the long-term shape).
- Multimodal (image/audio input) → additive later via a `content: string | ContentPart[]` union. Today `content: string` is locked in; widening to a union is non-breaking.
- Structured outputs / JSON-mode → deliberately not in the core contract; providers may expose it via `options`.

## 1. Verified assumptions

Before writing this plan the kernel + analyzer code path for library-declared abstracts was checked. Findings (all citations from the repo):

- Analyzer registers user-declared `Telo.Abstract` docs into `DefinitionRegistry` via the Phase 1 `register()` call at [analyzer.ts:368](../../../analyzer/nodejs/src/analyzer.ts#L368).
- Cross-package `x-telo-ref: "<namespace>/<module>#<Type>"` is resolved via `identityMap` ([definition-registry.ts:118-126](../../../analyzer/nodejs/src/definition-registry.ts#L118-L126)), and abstract references are validated against the `extendedBy` set ([validate-references.ts:35-45](../../../analyzer/nodejs/src/validate-references.ts#L35-L45)). Module identities are registered on library load via `registerModuleIdentity` ([kernel.ts:203-209](../../../kernel/nodejs/src/kernel.ts#L203-L209)).
- Phase 5 reference injection ([kernel.ts:560-576](../../../kernel/nodejs/src/kernel.ts#L560-L576)) replaces an `x-telo-ref` field value with the live `ResourceInstance` before `init()` runs. `Ai.Completion`'s controller reads `resource.model.invoke(...)` directly — no `getResourcesByName` lookup needed.
- `ctx.invoke(kind, name, inputs)` and direct `instance.invoke({...})` both exist; the kernel only checks for the presence of an `invoke` method ([evaluation-context.ts:406-411](../../../kernel/nodejs/src/evaluation-context.ts#L406-L411)), so whichever path is cleaner at the call site works.
- `snapshot()` is called on every resource ([evaluation-context.ts:217-220](../../../kernel/nodejs/src/evaluation-context.ts#L217-L220)) and its return value becomes CEL-visible as `resources.<name>`. There is no shared redaction machinery; controllers must omit secrets themselves.

Two kernel/analyzer gaps remain — both addressed in §2:

1. **No runtime controller for `Telo.Abstract`.** Importing a library that declares an abstract currently blows up at `_createInstance` with "No controller registered for kind 'Telo.Abstract'".
2. **`extends` is documented but not implemented.** [kernel/docs/inheritance.md](../../../kernel/docs/inheritance.md) specifies `capability` (lifecycle role) and `extends` (implements-this-abstract) as orthogonal axes, but grep turns up zero `extends`-reading code. `extendedBy` is populated from `capability` at [definition-registry.ts:35-41](../../../analyzer/nodejs/src/definition-registry.ts#L35-L41), forcing implementations to overload `capability: <AbstractKind>` (what [modules/workflow-temporal/telo.yaml:14](../../../modules/workflow-temporal/telo.yaml#L14) does) and losing the ability to distinguish lifecycle role from abstract implementation. The docs describe the right architecture; the analyzer needs to catch up before the AI module lands, so `Ai.OpenaiModel` can declare `capability: Telo.Invocable, extends: Ai.Model` — lifecycle and contract cleanly separated.

## 2. Part A — Kernel + analyzer prerequisite: library-declared abstracts

Bring the kernel and analyzer up to what [kernel/docs/inheritance.md](../../../kernel/docs/inheritance.md) promises. Two orthogonal fixes land together — they share tests and their combined surface is what the AI module will use.

### 2.1 Runtime controller for `Telo.Abstract`

The analyzer registers abstracts into `DefinitionRegistry` during analysis, but the kernel's runtime init loop has no controller for `kind: Telo.Abstract`. When an import loads a library containing an abstract doc, [evaluation-context.ts:191](../../../kernel/nodejs/src/evaluation-context.ts#L191) calls `_createInstance`, which throws `"No controller registered for kind 'Telo.Abstract'"` at [kernel.ts:478-485](../../../kernel/nodejs/src/kernel.ts#L478-L485). This is why `modules/workflow` is marked "planned to be implemented, it is not available yet" in its README — it has no end-to-end test.

Fix: add a minimal meta-controller in the same shape as the `Telo.Definition` controller at [resource-definition-controller.ts](../../../kernel/nodejs/src/controllers/resource-definition/resource-definition-controller.ts).

### 2.2 `extends` — implements-this-abstract, first-class

Implement the axis the docs already describe. A `Telo.Definition` gains an optional `extends` field whose value is an **alias-form string** `"<Alias>.<AbstractName>"` (e.g. `Ai.Model`, `Workflow.Backend`). The alias is resolved against the declaring file's own `Telo.Import` declarations — the same mechanism that resolves kind prefixes like `kind: Http.Api`. The analyzer pre-resolves via `AliasResolver.resolveKind` before registration; `extendedBy` is keyed by the canonical kind (e.g. `ai.Model`).

Why alias form rather than the identity form `"<ns>/<mod>#<Name>"`? Because aliases pin the target's module version through the `Telo.Import` source (`source: pkg:npm/@telorun/ai@1.2.3`, a file path, a registry ref), and the alias already names a live binding in the file. Identity strings duplicate resolution paths and lose the version edge the import provides. Same-library `extends` is not supported — implementations and abstracts live in different libraries, matching the workflow + workflow-temporal split pattern.

Diagnostics:

- **`EXTENDS_MALFORMED`** — value is not in `"<Alias>.<Name>"` shape, or the alias prefix is not a registered `Telo.Import` in the declaring file's scope.
- **`EXTENDS_UNKNOWN_TARGET`** — alias resolves to a module, but that module exports no kind with the target name.
- **`EXTENDS_NON_ABSTRACT`** — `extends` target must be `kind: Telo.Abstract`, not a `Telo.Definition`.
- **`CAPABILITY_SHADOWS_EXTENDS`** — if `capability` names a **user-declared** abstract (i.e. one whose `metadata.module !== "Telo"`), emit a warning suggesting `extends`. Telo-builtin abstracts (`Telo.Invocable`, `Telo.Provider`, `Telo.Service`, `Telo.Runnable`, `Telo.Mount`, `Telo.Type`, `Telo.Template`) never trigger this — they're lifecycle roles by design. The guard is precisely `target?.metadata.module !== "Telo"`.

The analyzer continues to accept `capability: <AbstractKind>` as an implicit `extends` (backward-compat) — `extendedBy` is populated from both `capability` and `extends`, unioned. This lets third-party modules not-yet-migrated keep working, while the canonical pattern becomes `capability: <Lifecycle>, extends: <Alias>.<Name>`.

As part of this work, migrate `modules/workflow-temporal/telo.yaml` from `capability: Workflow.Backend` to `capability: Telo.Provider, extends: Workflow.Backend` — bringing the canonical example in line with the docs. No behavioural change; the analyzer's compat union keeps tests green throughout.

### 2.3 Preserve instance prototype through the runtime-eval wrap

Discovered while verifying the `stream()` contract in §3.3: when a definition has runtime-eval paths, `_createInstance` at [kernel.ts:542-548](../../../kernel/nodejs/src/kernel.ts#L542-L548) wraps the returned instance as:

```ts
const wrapped: ResourceInstance = {
  ...instance,
  invoke: async (inputs) => instance.invoke!(evalContext.expandPaths(inputs, runtime)),
};
```

Object spread copies **own enumerable properties only**. Class-instance providers (the natural shape when wrapping Vercel AI SDK clients, Temporal clients, etc.) define `invoke`, `stream`, `snapshot`, `init`, `teardown` on the prototype — none survive the spread. The current repo dodges it because every controller returns a plain object literal, but that's a convention, not a contract. With `stream()` entering the AI provider contract, the wrap becomes a real landmine: a provider class with `stream()` on the prototype would silently lose it on any manifest whose definition has runtime-eval paths (which is most AI use cases once `options` contains a `${{ variables.temperature }}` expression).

Fix: replace the spread with a form that preserves the prototype chain:

```ts
const wrapped: ResourceInstance = Object.assign(
  Object.create(Object.getPrototypeOf(instance)),
  instance,
  {
    invoke: async (inputs) => instance.invoke!(evalContext.expandPaths(inputs, runtime)),
  },
);
```

`Object.create(Object.getPrototypeOf(instance))` yields a new object inheriting from the same prototype; `Object.assign` copies own properties over; the override re-sets `invoke`. Class methods on the prototype now resolve through `wrapped`. This also fixes latent issues for `snapshot()` / `teardown()` / `init()` on any class-based controller that happens to declare runtime-eval paths.

Orthogonal to the `extends` / abstract-controller work, but bundled into Part A because (a) it's small, (b) it's on the path between "we promise `stream()` on the provider instance" and "`stream()` actually survives the kernel's plumbing," and (c) Part A's test harness catches regressions in the same test run.

### 2.4 Files changed

| File                                                                       | Change                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel/nodejs/src/controllers/resource-definition/abstract-controller.ts` | **New.** Meta-controller: `create()` returns a ResourceInstance whose `init()` calls `ctx.registerDefinition(this.resource)` so the abstract is visible to `ControllerRegistry.getDefinition` for capability-chain resolution. No controller load, no template wrapper.                                                               |
| `kernel/nodejs/src/kernel.ts`                                              | (a) In `loadBuiltinDefinitions()` (around line 147), register the new abstract controller: `this.controllers.registerController("Telo.Abstract", await import("./controllers/resource-definition/abstract-controller.js"))`. (b) Replace the runtime-eval wrap at lines 542-548 with the prototype-preserving form described in §2.3. |
| `kernel/nodejs/src/manifest-schemas.ts`                                    | Extend the schema catch-all to accept `kind: "Telo.Abstract"` with optional `capability`, optional `schema`, forbidden `controllers`. Also add `extends: string` as an optional field on `Telo.Definition`, pattern-matched against the alias form `^[A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$`.                                        |
| `analyzer/nodejs/src/analyzer.ts` (Phase 1)                                | Alongside the existing `capability` pre-resolution, also pre-resolve `extends` via `AliasResolver.resolveKind` before calling `DefinitionRegistry.register`, so `extendedBy` is keyed by the canonical form.                                                                                                                          |
| `analyzer/nodejs/src/definition-registry.ts`                               | In `register()`, when `definition.extends` is set (already canonical after pre-resolution), populate `extendedBy` from it. Keep the existing `capability`-based population as union-merged backward-compat.                                                                                                                           |
| `analyzer/nodejs/src/analyzer.ts`                                          | Add a new validation pass that walks every `Telo.Definition` and emits `EXTENDS_MALFORMED` / `EXTENDS_UNKNOWN_TARGET` / `EXTENDS_NON_ABSTRACT` / `CAPABILITY_SHADOWS_EXTENDS` diagnostics per §2.2.                                                                                                                                   |
| `modules/workflow-temporal/telo.yaml`                                      | Migrate: `capability: Telo.Provider, extends: Workflow.Backend` (canonical form). The existing `Telo.Import name: Workflow` declaration provides the alias resolution.                                                                                                                                                                |
| `kernel/docs/inheritance.md`                                               | Update examples to the alias-form `extends` syntax (e.g. `extends: Workflow.Backend` inside a file whose `Telo.Import` declares the `Workflow` alias), and remove any wording that reads as aspirational now that the pattern is real.                                                                                                |
| `sdk/nodejs/src/*` (types)                                                 | Add `extends?: string` to the `ResourceDefinition` type exported by the SDK.                                                                                                                                                                                                                                                          |

### 2.5 Test coverage

- **Kernel unit test (abstract registration)** — load a tiny Application that imports a Library declaring `Telo.Abstract Foo` and a `Telo.Definition Bar` with `capability: Telo.Invocable, extends: Lib.Foo`. Assert the kernel boots, both are registered, and a `x-telo-ref: "<ns>/lib#Foo"` slot on a third resource accepts `Bar` at runtime.
- **Kernel unit test (prototype preservation)** — controller returns a class instance with `invoke()`, `stream()`, `snapshot()` on the prototype; the kind's definition has `x-telo-eval: runtime` on one property (forcing the wrap path). Assert `wrapped.stream` and `wrapped.snapshot` are callable and produce the expected results. Regression guard against the wrap losing prototype methods again.
- **Analyzer unit tests** — one test per diagnostic:
  - `extends` not in alias form (e.g. identity string `"std/ai#Model"` or a bare name) → `EXTENDS_MALFORMED`.
  - `extends` alias is not a registered `Telo.Import` in the file → `EXTENDS_MALFORMED`.
  - `extends` alias resolves but target kind doesn't exist in the imported module → `EXTENDS_UNKNOWN_TARGET`.
  - `extends` targets a `Telo.Definition` (not abstract) → `EXTENDS_NON_ABSTRACT`.
  - `capability` names a user abstract (module ≠ `"Telo"`) → `CAPABILITY_SHADOWS_EXTENDS` warning; validation still passes so legacy manifests keep running.
  - `capability: Telo.Invocable` (builtin abstract, module = `"Telo"`) → **no** warning. Explicit regression test.
  - `capability: Telo.Invocable, extends: <Alias>.<Name>` → no diagnostics, `extendedBy` correctly populated for both.
- **Integration test** — repurpose [examples/workflow-temporal.yaml](../../../examples/workflow-temporal.yaml) into `modules/workflow/tests/workflow-import-smoke.yaml`. Validates (without a real Temporal server) that the module imports cleanly, `extends` resolves, and refs from `Workflow.Graph.backend` accept the migrated `Temporal.Backend`. Workflow's own execution stays a separate concern.

### 2.6 Changeset

One changeset covering `@telorun/kernel`, `@telorun/analyzer`, and `@telorun/sdk` (type addition). Minor bump — `extends` is a new supported field, runtime behaviour for library-declared abstracts is new, the instance wrap now preserves prototype methods. Message: "kernel/analyzer: library-declared Telo.Abstract + first-class `extends` + prototype-preserving instance wrap."

Part A is its own PR, merged before Part B starts. No AI code touches main until Part A is green. The analyzer's backward-compat union means existing modules (`workflow-temporal` pre-migration, any third-party code using `capability: <Abstract>`) keep working throughout; the canonical pattern is additive.

## 3. Part B — `@telorun/ai`: abstract + completion + internal fixture

### 3.1 Directory layout

```
modules/ai/
├── README.md                                   # rewritten — see §9
├── telo.yaml                                   # Telo.Library + Telo.Abstract(Model) + Telo.Definition(Completion)
├── docs/
│   ├── ai-model.md                             # the implementer's contract — external surface
│   └── ai-completion.md
├── tests/
│   ├── __fixtures__/
│   │   └── ai-echo.yaml                        # Library + Telo.Import Ai + Ai.EchoModel extends Ai.Model
│   ├── completion-prompt-shorthand.yaml
│   ├── completion-messages-array.yaml
│   ├── completion-system-manifest-and-runtime.yaml
│   ├── completion-input-exclusivity.yaml
│   ├── completion-options-merge.yaml
│   ├── completion-rejects-non-model-ref.yaml
│   └── completion-error-propagation.yaml
└── nodejs/
    ├── package.json                            # name: @telorun/ai
    ├── tsconfig.json / tsconfig.lib.json / tsconfig.spec.json
    └── src/
        ├── index.ts
        ├── ai-completion-controller.ts         # Invocable
        ├── ai-echo-controller.ts               # Invocable — internal test fixture
        └── redact.ts                           # shared helper (see §7)
```

Echo is declared in a **separate** `Telo.Library` (`tests/__fixtures__/ai-echo.yaml`) rather than `modules/ai/telo.yaml`. The reason is the alias-form `extends` rule: a definition can only extend an abstract reachable through a `Telo.Import` in its own file. `@telorun/ai`'s own `telo.yaml` doesn't import itself (nor should it), so EchoModel lives in a fixture library that does import `@telorun/ai` as `Ai` — exactly the pattern every external provider package will follow. This also keeps the production library free of test fixtures and makes the echo fixture exercise the same code path a third-party provider would.

### 3.2 `modules/ai/telo.yaml`

```yaml
kind: Telo.Library
metadata:
  name: ai
  namespace: std
  version: 1.0.0
  description: LLM completion primitives with pluggable provider models
exports:
  kinds:
    - Model
    - Completion
---
kind: Telo.Abstract
metadata:
  name: Model
capability: Telo.Invocable
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      messages:
        type: array
        minItems: 1
        items:
          type: object
          properties:
            role: { type: string, enum: [system, user, assistant] }
            content: { type: string }
          required: [role, content]
          additionalProperties: false
      options:
        type: object
        additionalProperties: true
    required: [messages]
    additionalProperties: false
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      text: { type: string }
      usage:
        type: object
        properties:
          promptTokens: { type: integer, minimum: 0 }
          completionTokens: { type: integer, minimum: 0 }
          totalTokens: { type: integer, minimum: 0 }
        required: [promptTokens, completionTokens, totalTokens]
        additionalProperties: false
      finishReason:
        type: string
        enum: [stop, length, content-filter, error, other]
    required: [text, usage, finishReason]
    additionalProperties: false
---
kind: Telo.Definition
metadata:
  name: Completion
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/ai@1.0.0?local_path=./nodejs#completion
schema:
  type: object
  properties:
    model:
      title: Model
      description: Reference to any Ai.Model implementation.
      x-telo-ref: "std/ai#Model"
    system:
      title: System prompt
      description: Default system message. Runtime inputs.system takes precedence when set.
      type: string
    options:
      title: Options
      description: Completion-level option overrides (shallow-merged over the model's options, overridden by runtime inputs.options).
      type: object
      additionalProperties: true
  required: [model]
  additionalProperties: false
```

### 3.2a `modules/ai/tests/__fixtures__/ai-echo.yaml`

Echo lives in its own tiny Library so it can `extends: Ai.Model` against a `Telo.Import` of `@telorun/ai` — same pattern the external provider packages use. Keeps the production `@telorun/ai` library free of test fixtures and exercises the alias-form `extends` path exactly like a third-party provider would.

```yaml
kind: Telo.Library
metadata:
  name: ai-echo
  namespace: std
  version: 1.0.0
  description: Internal Ai.Model test fixture. Echoes the last message back.
exports:
  kinds:
    - EchoModel
---
kind: Telo.Import
metadata:
  name: Ai
source: ../.. # resolves to @telorun/ai's telo.yaml (same package)
---
kind: Telo.Definition
metadata:
  name: EchoModel
capability: Telo.Invocable
extends: Ai.Model # ← alias-form, resolved via Telo.Import Ai above
controllers:
  - pkg:npm/@telorun/ai@1.0.0?local_path=./nodejs#echo-model
schema:
  type: object
  properties:
    suffix:
      title: Suffix
      description: Appended to the echoed content. Default empty.
      type: string
  additionalProperties: false
```

Notes:

- Each provider/fixture declares `capability: Telo.Invocable` (the lifecycle role) and `extends: Ai.Model` (the abstract contract it satisfies), with the `Ai` alias resolved against that file's own `Telo.Import` of `@telorun/ai`. This matches the canonical workflow + workflow-temporal pattern.
- `Ai.Completion.model` is typed via `x-telo-ref: "std/ai#Model"` (identity form is used for schema-level refs since a schema is part of its module's public API and must resolve without depending on the caller's aliases). The analyzer validates references against the abstract's `extendedBy` set, populated from every definition's `extends` edge (after alias resolution).
- `inputType` / `outputType` on the abstract describe the **`invoke()`** method only — the buffered path used by `Ai.Completion`. The second method, `stream()`, is specified at the runtime-instance level in §3.3 and is not expressible in the typed-abstracts schema today. If and when typed-abstracts grows support for per-method contracts (and a streaming consumer kind lands — see §12), `stream()` picks up formal enforcement. Until then it's documented convention, validated by provider tests.
- `inputType` / `outputType` are written in the shape the companion plan [`kernel/nodejs/plans/typed-abstracts.md`](../../../kernel/nodejs/plans/typed-abstracts.md) expects. Today they sit as documentation-grade annotations; the completion controller enforces the output shape at runtime (§3.4). When typed-abstracts lands, enforcement becomes automatic and the ad-hoc check is removed.

### 3.3 `Ai.Model` — runtime-instance contract

Every provider's `create()` returns a `ResourceInstance` exposing **two methods** plus the usual lifecycle hooks. Which method gets called is determined by the **consumer kind** (`Ai.Completion` vs future `Ai.Stream`), not by a flag in the input. This keeps output shapes statically typed per consumer and keeps the `options` bag reserved for model tuning rather than contract-selection.

```ts
type Message = { role: "system" | "user" | "assistant"; content: string };
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };
type FinishReason = "stop" | "length" | "content-filter" | "error" | "other";

interface AiModelInstance extends ResourceInstance {
  // Buffered. Used by Ai.Completion.
  invoke(input: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): Promise<{ text: string; usage: Usage; finishReason: FinishReason }>;

  // Streaming. Used by future Ai.Stream (§12).
  // Returns an async iterable of tagged parts. The consumer reads parts until the stream ends;
  // the final `finish` part carries usage and finishReason. Errors arrive as an `error` part
  // and also cause the iterator to throw on next advance — whichever the consumer sees first.
  stream(input: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): AsyncIterable<StreamPart>;

  snapshot(): Record<string, unknown>; // must redact secrets — see §7
}

type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: Error };
```

Rationale:

- **No `stream: boolean` flag.** Vercel AI SDK itself splits `generateText` from `streamText`; we mirror that split at the abstract level. The kind picks the method; no runtime branching on an options field.
- **Single `AsyncIterable<StreamPart>` instead of `{chunks, final}` pair.** One handle to manage. Consumers that forward to SSE map `text-delta` chunks directly; consumers that care about usage wait for the `finish` part.
- **`error` part is structural.** The iterator protocol already supports throwing, but emitting an explicit `error` part lets SSE-forwarders surface partial-response errors without losing already-sent deltas. Providers may use either mechanism; consumers handle both.
- **Kernel-level impact (once Part A lands): none.** Phase 5 injects the live `ResourceInstance` as `resource.model`; `invoke()` and `stream()` are just JS methods on that instance. The kernel's runtime-eval wrap at [kernel.ts:542-548](../../../kernel/nodejs/src/kernel.ts#L542-L548) would otherwise strip prototype methods from class-based providers, but §2.3 fixes that. Providers may return either plain objects or class instances.
- **`stream()` from day 1 even though nothing calls it yet.** Providers implement both methods in this plan. The marginal cost is tiny — Vercel AI SDK gives both for free — and pre-committing means the future consumer kind (§12) lands as a pure additive PR inside `@telorun/ai` with zero provider work, zero breaking changes.

### 3.4 `Ai.Completion` — runtime invocation contract

Manifest fields (resource declaration):

| Field     | Type   | Required | Purpose                                       |
| --------- | ------ | -------- | --------------------------------------------- |
| `model`   | ref    | yes      | Any `Ai.Model` implementation.                |
| `system`  | string | no       | Default system prompt. Runtime override wins. |
| `options` | object | no       | Completion-level option defaults.             |

Invocation inputs (`ctx.invoke("Ai.Completion", name, inputs)`):

| Field      | Type   | Required                       | Purpose                                                            |
| ---------- | ------ | ------------------------------ | ------------------------------------------------------------------ |
| `prompt`   | string | exactly one of prompt/messages | Shorthand; wraps to `messages: [{role: "user", content: prompt}]`. |
| `messages` | array  | exactly one of prompt/messages | Full turns, each `{role, content}`.                                |
| `system`   | string | no                             | Runtime system override. Wins over manifest `system`.              |
| `options`  | object | no                             | Per-call option overrides.                                         |

Output: `{ text, usage, finishReason }` — forwarded from the resolved model's `invoke()`, validated by the completion controller before return.

### 3.5 `ai-completion-controller.ts`

```
create(resource, ctx) → ResourceInstance {
  invoke(inputs) {
    1. Validate input exclusivity: exactly one of inputs.prompt / inputs.messages set.
    2. Build canonical messages:
        base = inputs.messages ?? [{role: "user", content: inputs.prompt}]
        system = inputs.system ?? resource.system
        if system and base[0].role !== "system":
          messages = [{role: "system", content: system}, ...base]
        else:
          messages = base
          (if system set and base[0].role === "system": runtime system wins — replace base[0].content)
    3. Merge options: shallow merge, downstream wins.
        merged = { ...resource.options, ...inputs.options }
        (model-level options live on the model resource and are merged there.)
    4. Delegate: result = await resource.model.invoke({messages, options: merged})
       — resource.model is the live ResourceInstance injected in Phase 5.
    5. Validate result shape against the Ai.Model output schema; throw RuntimeError("ERR_CONTRACT_VIOLATION", ...) if off-contract.
    6. Return result unchanged.
  }
  snapshot() { return {}; }  // stateless; no config worth exposing
}
```

No retries, no error translation, no swallowing. Vendor errors surface through the provider unchanged.

### 3.6 `ai-echo-controller.ts`

Test fixture. Implements the full `AiModelInstance` contract from §3.3 — both methods.

- `invoke({messages, options})` → `{ text: lastMessage.content + (resource.suffix ?? ""), usage: zeros, finishReason: "stop" }`
- `stream({messages, options})` → async iterable yielding:
  - one `{type: "text-delta", delta: char}` per character of the echo text (so streaming tests have multiple chunks to observe)
  - a final `{type: "finish", usage: zeros, finishReason: "stop"}`

Used as the hermetic fixture for §8.1 tests (both `Ai.Completion` and, once it lands, `Ai.Stream`). Also the canonical walkthrough in `docs/ai-model.md`.

## 4. Part C — Provider packages

Three first-party packages, all shipped together. Structure is identical per package — pick OpenAI as the template.

### 4.1 Directory layout (per provider)

```
modules/ai-openai/
├── README.md
├── telo.yaml
├── docs/ai-openai-model.md
├── tests/
│   ├── openai-snapshot-redacts-secrets.yaml    # hermetic
│   └── openai-live-completion.yaml             # env-gated (OPENAI_API_KEY)
└── nodejs/
    ├── package.json                            # name: @telorun/ai-openai
    └── src/openai-model-controller.ts
```

### 4.2 `modules/ai-openai/telo.yaml`

```yaml
kind: Telo.Library
metadata:
  name: ai-openai
  namespace: std
  version: 1.0.0
  description: OpenAI provider for Ai.Model
exports:
  kinds:
    - OpenaiModel
---
# Import @telorun/ai so the `Ai` alias is available for `extends` below.
kind: Telo.Import
metadata:
  name: Ai
source: "pkg:npm/@telorun/ai@^1.0.0"
---
kind: Telo.Definition
metadata:
  name: OpenaiModel
capability: Telo.Invocable
extends: Ai.Model
controllers:
  - pkg:npm/@telorun/ai-openai@1.0.0?local_path=./nodejs#openai-model
schema:
  type: object
  properties:
    model:
      title: Model ID
      description: OpenAI model identifier passed to the API (e.g. gpt-4o, gpt-4o-mini).
      type: string
    apiKey:
      title: API Key
      description: Secret reference, e.g. ${{ secrets.OPENAI_API_KEY }}.
      type: string
      x-telo-eval: compile
    baseUrl:
      title: Base URL
      description: Optional override for the OpenAI API base URL (Azure OpenAI, compatible gateways).
      type: string
      x-telo-eval: compile
    options:
      title: Options
      description: Model-level defaults (temperature, maxTokens, topP, ...). Merged under completion- and invocation-level overrides.
      type: object
      additionalProperties: true
  required: [model, apiKey]
  additionalProperties: false
```

`ai-anthropic` and `ai-ollama` follow the same shape with per-vendor fields:

- **`ai-anthropic`** — `model`, `apiKey`, `baseUrl?`, `options?`. Controller extracts any leading `role: "system"` message and passes it to Anthropic's SDK as the top-level `system` parameter (Anthropic's API doesn't accept system messages inline).
- **`ai-ollama`** — `model`, `baseUrl` (required, defaults to `http://localhost:11434` if omitted), `options?`. No `apiKey`.

### 4.3 Provider controller responsibilities (uniform)

Each provider implements the full `AiModelInstance` contract from §3.3 — both `invoke()` and `stream()` — using Vercel AI SDK's `generateText` and `streamText` under the hood.

1. **Init:** construct an SDK client bound to `resource.apiKey` / `resource.baseUrl`. Keys are compile-evaluated (`x-telo-eval: compile`) so they resolve at load time from `secrets.*`.
2. **Message translation** (shared between `invoke` and `stream`): translate the canonical `{role, content}` messages to the vendor shape.
   - OpenAI: pass-through.
   - Anthropic: extract any leading `role: "system"` message and pass it as the top-level `system` parameter (Anthropic's API doesn't accept system messages inline).
   - Ollama: pass-through.
3. **Option merging** (shared): `providerDefaults ⊕ resource.options ⊕ options`. Shallow, downstream wins. `providerDefaults` are minimal — temperature/maxTokens defaults that mirror Vercel AI SDK's so swapping providers doesn't silently change behaviour. Full merge order including `Ai.Completion.options` is completed inside the completion controller before the model sees the call; see §3.5.
4. **`invoke({messages, options})`:**
   - Call `generateText({model, messages: translated, ...merged})`.
   - Normalize the result to `{text, usage, finishReason}`. Map vendor-specific finish reasons into the enum; unknown values map to `"other"`.
5. **`stream({messages, options})`:**
   - Call `streamText({model, messages: translated, ...merged})`.
   - Return an `AsyncIterable<StreamPart>` (per §3.3) produced by an `async function*` that:
     - yields `{type: "text-delta", delta}` for each text delta from Vercel's `textStream`
     - on completion, awaits `usagePromise` / `finishReasonPromise` and yields a final `{type: "finish", usage, finishReason}`
     - on error, yields `{type: "error", error}` and then terminates (throwing is also acceptable — consumers handle both)
   - The stream is single-consumer. Providers must not tee it; if multi-consumer support is ever needed it's an explicit future feature.
6. **Snapshot:** `redact(["apiKey"], resource)` — see §7. Never emit raw secret material into `resources.<name>`.
7. **Errors:** bubble through for `invoke`. For `stream`, errors surface via the `error` part (or by the iterator throwing). No retry, no error swallowing. Vendor error messages stay intact so users can see rate limits, invalid keys, etc.

## 5. Option merging — fully specified

Four conceptual layers, three of them user-visible:

| #   | Source                         | Owner                                     | When                                                    |
| --- | ------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| 0   | Provider hard defaults         | Inside each provider controller           | Compiled in, never user-visible. Intentionally minimal. |
| 1   | `Ai.<Provider>Model.options`   | User manifest, on the model resource      | Per-model configuration.                                |
| 2   | `Ai.Completion.options`        | User manifest, on the completion resource | Per-use-case override.                                  |
| 3   | `inputs.options` at invocation | User CEL, at the call site                | Per-call override.                                      |

**Merge is shallow and strictly in that order**, downstream wins:

```
final = { ...layer0, ...layer1, ...layer2, ...layer3 }
```

Layer 1 lives inside the provider controller (merged before vendor call). Layers 2 and 3 are merged inside `Ai.Completion` before it hands `options` to the model. The provider therefore receives exactly layers 2 + 3 merged as `options`, and merges layer 0 + 1 on top of that internally.

No deep merge. `options.providerSpecific.timeouts = {...}` replaces the whole `providerSpecific` object when overridden. This is documented on each provider's schema.

## 6. SDK choice — Vercel AI SDK

All three providers use the Vercel AI SDK (`ai` core + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `ollama-ai-provider-v2`). Reasons:

- Already normalizes `{text, usage, finishReason}` — our output shape is a direct passthrough, no translation layer to maintain.
- Multi-provider testing (`generateText({model: openai("gpt-4o"), ...})`) eliminates the bulk of per-provider adapter code.
- Future-compatible with `streamText`, so the eventual `Ai.Stream` kind uses the same provider-side client.

Peer dep strategy: each provider package lists its vendor SDK (`@ai-sdk/openai`, etc.) as a regular dependency of the provider package. `@telorun/ai` itself has no AI SDK dependency — it only declares the contract and the Echo fixture.

## 7. `snapshot()` redaction helper

`@telorun/ai` exports `redact(fields: string[], obj: unknown): unknown` — a small utility that returns a shallow copy of `obj` with the given top-level keys omitted. Each provider's `snapshot()`:

```ts
snapshot() {
  return redact(["apiKey"], this.resource);
}
```

Shared helper instead of per-provider open-coded omission so the convention is visible and testable in one place. Third-party providers can import it the same way.

Tested via `openai-snapshot-redacts-secrets.yaml` (and analogues): load an `Ai.OpenaiModel` with `apiKey: "sk-sentinel"`, assert `resources.TheModel.apiKey` is absent from the snapshot visible in CEL.

## 8. Tests

### 8.1 `modules/ai/tests/` (hermetic, use Ai.EchoModel)

| File                                          | Asserts                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completion-prompt-shorthand.yaml`            | `inputs.prompt` → Echo returns `{text: prompt, usage: zeros, finishReason: stop}`.                                                                                |
| `completion-messages-array.yaml`              | `inputs.messages` passes through untouched; Echo returns last message's content.                                                                                  |
| `completion-system-manifest-and-runtime.yaml` | Manifest `system` prepended when no inline system; runtime `inputs.system` replaces manifest system; runtime system wins over an inline system message.           |
| `completion-input-exclusivity.yaml`           | Both of prompt/messages set → throws; neither set → throws.                                                                                                       |
| `completion-options-merge.yaml`               | Layered merge from §5, verified end-to-end through Echo which echoes merged options into its output (via a minor Echo extension to its output for test purposes). |
| `completion-rejects-non-model-ref.yaml`       | Analyzer flags `model:` pointing at a `Telo.Invocable` that is not an `Ai.Model`. Fails at static analysis.                                                       |
| `completion-error-propagation.yaml`           | Echo configured to throw on a marker input → completion call surfaces the error unchanged, no retry, no swallowing.                                               |

A stream-contract test for Echo lives here too, even though no production kind consumes it yet — it locks the contract so providers can be regression-tested against the same assertions:

| File                        | Asserts                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo-stream-contract.yaml` | `resource.model.stream(...)` on EchoModel yields one or more `text-delta` parts whose concatenated `delta`s equal the expected echo, followed by exactly one `finish` part with `usage` zeros and `finishReason: stop`. Invoked via a tiny `Telo.Invocable` test harness controller that exercises `stream()` directly (since `Ai.Stream` doesn't exist yet). |

### 8.2 `modules/ai-<provider>/tests/`

| File                                       | Asserts                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<provider>-snapshot-redacts-secrets.yaml` | `apiKey` absent from `resources.<name>` after init. (Ollama: skipped — no apiKey.)                                                                                                                                                                                                                                   |
| `<provider>-live-completion.yaml`          | Integration test for `invoke()`. Env-gated on `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / reachable Ollama at `OLLAMA_BASE_URL`. Skipped silently when unset. Sends a trivial prompt, asserts shape of `{text, usage, finishReason}`, asserts `text` is non-empty.                                                      |
| `<provider>-live-stream.yaml`              | Integration test for `stream()`. Same env gating. Consumes the stream, collects `text-delta` deltas, asserts concatenation is non-empty and that exactly one `finish` part arrives. Locks the streaming contract end-to-end against the real vendor SDK so `Ai.Stream` lands as a pure consumer-side addition later. |

### 8.3 Analyzer cross-package test

New fixture in `analyzer/nodejs/tests/`: Application importing `std/ai` and `std/ai-openai`, declaring an `Ai.Completion` with `model: "MyOpenaiModel"`. Asserts the reference resolves clean and `getByExtends("ai.Model")` includes `ai-openai.OpenaiModel`. This exercises the "library-defined abstract + cross-package implementation + cross-package ref" path for the first time in-repo.

### 8.4 Kernel prerequisite test

Already listed in §2.2. Depends on nothing in `modules/ai` — it's a standalone test using `modules/workflow` + `modules/workflow-temporal`.

## 9. README & docs

### 9.1 `modules/ai/README.md` — rewritten

The existing README describes a unified `Ai.Model` with a `provider: string` discriminator plus bundled `Ai.Agent` / `Ai.Worker`. That shape is obsolete under this plan. Replacement structure:

1. Overview — `Ai.Model` abstract + `Ai.Completion`. Point at provider packages for concrete implementations.
2. `Ai.Completion` — manifest fields, invocation inputs, outputs, three worked examples (inline inside `Run.Sequence`, named resource, with system prompt override).
3. Implementing a new `Ai.Model` — contract, expected input/output, reference to `docs/ai-model.md` walkthrough.
4. `Ai.Agent` / `Ai.Worker` — "Planned" section only, one paragraph linking to a future dedicated plan. No fields table until those kinds are implemented.

### 9.2 `modules/ai-openai/README.md`, `-anthropic/README.md`, `-ollama/README.md`

Each: 30-line README — install, sample manifest declaring the model + a completion that uses it, link back to `modules/ai/docs/ai-model.md` for the contract and `docs/ai-<provider>-model.md` for vendor specifics.

### 9.3 Docusaurus wiring (CLAUDE.md-mandated)

- Add each of `modules/ai/docs/*.md`, `modules/ai-openai/docs/*.md`, `modules/ai-anthropic/docs/*.md`, `modules/ai-ollama/docs/*.md` to the `include` array in [pages/docusaurus.config.ts](../../../pages/docusaurus.config.ts).
- Add a sidebar group in [pages/sidebars.ts](../../../pages/sidebars.ts): "AI" containing `ai-model`, `ai-completion`, then a "Providers" subgroup with the three vendor docs.
- Each doc file gets `sidebar_label` frontmatter.

### 9.4 `kernel/docs/inheritance.md`

Updated as part of Part A (§2.3). The existing doc already describes the intended `capability` / `extends` split correctly; the work is to make the described behaviour real and to update any wording that reads as aspirational rather than documentation of live code.

## 10. Changesets (CLAUDE.md-mandated)

- **Part A PR:** one changeset covering `@telorun/kernel`, `@telorun/analyzer`, `@telorun/sdk`. Minor bump — new `extends` field, new runtime behaviour for library-declared abstracts, prototype-preserving instance wrap. Message: "kernel/analyzer: library-declared Telo.Abstract + first-class `extends` + prototype-preserving instance wrap."
- **Part B + C PR:** one changeset covering `@telorun/ai`, `@telorun/ai-openai`. Minor release (1.0.0 initial publish). Message: Ai.Model abstract + Ai.Completion + first-party providers.

If Part B + C land across multiple PRs (one per provider for review size), each PR carries its own changeset for the package it touches, plus the shared base on the first PR.

## 11. Execution order

1. **Part A — kernel + analyzer prerequisite.** (a) Write the `Telo.Abstract` runtime controller and register it. (b) Replace the prototype-stripping instance wrap at kernel.ts:542-548 with the `Object.create`-based form in §2.3. (c) Extend manifest schema with `Telo.Abstract` validation + `extends` (alias-form pattern) on `Telo.Definition`. (d) Implement `extends` pre-resolution in `analyzer.ts` and registration in `DefinitionRegistry` (§2.2). (e) Add the new `validate-extends` pass emitting the four diagnostics. (f) Migrate `modules/workflow-temporal/telo.yaml` to the canonical `capability: Telo.Provider, extends: Workflow.Backend` (with a self-import so the library is self-consistent when analyzed in isolation). (g) Add the kernel unit tests (abstract registration + prototype preservation), analyzer diagnostic tests, and the workflow import smoke test. (h) Update `kernel/docs/inheritance.md`. Changeset. Merge.
2. **Part B — `@telorun/ai` base.** Scaffold package, write `telo.yaml` (abstract + completion; echo fixture lives under `tests/__fixtures__/ai-echo.yaml` per §3.1, declaring its own `Telo.Import name: Ai` so `extends: Ai.Model` resolves). Implement `ai-completion-controller.ts`, `ai-echo-controller.ts`, `redact.ts`. All hermetic tests pass.
3. **Part C — providers**, in order OpenAI → Anthropic → Ollama. Each package adds its own tests. Each PR uses the hermetic completion tests from Part B as regression, plus its own live integration test.
4. **Docs pass.** Write `modules/ai/docs/ai-model.md` (the implementer's contract), `ai-completion.md`, per-provider docs. Wire Docusaurus config + sidebar.
5. **README rewrite** per §9.1, §9.2.
6. **Analyzer cross-package test** per §8.3.
7. **Changesets** attached per §10.

No open questions. If anything listed here becomes contested during implementation, it is a plan change — discuss before coding, don't drift.

## 12. Anticipated follow-up — the streaming consumer (not in this plan's scope)

This section exists to justify the provider-side `stream()` commitment in §3.3, **not** to commit to a specific consumer kind. Two decisions must be kept separate:

**Committed here.** Providers expose `stream()` on their runtime instance returning `AsyncIterable<StreamPart>`. This is a plain JS method on an injected `ResourceInstance` — any future consumer can call it.

**Deliberately not committed here.** What kind consumes `stream()`, and what capability it declares. Three candidate shapes exist, each with different tradeoffs; picking one now would prejudge a real design question.

| Candidate                                                                                      | Capability       | Fits                                                                                                                                                       | Doesn't fit                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ai.Stream` as `Telo.Invocable`, output `{ parts: AsyncIterable<StreamPart> }`                 | `Telo.Invocable` | Run.Sequence steps that pass the stream opaquely to a downstream invocable (e.g. an HTTP writer).                                                          | Any CEL introspection of the result — CEL has no async-iteration primitives, so `steps.X.result.parts` can't be iterated in manifests. `x-telo-step-context` typing assumes finite values. |
| `Ai.StreamResponder` as `Telo.Mount` under `Http.Api`                                          | `Telo.Mount`     | HTTP SSE endpoints that want a declarative "this route streams an Ai model's output." The mount consumes the stream and writes `text/event-stream` chunks. | Non-HTTP consumers. Couples the streaming abstraction to HTTP.                                                                                                                             |
| A new capability, e.g. `Telo.StreamingInvocable`, that formally carries async-iterable outputs | new              | Anything that needs first-class streaming throughout CEL.                                                                                                  | Adds a kernel capability — bigger change than either of the above.                                                                                                                         |

Whichever lands, the provider side of this plan doesn't shift: `resource.model.stream(...)` is callable, returns `AsyncIterable<StreamPart>`, done. The consumer-side plan gets to pick the cleanest shape after the AI module is actually in use and the real consumers (HTTP SSE handlers, agentic loops, etc.) are known.

Open questions that the consumer plan will have to resolve:

- CEL step-context typing for `AsyncIterable`. Run.Sequence's `steps.X.result.*` model assumes finite values; either the streaming consumer lives outside Run.Sequence, or the analyzer gains a way to express "this field is async-iterable, treat it as opaque in CEL."
- Whether the consumer exposes a synchronous `.final` promise (aggregated usage/finishReason) alongside the stream, or only surfaces the final via the stream's `finish` part. Providers already have both signals available; this is a consumer-controller choice.
- Teeing / multi-consumer streams. Today's provider contract is single-consumer; if the consumer kind needs to fan out, that's a consumer-side wrapper, not a provider-contract change.
