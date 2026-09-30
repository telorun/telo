---
"@telorun/sdk": patch
---

A `try:` step lets a cancellation of its own invocation through untouched, as it already did a durable suspension: when the invocation running the steps has been cancelled — a caller's step `timeout:`, a stopped run — neither `catch:` nor `finally:` runs. A caller's step `timeout:` on a target that guards its own work with `try:` / `catch:` now fails the caller with `ERR_STEP_TIMEOUT`, where before the target's `catch:` turned the cancellation into its own failure code. An `ERR_INVOKE_CANCELLED` raised while the invocation is not cancelled (a recorded failure re-raised, for example) is caught like any other failure, and every other failure still reaches `catch:` and `finally:` as before.
