# Plan — `provide:` template target for `Telo.Provider`

Scope: add a `provide:` field to `Telo.Definition` so manifest authors can declare template-based providers (analogous to existing `invoke:` / `run:` template targets), and add an optional typed `provide(): Promise<T>` member to `Telo.Provider` so synthesized template providers — and TS-authored providers that opt in — have a typed value-flow contract.

Depends on: [`analyzer/nodejs/plans/template-internal-cel-validation.md`](../../../analyzer/nodejs/plans/template-internal-cel-validation.md) — already in place; this plan layers on it.

Additive: existing `Telo.Provider` implementations continue to work unchanged.

## 1. Why

Template targets today let manifest authors compose `invoke:` and `run:` capabilities in pure YAML — no TypeScript controller required. `Telo.Provider` is the missing piece: providers can only be authored as TS controllers, even when the value flow is just "call an invocable and reshape its result". This plan closes that gap.

The template controller re-runs its dispatch target on every `provide()` call; it is stateless. Manifest-only providers are therefore best suited to value flows that are cheap to recompute (or where the underlying invocable is already cached at a lower layer). A manifest-level caching primitive is out of scope.

## 2. Capability contract

`Telo.Provider` gains an **optional** typed `provide(): Promise<T>` member, where `T` is JSON-schema-typed via the abstract's `outputType` when the definition `extends` one. Existing optional members (`init`, `teardown`, `snapshot`) are unchanged.

```ts
interface ProviderInstance {
  init?(): Promise<void>;
  teardown?(): Promise<void>;
  snapshot?(): unknown;

  // NEW, optional. Parameterless — the provider was configured at declaration
  // time and knows what it supplies. Caching is the implementation's own concern.
  provide?(): Promise<unknown>;
}
```

Provider definitions are free to implement neither, either, or both methods. A definition that declares `provide:` (template form) or implements `provide()` in a TS controller opts into the typed value-flow contract validated in §5.

## 3. Manifest schema: `Telo.Definition.provide:`

`provide:` is the third dispatch entry-point on a `Telo.Definition`, structurally parallel to `invoke:` / `run:`. The values passed to the target (`inputs:`) and the post-call mapping (`result:`) live as top-level siblings, matching how Run.Sequence steps factor `{ name, inputs, invoke }`.

```yaml
kind: Telo.Definition
metadata: { name: VaultSession }
capability: Telo.Provider
extends: Auth.SessionProvider

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
  kind: Http.Request
  name: "${{ self.name }}-read"
result:
  sessionId: "${{ result.body.data.session_id }}"
```

Field semantics:

- `provide.kind` — required. Kind of the target resource declared in `resources:`. The analyzer enforces that the target is a `Telo.Invocable`.
- `provide.name` — required. CEL-expandable target name.
- Top-level `inputs:` — optional sibling. CEL-evaluated map passed to the target's `invoke()`. Activation: `{ self, variables, secrets, resources.* }`. No caller arguments (`provide()` is parameterless).
- Top-level `result:` — optional sibling, works with **both `provide:` and `invoke:`** dispatchers. CEL-evaluated map applied to the target's invoke output. Activation: `{ self, result }` where `result` is typed from the target's `outputType` via `x-telo-context-from-ref-kind` (first `provide.kind`, falling back to `invoke.kind`). **When omitted, the target's raw output is returned** and must satisfy the abstract's `outputType` directly when an `extends:` is declared.

Errors from `provide()` propagate as-is from the target — same posture as `Telo.Invocable.invoke()`. No `ERR_PROVIDE_FAILED` wrapping; target-specific error codes survive the call.

Forbidden combinations (analyzer Phase 3 errors):
- `provide:` on a non-`Telo.Provider` definition.
- `provide:` co-existing with `invoke:` or `run:` on the same definition.
- `provide.name` not resolving to an entry in `resources:` with capability `Telo.Invocable`.
- `Telo.Provider` definition lacking both `controllers:` (TS-backed) and `provide:` (template-backed).

## 4. Template controller

