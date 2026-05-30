---
"@telorun/run": minor
"@telorun/analyzer": minor
"@telorun/templating": minor
---

`Run.Sequence` now guarantees a non-empty `error.code` and `error.message` inside
every `catch` block. A caught failure that is not a structured `InvokeError`
(e.g. a plain `Error` thrown by an invoked resource) is surfaced as
`error.code === "INTERNAL_ERROR"` instead of `null`. A `throw: { code: "${{
error.code }}" }` rethrow can therefore never resolve to `null` — previously such
a rethrow failed at runtime with `INVALID_THROW_STEP`, masking the underlying
error.

The analyzer's throws resolver mirrors this: a `try` block containing an
`invoke:` step folds `INTERNAL_ERROR` into the union a `catch` re-raises via
`error.code`, so an HTTP route's `catches:` list must cover it (or include a
catch-all). The resolver also now recognises the `!cel`-tagged code form in
`throw:` steps and passthrough call sites, matching the existing `${{ … }}`
string handling.

The analyzer now type-checks the `error` object inside `catch:` / `finally:`
blocks via a new `x-telo-error-context` schema annotation. CEL expressions like
`${{ error.cdoe }}` (a typo) are flagged with `CEL_UNKNOWN_FIELD` at any nesting
depth; valid fields (`code` / `message` / `step` / `data`) pass. Inside `finally`
`error` is typed as nullable (it is `null` on the success path), faithful to the
runtime contract. The annotation is generic — any composer that declares
error-bearing branch fields opts in the same way, with no resource kind hardcoded
in the analyzer.

CEL chain validation now also enforces null-safety: dereferencing a value whose
schema admits `null` (e.g. `error` inside `finally`) without a null-guard is a
static error (`CEL_NULLABLE_ACCESS`). Guards are recognised through `?:`
ternaries and `&&` / `||` short-circuits (`error != null && error.code`,
`error == null ? … : error.code`). This is general — it applies to any nullable
value in any CEL context, not just `Run.Sequence`.
