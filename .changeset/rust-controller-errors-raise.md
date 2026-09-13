---
"@telorun/kernel": patch
---

A Rust controller's error now raises on the Node.js kernel. Before, an `Err` from a `pkg:cargo` controller loaded through napi was handed back to JavaScript as a returned `Error` object, so the step that dispatched it succeeded with that object as its result, a `try:` never saw it, and a failed `create` left an `Error` standing in as the instance. Every entry point of a napi-loaded controller now throws on failure — `register`, `create`, and every method of a created instance (`invoke`, `snapshot`, …). An error the controller itself returned is raised as a structured `InvokeError`, so `try:` / `catch:` and `catches:` match it by code.

The controller's code crosses as the error's `code` field, with its message unprefixed: a Rust controller returning `ERR_OUTPUT_NOT_TEXT` is caught as `error.code == "ERR_OUTPUT_NOT_TEXT"`. A value the napi bridge cannot hand to the controller — a byte chunk, a stream, anything JSON cannot represent — is the bridge's refusal rather than the controller's error, so it fails the dispatch with `ERR_EXECUTION_FAILED` and napi's message, as a JavaScript controller's plain `Error` does — a `catch:` sees it as `INTERNAL_ERROR`. A controller returning `ERR_INVOKE_CANCELLED` is now reported as a cancellation.