[`createTemplateController`](../src/controllers/resource-definition/resource-template-controller.ts) gains a third dispatcher next to `invokeTarget` / `runTarget`. The synthesized `provide()` follows the existing `withEphemeral` pattern — spawn the ephemeral target, await its `invoke()`, tear down, apply `result:` mapping, return:

```ts
async provide(): Promise<unknown> {
  if (!ephemeralTemplate || !provideTarget) {
    throw new RuntimeError(
      "ERR_TEMPLATE_NO_PROVIDE_TARGET",
      `Template '${resource.metadata.name}' has no provide: target.`,
    );
  }
  const expanded = ctx.moduleContext.expandWith(ephemeralTemplate, { self });
  return withEphemeral(expanded, async (name) => {
    const entry = ctx.moduleContext.resourceInstances.get(name);
    const inputs = definition.inputs != null
      ? ctx.moduleContext.expandWith(definition.inputs, { self })
      : {};
    const raw = await entry!.instance.invoke!(inputs);
    if (definition.result == null) return raw;
    return ctx.moduleContext.expandWith(definition.result, { self, result: raw });
  });
}
```

**No `snapshot()` is synthesized.** A template provider exposes nothing via `${{ resources.X.* }}`; authors who need CEL exposure should write a TS-backed controller that explicitly implements `snapshot()`.

The template controller is stateless across calls; concurrent `provide()` calls each get isolated ephemeral targets.

## 5. Typed `provide()` contract on abstracts

`Telo.Abstract` continues to support `outputType: Type.JsonSchema`. The analyzer enforces output typing on definitions that opt into `provide()` — either via the template form (`provide:` field) or by declaring a TS controller that implements `provide()`:

- When `result:` is present: the target invocable's `outputType`, after `result:` CEL mapping, satisfies the abstract's `outputType`.
- When `result:` is absent: the target invocable's raw `outputType` satisfies the abstract's `outputType` directly.

Provider definitions that do not implement `provide()` remain unchecked by this contract.

## 6. Analyzer changes

1. **Reference resolution** ([`reference-field-map.ts`](../../../analyzer/nodejs/src/reference-field-map.ts)) — `provide.kind` / `provide.name` register as reference targets analogous to `invoke.kind` / `invoke.name`. Typos surface as Phase 3 errors.
2. **`x-telo-context` annotations** — already present from the prerequisite. `provide.name` carries `{ self }`; top-level `inputs:` and `result:` carry `{ self }` and `{ self, result }` respectively, with `result` typed from `provide/kind#outputType`. No new validator code.
3. **New validators** (extension of [`validate-references.ts`](../../../analyzer/nodejs/src/validate-references.ts)):
   - Reject `provide:` on non-`Telo.Provider` definitions.
   - Reject `provide:` + `invoke:` / `run:` co-occurrence.
   - Require `provide.name` to resolve to a `Telo.Invocable` entry in `resources:`.

## 7. Testing strategy

Kernel (`kernel/nodejs/tests/`):
- `provider-template-provide.test.ts` — happy path with explicit `result:` mapping; assert ephemeral teardown after each call.
- `provider-template-omitted-result.test.ts` — raw target output flows through unchanged.
- Negative: `provide:` + `invoke:` co-occurrence rejected at load.
- Negative: `provide.name` not resolving to a `resources:` entry rejected.
- Negative: `provide:` on a non-`Telo.Provider` definition rejected.

Integration (`tests/`):
- `tests/provider-provide-template.yaml` — manifest with a template provider that wraps `Http.Request`, a consumer that calls `provide()` repeatedly, and `Assert.Schema` over the result.

## 8. Documentation

- Update CLAUDE.md "Resource Kinds → Telo.Definition" to list `provide:` alongside `invoke:` / `run:`.
- Update CLAUDE.md "Capabilities" section: note the new optional `provide()` member on `Telo.Provider`.
- CHANGELOG entries for the affected packages.

## 9. Changeset

```
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
```

Description: "Add `provide:` template target to `Telo.Definition` and an optional typed `provide()` member to `Telo.Provider`."
