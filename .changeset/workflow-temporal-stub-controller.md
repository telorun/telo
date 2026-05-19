---
"@telorun/workflow-temporal": minor
---

Add a stub `@telorun/workflow-temporal` package and wire it from `Workflow-Temporal.Backend`'s `controllers:` field. The Backend definition previously shipped without an implementation, which was a half-finished state that became visible once `PROVIDER_MISSING_IMPLEMENTATION` (in `@telorun/analyzer`) started flagging Telo.Provider definitions lacking both `controllers:` and `provide:`. The stub controller exposes a no-op `init()` and a `snapshot()` returning the manifest's `namespace` / `address` — enough for the analyzer's static checks to pass and for `kind: Temporal.Backend` resources to instantiate cleanly. The real Temporal SDK integration is not yet implemented; consumers that exercise the backend will surface an error when `Workflow.Graph` calls methods that don't exist on this stub.
