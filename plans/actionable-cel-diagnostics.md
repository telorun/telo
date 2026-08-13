# Actionable CEL diagnostics and time round-tripping

## Problem

Every CEL type-check failure is surfaced as one opaque sentence forwarded verbatim
from cel-js, under `code: SCHEMA_VIOLATION` — a code that says nothing about CEL
(`analyzer/nodejs/src/analyzer.ts`, `collectCelTypeIssues`). Three unrelated
mistakes render identically, and two of them are actively misdiagnosed:

- `no matching overload for 'startsWith(dyn, string)'` is **not** a type error. CEL's
  string builtins are receiver-call only; the same message appears when both
  arguments are literal strings. The message reads as "your receiver is untyped", so
  the repair attempt is a `string(...)` cast, which fails identically.
- `no matching overload for 'now()'` means **the function does not exist**
  (`nowIso` / `nowMillis` / `nowSeconds` do). The message reads as wrong arity, so
  the repair attempt is `now("UTC")`, which fails identically.

Each wrong repair costs a full check cycle and lands back on the same message. The
cost falls hardest on the AI authoring agent, whose only surface is `-o json` — and
that surface drops everything except `message`.

The call-form split is genuinely unlearnable from Telo's docs: `docs/cel-reference.md`
is generated from `CEL_FUNCTIONS`, whose every entry is global, while the receiver-only
builtins (`startsWith`, `endsWith`, `contains`, `matches`, `substring`, …) are
documented nowhere. Some names exist in both forms, some in neither.

Two adjacent holes produce failures of the same character. **An instant cannot leave an
expression**: cel-js supports timestamp arithmetic and getters, but defines neither
`string(timestamp)` nor `int(timestamp)`, so computing an expiry or a scheduled-at and
storing it is impossible — which is also why the catalog carries three parallel encodings
of "now" instead of one instant. And **nothing flags a non-deterministic function in an
`x-telo-eval: compile` field**, where it bakes once at load: `deterministic: false` is read
only to print a label in `telo cel functions`.

`UNCOVERED_THROW_CODE` is accurate but names no handler, no declaration site, and no
fix shape, and emits one diagnostic per code where one per `catches:` block would do.

## Solution

**Templating classifies; the analyzer decides.** `TemplatingEngine.analyze` stops returning a
bare diagnostic array and returns a structured result: diagnostics, the type `check()`
resolved, a call inventory (name, call form, source offsets, determinism), and any fixes.
Everything an analysis of one expression can establish is established once, in one place,
by whichever engine owns the syntax; every policy that needs manifest context — eval mode,
the field's declared type, which verdict wins — stays with the analyzer, which has it.

Under that seam, `analyzeCelExpression` (`templating/nodejs/src/engines/cel.ts`) — which
already parses every expression and emits `CEL_SYNTAX_ERROR`, `CEL_UNKNOWN_FIELD` and
`CEL_NULLABLE_ACCESS` — gains a walk over call nodes classifying each against the CEL
function registry, adding `CEL_UNKNOWN_FUNCTION` and `CEL_WRONG_CALL_FORM`, and takes over
the `env.check()` call. The analyzer passes the per-path typed environment it already
builds (`buildTypedCelEnvironment`) as the engine's `celEnv`, so one expression is checked
once, against one environment.

Two facts make this deterministic. The AST distinguishes global calls from receiver
calls structurally and carries source offsets for every node. `Environment.getDefinitions()`
returns all registered signatures — cel-js builtins and Telo's catalog uniformly — each
with its name, call form, parameters and return type. Name existence, call form and arity
are therefore all decidable by lookup; nothing parses cel-js's message text, so a cel-js
version bump cannot silently degrade the classification.

The audit runs on every expression rather than only on failures, so it reports **every**
bad call in an expression. `env.check()` reports only the first.

**The residual becomes `CEL_TYPE_ERROR`, and only when nothing else explained it.** A
`check()` failure the audit already accounted for is suppressed — `startsWith(key, 'x')`
yields `CEL_WRONG_CALL_FORM` alone, never that plus the opaque overload sentence. What
survives is a genuine type mismatch: it keeps the passthrough message but gains the
expression, the manifest path, and an explanation of `dyn` (an untyped operand means the
invoked resource declares no `outputType:`), and moves off `SCHEMA_VIOLATION` into the
existing `CEL_*` family. The resolved type comes back on the same result, so the analyzer's
existing "CEL returns `X` but field expects `Y`" check reads it instead of re-checking.

