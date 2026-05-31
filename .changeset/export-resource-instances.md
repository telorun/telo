---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/console": minor
"@telorun/assert": minor
---

Add exported resource instances: a `Telo.Library` can declare a resource and export it as a ready-made singleton via `exports.resources`, and consumers reference it across the import boundary with `!ref Alias.name` (and read value-flow exports in CEL as `${{ resources.Alias.name }}`). `std/console` now exports `writeLine` / `readLine` singletons, so a consumer can `!ref Console.writeLine` instead of declaring its own `Console.WriteLine` instance.

Reference grammar: every `!ref` is `<Alias>.<name>`, split on the first dot — a bare name (or `Self.`-qualified) resolves locally; a non-`Self` alias resolves into that import's `exports.resources`. A resource name may no longer contain a dot (new `INVALID_RESOURCE_NAME` diagnostic), since the dot separates alias from name.

`Self` now resolves a library's own kinds **ungated** (no longer bound to `exports.kinds`) — `exports` gates importers, not internal use — and the kernel registers `Self` in each import's child context, so a library can declare an instance of a kind it doesn't export (`kind: Self.WriteLine`).

`std/assert` likewise exports its config-free assertions (`equals`, `matches`, `contains`) as singletons, so a test can `!ref Assert.equals` — including inside a `Run.Sequence` step — instead of declaring an `Assert.Equals` instance.

Mechanics: the analyzer forwards a library's exported instances across the import boundary (gate = what's forwarded), and the kernel injects/boots them from the import's child context. Cross-module refs resolve on every consumption surface — Phase 5 injection (threads the alias; an unresolved ref defers to a later init pass), flat boot targets, `Run.Sequence` step invokes (via `resolveChildren` + `executeInvokeStep`), and CEL `${{ resources.Alias.name }}`. Lifecycle is unchanged — an exported instance is the import child context's existing singleton.
