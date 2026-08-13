---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Make CEL diagnostics actionable, and let an instant leave an expression.

cel-js reports one sentence for three unrelated mistakes, and two of the three
readings actively mislead: `no matching overload for 'startsWith(dyn, string)'`
names argument types, so the repair looks like a cast when the real fix is
`key.startsWith('x')`; `no matching overload for 'now()'` reads as wrong arity
when the function does not exist. Each wrong repair cost a full check cycle and
landed back on the same message.

Every call is now classified against the CEL function registry
(`Environment.getDefinitions()`), which reports call form and parameters for
cel-js built-ins and Telo's catalog alike. Name existence, call form and arity
are decided by lookup, so nothing parses cel-js's message text and a cel-js
version bump cannot silently degrade the classification. New codes:
`CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`, and
`CEL_NONDETERMINISTIC_IN_COMPILE_FIELD` (a warning: `nowIso()` in an
`x-telo-eval: compile` field bakes once at load).

- **Breaking:** `TemplatingEngine.analyze` returns `AnalyzeResult`
  (`{ diagnostics, type?, calls }`) instead of `EngineDiagnostic[]`. The engine
  now owns the type-check, so one expression produces one verdict against one
  environment — previously two passes with two environments let the opaque
  residual survive beside the diagnostic that explained it, and left `${{ }}`
  interpolations chain-validated but never type-checked.
- **Breaking:** CEL failures no longer report as `SCHEMA_VIOLATION`; the
  residual type error is `CEL_TYPE_ERROR`.
- **Breaking:** `NormalizedDiagnostic.suggestions` entries are
  `kind: "replace"` (was `"replace-kind"`).
  Diagnostics with a decidable repair stamp a generic `fix` (`{ replacement }`
  — the whole corrected value, with no sub-range) that flows unchanged to CLI
  JSON and IDE CodeActions; `UNDEFINED_KIND`'s suggestion collapses into it.
- The VS Code extension offers those repairs as quick fixes. `ide-support`
  gains `renderFixReplacement`, which re-quotes a replacement in the style the
  author used: the span a fix replaces is the value node as written, so it
  includes the scalar's quotes (the YAML tag sits outside it), and writing a
  bare CEL expression into a quoted span would unquote text that a `: ` or a
  trailing `#` stops parsing as one scalar. Shared with the Tauri editor so
  both surfaces write a repaired scalar identically. It refuses a multi-line
  span: a block scalar's span covers its `|`/`>-` indicator and its trailing
  newline, so a single-line replacement would delete the break that ended the
  mapping entry and glue the next key onto the value — the quick fix is simply
  not offered there.
- `telo check -o json` diagnostics gain `resource`, `path` and `fix`.
- `telo cel functions` lists CEL's own built-ins alongside Telo's catalog,
  grouped by receiver type (appended to the `--json` array as
  `category: "builtin"`, so an existing consumer keeps working). They were
  absent entirely — which is why an author could read that command end to end
  and still call a method as a global, and why every new diagnostic pointing at
  it would otherwise have pointed at a list missing the functions it was about.
- `CheckDiagnostic` (the SDK's static-analysis seam, `ctx.runtime.check()`) gains
  `resource`, `path` and `fix`, so a module can act on a repair instead of
  recovering it from prose. `path` travels with `fix` because the repair
  replaces the value AT that path — a consumer holding only `line`/`column`
  could not apply it to a parsed manifest.
- CEL gains `string(timestamp)` (RFC 3339) and `int(timestamp)` (epoch
  seconds), the two conversions cel-go defines and cel-js omits. Without them
  an expiry could be computed and not stored, which is also why three parallel
  encodings of "now" exist.
- `UNCOVERED_THROW_CODE` reports one diagnostic per `catches:` block naming
  every uncovered code and the handler, instead of one per code.
