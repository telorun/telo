---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

Add `provide:` template target to `Telo.Definition` and an optional typed `provide()` member to `Telo.Provider`.

Manifest authors can now declare a `Telo.Provider` in pure YAML without a TypeScript controller:

```yaml
kind: Telo.Definition
metadata: { name: TokenProvider }
capability: Telo.Provider
extends: Auth.SessionProvider
resources:
  - kind: Http.Request
    metadata: { name: "${{ self.name }}-read" }
    inputs: { url: "https://vault/v1/secret/${{ self.vaultPath }}" }
provide:
  kind: Http.Request
  name: "${{ self.name }}-read"
result:
  sessionId: "${{ result.body.data.session_id }}"
```

The synthesized `provide()` spawns the dispatch target as an ephemeral, calls its `invoke()` with the top-level `inputs:` map (CEL-expanded against `{ self, variables, secrets, resources.* }`), optionally reshapes the result via the top-level `result:` map (CEL-expanded against `{ self, result }` where `result` is typed from the target's `outputType`), and tears the ephemeral down. No caching: each call re-runs the target.

`Telo.Provider`'s `ProviderInstance` gains an optional `provide?(): Promise<T>` member, where `T` is JSON-schema-typed via the abstract's `outputType` when the definition `extends` one. Existing handle-shaped Providers (Sql.Connection, Http.Client, etc.) continue to work unchanged — they don't implement `provide()` and remain outside the typed value-flow contract.

Analyzer coherence validators reject:
- `PROVIDE_ON_NON_PROVIDER` — `provide:` on a non-`Telo.Provider` definition.
- `PROVIDE_DISPATCHER_CONFLICT` — `provide:` co-existing with `invoke:` or `run:`.
- `PROVIDE_TARGET_UNKNOWN` — `provide.name` not matching any `resources:` entry.
- `PROVIDE_TARGET_NOT_INVOCABLE` — `provide:` target resolving to a non-`Telo.Invocable` kind.
- `PROVIDER_MISSING_IMPLEMENTATION` — `Telo.Provider` definition lacking both `controllers:` and `provide:`.

Top-level `result:` is a general post-call mapping: it works as a sibling of either `provide:` or `invoke:`. The kernel applies it after the inner invoke returns; the analyzer types `result` inside CEL from the dispatch target's `outputType` (looked up via `provide.kind` first, falling back to `invoke.kind`) and validates the produced mapping against the abstract's `outputType` when the definition `extends` one. `x-telo-context-from-ref-kind` now accepts either a single path or an array of fallback paths.