This also settles coverage. `collectCelTypeIssues` matches whole-scalar pure CEL only, while
the engine walk reaches every `${{ }}` segment in any string and every tagged scalar — so
today an interpolation is chain-validated but never type-checked. With `check()` inside the
engine, every expression the walker finds gets the same verdict.

**Fixes travel as one generic primitive.** A diagnostic whose rewrite is decidable carries a
`fix`: a replacement string plus an optional target range, defaulting to the node
`resolveRange` already resolves from `data.path`. It is defined once in the analyzer's
diagnostic model and carried **unchanged** from the engine through the analyzer to CLI JSON
and `packages/ide-support` — no CEL-specific field, no second suggestion kind. The existing
`suggestedKind` stamp collapses into it, so `UNDEFINED_KIND` and every CEL fix reach hosts
through one CodeAction path. Because the range is explicit rather than implied,
`!sql` is included: `expressionsOf` retains each interpolation's offset (it already has it
from `matchAll`) and the fix targets the interpolation. The CLI's `JsonDiagnostic` gains
`resource`, `path` and `fix`.

**Instants round-trip.** `CEL_FUNCTIONS` gains `string(timestamp)` (RFC 3339) and
`int(timestamp)` (epoch seconds) — the two conversions standard cel-go defines and cel-js
omits. Nothing else is needed: timestamp arithmetic, comparison and the `getFullYear` /
`getHours` family already work, as do `getSeconds` / `getMilliseconds` on a Duration. With
these, an expiry can be computed and stored, and the existing `nowIso` / `nowMillis` /
`nowSeconds` become derivable conveniences rather than the only way out of the type.

**Non-determinism at load is a warning.** The call inventory already reports which functions
an expression calls and whether each is deterministic, so `CEL_NONDETERMINISTIC_IN_COMPILE_FIELD`
is the analyzer pairing that inventory with the field's eval mode through the existing
`buildEvalPaths` / `evalPathCovers` machinery — no second walk, and no `x-telo-eval` in
templating.

**Root cause.** `docs/cel-reference.md` is regenerated from the full registry with a
call-form column, so receiver-only builtins appear at all, and states the epoch-seconds
convention. The registry carries no descriptions for builtins and no category or
determinism outside Telo's own catalog, so the generator **joins on function name**:
a catalog match contributes summary, category and determinism and keeps its current
section; everything unmatched lists as signatures under a *CEL built-ins* section grouped
by receiver type. Existence and call form are the information that is missing today, and a
bare signature carries both. The authoring-agent system prompt
(`apps/authoring-agent/chat/telo.yaml`) carries the one-line call-form rule.

**Throws coverage.** `validate-throws-coverage.ts` emits one `UNCOVERED_THROW_CODE` per
`catches:` block listing every uncovered code, naming the handler and where the codes were
declared, and showing the catch-all shape.

## Decisions

- **Classifier in templating, not the analyzer.** The kernel can reach either, but templating
  cannot reach the analyzer — and templating already owns the sibling CEL codes, the
  catalog and the environment. Splitting would strand `analyzeCelExpression` below its own
  classifier forever.
- **The engine returns a structured result rather than taking richer inputs.** Passing an
  eval mode *into* `analyze` would put manifest policy inside templating, and would still
  leave `check()` running twice — once in the engine for the error, once in the analyzer for
  the type its field comparison needs. Returning the type, the call inventory and the fixes
  makes one call answer every consumer. It is also the seam a second (Rust) CEL engine
  implements: a classifier, not a rulebook. Cost: a breaking signature change on a published
  interface with four in-repo implementations — a minor bump under the pre-1.0 convention,
  with a changeset.
- **One expression is checked once, against the typed environment.** Two passes with two
  environments is what let the opaque residual survive beside the good diagnostic, and what
  left `${{ }}` interpolations chain-validated but never type-checked. Suppression is stated,
  not assumed: the residual is emitted only when the audit produced nothing for that
  expression.
- **No parsing of cel-js messages, anywhere.** The error object carries only a message string;
  a wording change would silently degrade any parser. Rejected: splitting the residual into
  `CEL_ARGUMENT_TYPE` / `CEL_OPERATOR_TYPE`, which is the one distinction that *would* require
  parsing. One `CEL_TYPE_ERROR` instead.
