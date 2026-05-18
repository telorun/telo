# Plan — Provider `provide()` method + template `provide:` target

Scope: tighten the `Telo.Provider` capability so it requires a `provide(): Promise<unknown>` method (the contract that justifies the capability name), add a `provide:` field to `Telo.Definition` (structurally parallel to today's `invoke:` / `run:`), have `createTemplateController` synthesize a `provide()` implementation from manifest-declared steps, and migrate the six existing standard-library provider controllers to expose `provide()`. This gives Telo a third capability-entry-point alongside the existing two and unlocks manifest-only authoring of providers — anything from a static-secret session source to a Vault-backed credential lookup composes from existing kinds, no TypeScript controller required.

Prerequisite for: [`modules/mcp-client/plans/mcp-client-initial-design.md`](../../../modules/mcp-client/plans/mcp-client-initial-design.md).

Depends on: [`analyzer/nodejs/plans/template-internal-cel-validation.md`](../../../analyzer/nodejs/plans/template-internal-cel-validation.md) — the analyzer plan that brings template internals into the validation pipeline and registers `self` as a typed CEL variable. That plan lands first; this plan's analyzer changes (§6) are slimmer as a result.

Out of scope: changing `init()` / `snapshot()` / `teardown()` semantics. `snapshot()` stays optional and orthogonal — it remains the CEL-visible surface, while `provide()` is the controller-visible runtime surface. No reclassification of existing providers to other capabilities (`Sql.Connection`, `Http.Client`, etc. stay providers — they each provide something concrete). The mechanics of typing `self` inside template bodies are handled by the analyzer prerequisite plan, not duplicated here.

## 1. Why

`Telo.Provider` today is semantically loose. The capability name implies "this resource provides something," but the contract only requires `init()` (with optional `snapshot()` / `teardown()`) — nothing that actually surfaces a value. Existing providers therefore split into two unrelated buckets: some expose values via `snapshot()` for CEL (`Config.Env`), others expose runtime handles directly on the instance with no uniform method (`Sql.Connection.query(...)`, `Http.Client.fetch(...)`). There is no single way for a consumer controller to ask any provider for "the thing you provide" — every consumer learns the bespoke method names of every provider kind it touches.

The recurring workaround for runtime-fetched values (session IDs, OAuth tokens, STS credentials, tenant IDs, signed URLs — the credential-style cases listed across CLAUDE.md's cross-cutting concerns) is to thread the value through every invocation as an input, which (a) defeats the analyzer's ability to enforce closed `outputType`s on consumers, (b) bloats manifests at every call site, (c) makes "where does this value come from?" a non-local question. The MCP session-ID problem analyzed in the mcp-client plan is the immediate motivator; the same shape recurs for HTTP `Authorization`, SQL tenant headers, AWS sessions, and most other credential-flow integrations.

Requiring `provide()` on `Telo.Provider` does two things at once: it gives consumers a uniform "ask the provider for its thing" API (no more bespoke method names per kind), and it makes the capability name semantically honest. A "Provider" that doesn't provide anything was a leaky abstraction; tightening it now is cheaper than letting more downstream code accumulate against the loose contract.

The pieces already exist:

- The template controller ([resource-template-controller.ts](../src/controllers/resource-definition/resource-template-controller.ts)) already synthesizes capability-method implementations from manifest-declared `resources:` + a target (`invoke:` for Invocable, `run:` for Runnable). Adding `provide:` is the same shape.
- `Telo.Provider` instances are already injected live into consumer controllers via `preInitHook`. Adding a required method on the instance contract is a localized migration (§7) — six standard-library controllers gain a one-liner each.
- The typed-abstracts plan ([typed-abstracts.md](./typed-abstracts.md)) already supports declaring `outputType` on abstracts and validating implementations against them — `provide()`'s return shape reuses that mechanism for I/O contract enforcement.

## 2. Capability change: `Telo.Provider` requires `provide()`

Builtin abstract in [builtins.ts](../src/builtins.ts) tightens:

```ts
// Conceptually — actual code uses the SDK's ResourceInstance type.
interface ProviderInstance {
  init?(): Promise<void>;
  teardown?(): Promise<void>;
  snapshot?(): unknown | Promise<unknown>;     // optional — CEL exposure surface

  // REQUIRED — the contract that justifies the "Provider" capability name.
  // Returns whatever the provider exists to provide: a connection pool, a
  // configured client, a values map, a per-call session ID. What it returns
  // and whether the value is cached or fresh is the provider's own concern.
  provide(): Promise<unknown>;
}
```

`provide()` takes no arguments. A pure value source needs no caller-side configuration — the provider was configured at declaration time and knows what it supplies. Cache lifecycles (lazy first-call init, internal TTL, transparent reconnect-on-failure) are the provider's internal concern, mirroring how `Sql.Connection`'s pool transparently reconnects on dead sockets without exposing a `refresh` flag to its consumers.

This is a contract change. Today's `Telo.Provider` instances expose `init()` / `snapshot()` / `teardown()` only; adding a required method to the capability breaks every existing implementation unless they add `provide()`. The migration is contained — see §7 — and the alternative (optional `provide()`) leaves the capability semantically loose: "Provider" no longer obligates anything, and the next reviewer can keep classifying connection pools and configured clients as "Providers" that don't actually provide anything. We make the semantic real or we don't make it at all.

## 3. Manifest schema: `Telo.Definition.provide:`

Add a `provide:` field to `Telo.Definition`, structurally identical to today's `invoke:` — a dispatch-target descriptor only. The values passed to the target (`inputs:`) and the post-call mapping (`result:`) live as top-level siblings, matching the canonical Run.Sequence step shape (`{ name, inputs, invoke }`):

```yaml
kind: Telo.Definition
metadata: { name: VaultSession }
capability: Telo.Provider
extends: Mcp.SessionProvider     # honored when present; gates contract checks
schema:
  type: object
  required: [vaultPath, httpClient]
  properties:
    vaultPath:  { type: string }
    httpClient: { x-telo-ref: "std/http-client#Client" }

resources:
  - kind: Http.Request
    metadata: { name: "${{ self.name }}-read" }
    client: "${{ self.httpClient }}"
    inputs:
      url:    "https://vault/v1/secret/${{ self.vaultPath }}"
      method: GET

provide:
  kind: Http.Request                                        # x-telo-ref to the target's kind
  name: "${{ self.name }}-read"                             # target resource name in resources:
inputs: {}                                                  # optional sibling — passed to the target's invoke()
result:                                                     # CEL mapping target.invoke() output → provide() return
  sessionId: "${{ result.body.data.session_id }}"
```

Field semantics:

- `provide.kind` — required. Kind of the target resource declared in `resources:`. Lets the analyzer typecheck the dispatch and ensures the target is an Invocable.
- `provide.name` — required. CEL-expandable name of the target.
- Top-level `inputs:` — optional sibling. CEL-evaluated map passed as the target's `invoke()` inputs. The activation includes `self` plus the usual `variables` / `secrets` / `resources.*`. No caller-supplied options reach this scope — `provide()` is parameterless by design.
- Top-level `result:` — optional sibling. CEL-evaluated map applied to the target's invoke result. The activation includes `result` (the raw invoke output) and `self`. When absent, the target's raw output is returned verbatim — useful when the target already produces the right shape.

Forbidden combinations:

- `capability: Telo.Provider` + `provide:` requires `resources:` to declare the target. A `provide:` without a matching named entry in `resources:` is a Phase 3 analyzer error.
- `provide:` on a definition whose `capability` is not `Telo.Provider` (e.g. Telo.Invocable) is a manifest validation error — produce a clear message pointing at the capability/field mismatch.
- `provide:` co-existing with `invoke:` on the same definition is rejected. Templates pick one entry-point shape.

## 4. Template controller behaviour

[`createTemplateController`](../src/controllers/resource-definition/resource-template-controller.ts) gets a third dispatcher next to `invokeTarget` / `runTarget`:

```ts
const provideNameTemplate = definition.provide?.name ?? null;
const provideTarget = provideNameTemplate
  ? (ctx.moduleContext.expandWith(provideNameTemplate, { self }) as string)
  : null;
```

The produced instance gains:

```ts
async provide(): Promise<unknown> {
  if (!ephemeralTemplate || !provideTarget) {
    throw new RuntimeError(
      "ERR_TEMPLATE_NO_PROVIDE_TARGET",
      `Template '${resource.metadata.name}' has no provide: target.`,
    );
  }
  return withEphemeral(
    ctx.moduleContext.expandWith(ephemeralTemplate, { self }),
    async (uniqueName) => {
      const target = childContext.resourceInstances.get(uniqueName)!.instance;
      const inputs = ctx.moduleContext.expandWith(
        definition.inputs ?? {},
        { self },
      );
      const raw = await target.invoke!(inputs);
      const resultMap = definition.result;
      if (!resultMap) return raw;
      return ctx.moduleContext.expandWith(resultMap, { self, result: raw });
    },
  );
}
```

The `withEphemeral` helper already exists in the template controller for the Invocable path; the same flow handles per-call resource lifecycle (init → invoke → teardown). Reusing it means concurrent `provide()` calls each get their own ephemeral instance — same isolation guarantee Invocable templates already provide.

A template provider that **caches** its value (e.g. an OAuth-token provider that holds a token until expiry) does so inside the dispatched invocable, not at the template layer. The template controller always dispatches; cache lifecycles live one level down, in TS controllers that own the cache state. Pure-manifest providers therefore either re-run every step on each `provide()` call (cost: per-call side effects) or compose a TS-backed caching invocable as their target.

## 5. Typed `provide()` contract on abstracts

The typed-abstracts plan ([typed-abstracts.md](./typed-abstracts.md)) lets `Telo.Abstract` declare `outputType` for provider-capability abstracts. Since `provide()` is parameterless, only `outputType` is meaningful:

```yaml
kind: Telo.Abstract
metadata: { name: SessionProvider }
capability: Telo.Provider
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: false
    properties:
      sessionId: { type: string }
    required: [sessionId]
```

`inputType` is omitted (or declared as `{ type: object, additionalProperties: false }`) — `provide()` takes no caller-supplied data, so the analyzer doesn't typecheck a call-site argument. The contract is purely about what comes back.

The analyzer validates every `kind: Telo.Definition` with `extends: <abstract>` and `capability: Telo.Provider`:

- Top-level `result:` (after CEL evaluation against `result: <target outputType>`) must satisfy the abstract's `outputType`.
- When top-level `result:` is omitted, the target invocable's own `outputType` must satisfy the abstract's `outputType` directly.

When `extends:` is absent, no contract is enforced — the definition is free to return anything from `provide()`, and consumers take what they get. Same posture as untyped abstracts elsewhere.

## 6. Analyzer changes

With the analyzer prerequisite plan ([template-internal-cel-validation.md](../../../analyzer/nodejs/plans/template-internal-cel-validation.md)) already in place, this plan's analyzer surface narrows to three localized additions:

1. **Reference resolution** ([reference-field-map.ts](../../../analyzer/nodejs/src/reference-field-map.ts)) — `provide.kind` / `provide.name` register as reference targets analogous to `invoke.kind` / `invoke.name`. Typos surface as references-validation errors at Phase 3.
2. **`x-telo-context` annotations on the `provide` builtin** ([analyzer/builtins.ts](../../../analyzer/nodejs/src/builtins.ts)) — already in place from the analyzer prerequisite. `provide.name` carries `{ self }`. Top-level `inputs:` (sibling) carries `{ self, inputs }`. Top-level `result:` (sibling) carries `{ self, result }`, where `result` is typed from the dispatch target's `outputType` via the new `x-telo-context-from-ref-kind: "provide/kind#outputType"` annotation. No new validator code — the existing template-internal walker reads these annotations.
3. **Capability/provide consistency** ([validate-references.ts](../../../analyzer/nodejs/src/validate-references.ts) or a new validator) — reject `provide:` on non-`Telo.Provider` definitions, reject `provide:` + `invoke:` co-occurrence, require `provide.name` to resolve to an entry in `resources:`, reject `Telo.Provider` definitions that ship neither a `controllers:` reference (TS-backed) nor a `provide:` field (template-backed). The last rule is the one that gives the "Provider requires `provide()`" tightening its teeth at the manifest layer.

No changes to the CEL chain validator or type checker — top-level `inputs:` / `result:` reuse the existing `${{ }}` machinery, driven through the template-internal walker.

## 7. Compatibility and migration

The capability tightening — `provide()` going from "doesn't exist" to "required" — touches every existing `Telo.Provider` controller. Six kinds across the standard library, each addition is a few lines:

| Kind | What `provide()` returns | Source file |
| --- | --- | --- |
| `Http.Client` | The configured fetch wrapper (baseUrl, headers, default timeout pre-applied) | `modules/http-client/nodejs/src/http-client-controller.ts` |
| `Sql.Connection` | The pg/better-sqlite pool handle | `modules/sql/nodejs/src/sql-connection-controller.ts` |
| `S3.Client` | The configured S3 SDK client | `modules/s3/nodejs/src/...` |
| `Workflow.Connection` | The workflow gateway handle | `modules/workflow/nodejs/src/...` and `modules/workflow-temporal/nodejs/src/...` |
| `Config.Env` / `Variables` / `Secrets` / `EnvironmentVariableStore` | The values map | `modules/config/nodejs/src/...` |
| `Sql.Migration` | Migration status snapshot (or reclassify to `Telo.Runnable` if it really is one-shot — open decision §11) | `modules/sql/nodejs/src/...` |

For each, `provide()` is typically a one-liner returning an already-built instance member. Consumers that today reach into instance methods directly (`connection.query(...)`, `client.fetch(...)`) continue to work — `provide()` is additive, not replacing. New consumers calling `provider.provide()` get the canonical handle.

- **Manifest schema migration**: additive — old manifests parse identically. The schema validator gains `provide:`, an optional field.
- **Analyzer migration**: existing `Telo.Provider` definitions that ship a `controllers:` reference satisfy the new rule via the controller (which we update in the same PR). Definitions without `controllers:` and without `provide:` were previously silently invalid (templated providers couldn't dispatch anywhere); the new validator now surfaces them as Phase 3 errors with a clear "Provider needs either a `controllers:` reference or a `provide:` template" message.
- **Wire format / events**: no changes to event names or kernel state events.

Migration ships as one coordinated change: kernel + analyzer + the six provider controllers move together in the same release. The mcp-client follow-up depends on this release line.

## 8. Testing strategy

Unit tests in `kernel/nodejs/tests/`:

- `provider-template-provide.test.ts` — load a manifest declaring a template provider, call its `provide()` directly through `ResourceContext`, assert the result and that the ephemeral target was torn down. Cover happy path, `result:` mapping, missing `provide.name`, `provide:` on non-Provider capability.
- `provider-template-omitted-result.test.ts` — assert that omitting top-level `result:` returns the target's raw output verbatim (open decision §11.2).
- Negative: `provide:` co-existing with `invoke:` rejected at load.
- Negative: `provide.name` not present in `resources:` rejected at load.
- Negative: `Telo.Provider` definition with neither `controllers:` nor `provide:` rejected at load.

Integration test in `tests/` (kernel-level):

- `tests/provider-provide-template.yaml` — minimal app declaring a template-defined provider, a consumer kind that calls `provide()`, asserts result with `Assert.Schema`. Lives at kernel test level (not under a specific module) because the primitive is kernel-owned.

Analyzer tests:

- `analyzer/nodejs/tests/provide-target-resolution.test.ts` — reference-field-map test ensuring `provide.kind` / `provide.name` validate identically to `invoke.kind` / `invoke.name`.
- `analyzer/nodejs/tests/provide-capability-coherence.test.ts` — rejects `provide:` on Invocable, rejects co-occurrence with `invoke:`, rejects `Telo.Provider` definitions missing both `controllers:` and `provide:`.

Migration regression tests:

- One smoke test per migrated module (six total) asserting `provider.provide()` returns the expected handle/value. These can live alongside each module's existing tests.

## 9. Documentation

- Update `CLAUDE.md`'s "Capabilities" section: `Telo.Provider` requires `provide()` (the contract that justifies the capability name).
- Update `CLAUDE.md`'s "Resource Kinds → kind: Telo.Definition" section to mention `provide:` as a third entry-point alongside `invoke:` / `run:`.
- Kernel CHANGELOG entry calling out the contract tightening.
- No user-facing documentation in `pages/` yet — the first consumer (mcp-client) will document the pattern in its own docs.

## 10. Changeset

One file under `.changeset/`:

```
"@telorun/kernel": minor
"@telorun/sdk": minor          # ProviderInstance type widens
"@telorun/analyzer": minor
"@telorun/http-client": patch
"@telorun/sql": patch
"@telorun/s3": patch
"@telorun/workflow": patch
"@telorun/workflow-temporal": patch
"@telorun/config": patch
```

Description: "Require `provide()` on the `Telo.Provider` capability, add `provide:` template target to `Telo.Definition`, and migrate the six standard-library provider controllers to expose `provide()`."

## 11. Open decisions

1. **Error propagation from inside `provide()`.** Two paths:
   - **A.** Target invocable throws an `InvokeError` → propagates as-is from `provide()`. Consumers handle. (Recommended — matches existing Invocable error handling.)
   - **B.** Wrap all errors as `RuntimeError("ERR_PROVIDE_FAILED", ...)` with the original as `cause`. Uniform error shape but loses the target's own error codes.

2. **Top-level `result:` default when omitted.** Two paths:
   - **A.** Return the target's raw output unchanged.
   - **B.** Require top-level `result:` always; force the manifest author to be explicit about the shape.

   Recommend **A** for ergonomics. Manifest authors who want explicit mapping write it; those whose target already produces the right shape don't pay the verbosity tax.

3. **`Sql.Migration` classification.** Today it's `Telo.Provider`. Genuinely one-shot ("apply this migration"), arguably better modeled as `Telo.Runnable`. Two paths:
   - **A.** Reclassify to `Telo.Runnable` as part of this migration. Cleaner semantics; small breaking change for anyone holding it via `x-telo-ref`.
   - **B.** Keep as `Telo.Provider`; `provide()` returns a migration-status snapshot. Preserves existing references at the cost of slightly forced semantics.

   Pick before the migration PRs go out; both options are local to the sql module.
