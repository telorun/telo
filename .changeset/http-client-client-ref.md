---
"@telorun/http-client": minor
---

Promote `Http.Request.client` to a proper `x-telo-ref` slot (`std/http-client#Client`).

The field is now statically analyzable — references are validated, kind-checked, and wired into the dependency graph — and supports the canonical reference grammar (`client: !ref MyClient`), including cross-module references to a library's exported `Http.Client`. Top-level `Http.Request` resources receive the live `Http.Client` instance injected at Phase 5; inline usages (e.g. a `Run.Sequence` step's `invoke:`) resolve the reference at invoke time.

Non-breaking: the legacy bare-name form (`client: MyClient`) is still accepted.