- **A fix is verified structurally, never by re-checking.** Re-checking the rewritten expression
  makes each suggestion hostage to unrelated errors elsewhere in it — one bad call would suppress
  the fix for another. The registry decides name, call form and arity; the rewrite follows by
  construction.
- **Not gated on argument types.** Operands are `dyn` far more often than not, so a type gate
  would suppress good fixes for the same reason. A wrongly-typed argument to a wrongly-formed
  call yields two diagnostics — one per problem.
- **Unknown-name candidates are filtered by call form and arity, not edit distance.** Distance
  alone never reaches `nowIso` from `now`, nor `substring` from `slice`. Where the filter leaves
  no close match, the message lists the applicable functions rather than guessing.
- **One fix primitive, not a CEL-specific field.** A replacement plus an explicit range, defined
  in the analyzer's diagnostic model and passed through untouched. Rejected: a `fix` string on
  `JsonDiagnostic` plus a `replace-expression` suggestion kind, which is the use-case shortcut
  the repo's generic-primitive rule exists to prevent — it would harden whole-scalar replacement
  into the contract and leave hosts with two CodeAction paths.
- **Every message's function list is derived from the registry, never written as prose.** The
  hand-written version was already wrong: `trim` and `join` exist in *both* call forms, so any
  "these are receiver, those are global" sentence is false the day it is written and drifts
  afterwards. The candidate filter that builds the suggestion builds the list.
- **`CEL_TYPE_ERROR` replaces `SCHEMA_VIOLATION` for CEL failures** — an observable code change;
  `modules/type/tests/type-static-analysis.yaml` is updated with it.
- **`JsonDiagnostic` grows additively.** Existing consumers of `message` are untouched.
- **The two conversions follow cel-go's semantics exactly** — RFC 3339 and epoch seconds — rather
  than a Telo-chosen encoding, so a manifest author's CEL knowledge transfers and the pairing
  `int(timestamp)` ↔ `timestamp(int)` round-trips in one unit.
- **No `now()`.** Adding it as a fourth string/int encoding reopens the ambiguity the three
  existing names were split to avoid; adding it as `now(): timestamp` is only coherent once
  instants round-trip, and even then it is a convenience over `timestamp(nowSeconds())` rather
  than a new capability. `CEL_UNKNOWN_FUNCTION` reduces the cost of guessing it to one cycle.
- **`timestamp(nowMillis())` is left as a runtime error.** It type-checks because both are `int`;
  catching it statically means either hardcoding function pairs into a deliberately generic
  classifier, or inventing units in the CEL type system for one case. The documented
  epoch-seconds convention is the answer instead.
- **Non-determinism in a compile field warns rather than errors.** Baking at load is sometimes
  the intent — a boot timestamp or run id — so the author is told, not blocked.

## Diagnostics after the change

```
CEL: `startsWith` is a method, not a global function — call it on the value:
  write:  key.startsWith('uploads/')
  not:    startsWith(key, 'uploads/')
Only `string.startsWith(string)` is registered. Other string methods: contains,
endsWith, indexOf, lastIndexOf, matches, size, split, substring, trim.
  at Run.Sequence/confirmUpload  steps[1].when          code: CEL_WRONG_CALL_FORM

CEL: there is no function `now()`. Available with this call form and arity:
`nowIso()` (ISO-8601 string), `nowMillis()` (epoch ms), `nowSeconds()` (epoch s).
For an instant you can do arithmetic on, use `timestamp(nowSeconds())`.
Full list: `telo cel functions`.
  at Run.Sequence/confirmUpload  steps[6].inputs.createdAt   code: CEL_UNKNOWN_FUNCTION

UNCOVERED_THROW_CODE: handler `!ref ConfirmUpload` can throw 2 codes that no
`catches:` entry handles: ERR_INVALID_INPUT, ERR_INVALID_REFERENCE (declared at
Run.Sequence/confirmUpload `throws.codes`). Give each a matching `when:`, or add a
catch-all entry — one with no `when:`, placed last.
  at apps/media/telo.yaml:268  Http.Api/mediaApi  routes[2].catches
```

The first two carry a `fix` (`key.startsWith('uploads/')`, `nowIso()`) with the range it
applies to, which the CLI emits under `-o json` and the IDE offers as a one-click
replacement. An expiry that was previously unexpressible is now
`string(timestamp(nowSeconds()) + duration('24h'))`.
