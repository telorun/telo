---
"@telorun/kernel": patch
"@telorun/analyzer": patch
---

Two follow-up fixes uncovered while building `@telorun/ai-openai` against the alias-form `extends` pattern from PR #37:

- **Kernel:** `Telo.Import` controller now resolves relative `source` paths against the manifest's own stamped `metadata.source` instead of the parent module context's source. When a Telo.Library imports another library via a relative path, that path is written relative to the declaring library's file — not relative to whatever root manifest happens to load the chain. Without this fix, nested transitive imports would resolve against the wrong base directory at runtime (the analyzer was already correct).
- **Analyzer:** `loadManifests` now forwards `Telo.Import` docs from imported libraries into the analysis manifest set, and re-stamps `resolvedModuleName` / `resolvedNamespace` on Telo.Import docs that re-encounter an already-loaded import URL through a different chain. Required so alias-form `extends` declarations inside imported libraries (e.g. `ai-openai/telo.yaml`'s `extends: Ai.Model`) resolve through the library's own `Telo.Import name: Ai`, even when the consumer doesn't import `Ai` directly.

No behavioural change for existing modules — both fixes only affect cases that were already broken at runtime or that previously emitted spurious `EXTENDS_MALFORMED` diagnostics.
