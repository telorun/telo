# Formatting primitives and the idioms they retire

## Problem

CEL has no formatting layer. There is no fixed-decimal number, no duration, no date
format, no padding — `/cel.md` is generated from the catalog and the absence is total.
Manifests that print anything hand-roll it, and the hand-rolled forms are long enough
that they get copied rather than factored.

The evidence comes from auditing a consumer repo — an HR invoicing workspace of three
report applications over thirteen libraries, ~6,400 lines of manifest. It is not in this
repository; the counts are from that audit and are reproducible with `grep` there.
Nothing about the shapes is specific to invoicing: they are what any manifest that
renders a number, a duration or a date has to write today.

**Fixed-decimal money.** This exact expression appears **13 times** in one 587-line
library, at four call sites:

```cel
[int(round(x * 100.0))].map(c, string(c / 100) + '.' + (c % 100 < 10 ? '0' : '') + string(c % 100))[0]
```

That module's own comment concedes the reason — *"the two-digit tail is padded by hand
because CEL has no number formatter"*. A further **17 sites** write
`round(x * 100.0) / 100.0` for 2dp rounding.

It is also wrong for negative values, and the failure is silent. Verified by execution:

```
$ telo cel eval "[int(round(-1.5 * 100.0))].map(c, string(c / 100) + '.' + (c % 100 < 10 ? '0' : '') + string(c % 100))[0]"
-1.0-50
```

CEL's int division truncates toward zero and `%` takes the dividend's sign, so a credit
line prints `-1.0-50` on a customer-facing document. Thirteen copies of one defect, and
no single place to fix it.

**Durations.** The same reports need `1d 30m` alongside decimal hours — ~17 sites render
an hours figure. Seven of them, on the console path, format with a bare `string(hours)`,
which renders 7.0 as `7` and 7.25 as `7.25`; the columns are already ragged. A duration
carries a policy constant — how long a working day is — which is why it must not be
retyped at seventeen call sites.

**Dates.** A 169-line period library spends ~40 lines on epoch-millis arithmetic and
hand-built `YYYY-MM-DD` strings with zero-pad conditionals, written out three times. It
contains `duration('768h')` with the comment *"32 days past the 1st always lands in the
following month"* — a trick that exists solely because there is no month arithmetic.
`string(timestamp)` gives RFC-3339 and nothing else.

**Query strings.** Two near-identical sequences build one by hand with **8** occurrences
of `(x == '' ? '' : '&k=' + urlEncode(x))`. `Http.Request` accepts a `query:` map, but a
map cannot conditionally omit a key and the upstream API rejects blank parameters.

**`cel.bind` is invisible to the analyzer, so nobody uses it.** Twenty-four sites write
`[x].map(v, …)[0]` to bind one name, and three separate manifests carry the same comment:
*"CEL has no `let`, and the analyzer does not resolve the name `cel.bind` binds."* The
runtime is fine — verified: `telo cel eval "cel.bind(c, 150, string(c / 100) + '.' +
string(c % 100))"` returns `1.50`, and the CEL type-checker types the whole expression
`string`. The gap is entirely in the analyzer's static walk. Authors read the resulting
diagnostics as "`cel.bind` is unsupported" and write the comprehension workaround
instead — which is why the largest expressions in these manifests are unreadable.

**There is no formatting module to reuse, but a formatting dialect already exists.** A
hub search across every registered module returns nothing relevant. Inside the standard
library, `svg-chart` publishes `tickFormat`, `valueFormat` and `format` slots documented
as d3-format specifiers (`.0f`, `,.2f`, `.2s`), and `d3-format` is already a workspace
dependency. The gap is CEL's alone, and the number-format grammar is already chosen.

## Solution

Three work items plus one documentation fix. Item 1 is a prerequisite in spirit rather
than in code: it costs almost nothing and it is what makes the expressions the other
items touch worth reading.

### 1. Teach the analyzer that `cel.bind` binds a name

The parser expands `cel.bind(name, init, expr)` into a receiver call on a bare identifier
`cel`, with the three arguments beside it. Three things follow from nothing in the
analyzer knowing that.

**Before.** Extracting member chains from `cel.bind(c, request.q, string(c) + item.x)`
yields `[["cel"], ["c"], ["request","q"], ["c"], ["item","x"]]` — verified. A manifest
using it therefore gets `CEL_UNKNOWN_IDENTIFIER` for the bound name, `CEL_UNKNOWN_FIELD`
for the bound name twice, and a further `CEL_UNKNOWN_FIELD` for the pseudo-receiver
`cel`, which is in no scope and never will be. Separately, `bind` is neither a registered
function nor a recognised macro, so the moment the type-checker rejects the expression
for any unrelated reason, the call audit adds `there is no method \`bind\`` — a
fabricated error pointing at the one construct that is correct.

**After.** The bound name is in scope for the third argument only; `init` is evaluated in
the enclosing scope and keeps being walked there. The receiver contributes no chain.
`bind` joins the recognised macro set, so it is never classified as an unknown method.
Both of the analyzer's CEL walks — chain extraction and nullable-access — take the case,
the same pair that already special-cases `filter` / `map` / `exists` / `all` /
`exists_one`.

**Verify.** A bound name resolves; a name used in `init` does not; two nested binds both
resolve; the receiver produces no diagnostic; an unrelated type error inside a `cel.bind`
expression reports that error alone. Then re-run the audited repo's `telo check` and
confirm the 24 workaround sites rewrite with no new diagnostics.

Six analyzer passes consume the chain walk and are all repaired by the one change: CEL
binding-order derivation (which today reads a bound `c` as a dependency on a sibling
binding and can raise a spurious `BINDING_CYCLE`), unused-declaration detection,
resource-rule dynamic-value narrowing, throws-union resolution, throws coverage, and
root-identifier checking.

Editor colouring degrades rather than breaks: a bound name resolves to nothing in the
scope query and is left uncoloured. Rename is unaffected — it matches only
scope-qualified members (`resources.x`, `steps.x`, `variables.x`), never a bare name.

Release: `.changeset/`, `"@telorun/templating": minor`.

### 2. Formatting functions in the CEL catalog

One catalog entry per function both registers and documents it, and `/cel.md` is
generated from the catalog, so the reference page updates itself.

| Signature | Notes |
| --- | --- |
| `format(dyn, string): string` | d3-format specifier. The primitive. |
| `fixed(dyn, int): string` | Fixed-decimal; exactly `format(x, '.' + digits + 'f')`. |
| `round(dyn, int): double` | Second arity of the existing `round`; digits to round to. |
| `formatDuration(dyn, int): string` | Minutes + minutes-per-day → `1d 30m`. |
| `dateIn(timestamp, string?): string` | Calendar date `YYYY-MM-DD` of an instant in an IANA zone. |
| `isoIn(timestamp, string?): string` | ISO-8601 of an instant in an IANA zone. |
| `startOfMonth(timestamp, string?): timestamp` | Midnight on the 1st, in that zone. |
| `addMonths(timestamp, int, string?): timestamp` | Month arithmetic that respects month length. |
| `compact(dyn): dyn` | Drop null and `""` entries from a map or list. |

The number surface is the full d3-format specifier grammar,
`[[fill]align][sign][symbol][0][width][,][.precision][~][type]`, implemented by
delegating to `d3-format`. Rounding is therefore d3's: `f` is decimal-place rounding on
the double, so `format(1.005, '.2f')` is `"1.00"` — 1.005 is not representable and the
nearest double sits below the half. `round`'s new arity uses the same rule. Sign is
applied once, at the front, so positive and negative magnitudes format identically.

```
fixed(1.5, 2)          -> "1.50"
fixed(0.05, 2)         -> "0.05"
fixed(7.0, 2)          -> "7.00"
fixed(-1.5, 2)         -> "-1.50"    # the defect this exists to kill
fixed(-0.004, 2)       -> "0.00"     # a magnitude that rounds to zero drops its sign
format(1234.5, ",.2f") -> "1,234.50"
format(0.075, ".1%")   -> "7.5%"
format(42e6, ".2s")    -> "42M"
```

`formatDuration(minutes, minutesPerDay)` takes the day length explicitly. The largest
unit is the day; zero components are omitted; the unit letters are `d`, `h`, `m`; the
sign is emitted once at the front; non-integer minutes round to the nearest minute first.
Components are separated by a space, which is also what keeps the output out of a
duration slot — see the decision below.

```
formatDuration(510, 480)   -> "1d 30m"
formatDuration(450, 480)   -> "7h 30m"
formatDuration(480, 480)   -> "1d"
formatDuration(0, 480)     -> "0m"
formatDuration(-510, 480)  -> "-1d 30m"
```

Every date function takes an IANA zone defaulting to `"UTC"`, the shape `today(tz?)` and
`nowIso(tz?)` already have. `addMonths` clamps the day of month.

```
dateIn(timestamp('2026-03-01T00:30:00Z'), 'America/New_York') -> "2026-02-28"
startOfMonth(timestamp('2026-03-17T12:00:00Z'))               -> 2026-03-01T00:00:00Z
addMonths(timestamp('2026-01-31T00:00:00Z'), 1)               -> 2026-02-28T00:00:00Z
```

`compact` drops entries whose value is null or `""`, and nothing else.

```
compact({'a': 'x', 'b': '', 'c': null}) -> {'a': 'x'}
compact(['x', '', null])                -> ['x']
```

Anything taking a `timestamp` needs an explicit registration naming the protobuf
timestamp type, as the existing `string(timestamp)` and `int(timestamp)` entries do — the
documented spelling does not resolve on its own.

**An int64 argument is converted to a double, and refused above 2^53.** A CEL `int` is a
BigInt in this runtime, and `d3-format` throws on one — verified:
`format('.2f')(10n)` → *Cannot convert a BigInt value to a number*. So `format` and
`fixed` convert, and raise rather than convert when the magnitude exceeds `2^53 - 1`,
where a double stops representing every integer. This reaches the money path directly,
since minor units are integers, and anything arriving through `size(...)` or integer
arithmetic.

**`round` is guarded at BOTH arities**, including the one that already shipped. Guarding
only the new two-argument form left `round(9007199254740993)` answering
`9007199254740992` — silently wrong, and reachable by writing one fewer argument than the
form that refuses. A rule that holds only for the spelling introduced alongside it is not
the rule; it is a coincidence. This is a behaviour change to a shipped function, and the
cost is bounded: every existing call in the repository passes a double.

**Every guard fires at `telo check` when its argument is a literal.** A signature
constrains a type; it cannot constrain a value, so an unparseable specifier, a digit count
out of range, a day length of zero and an unknown IANA zone would each fire only when the
expression was evaluated — putting a defect the manifest states outright behind a run,
which is the opposite of what static analysis is for. A catalog entry therefore carries an
optional `checkArgs`, called from the analyze path with the value of each argument that was
written as a literal (`undefined` for anything computed, which a checker skips). Each
implementation calls the SAME guard the runtime calls, so the two answers cannot drift; the
diagnostic is `CEL_INVALID_ARGUMENT` and echoes the offending call, since an expression may
carry two calls to one function. The seam is generic — `compileRe2`'s pattern and flag
guards have the identical hole and fit it unchanged.

**A wrong TYPE is refused by the registration.** `format`, `fixed`, `round`,
`formatDuration` and `compact` register per-type overloads rather than `dyn`. With `dyn`,
`format('abc', '.2f')` type-checked and evaluated to the string `"NaN"` — a value that
looks like an answer and prints into a document — and `compact` turned an instant into `{}`
and a byte buffer into `{"0":137,…}`, the failure the compile walker is already written to
avoid. A genuinely dynamic expression still passes, because cel-js matches `dyn` against
any declared parameter; what this rejects is a statically known wrong type. `formattable`
and `compact` refuse the same values at runtime, for the computed case.

**Verify.** One test per function against the conformance manifest, plus the negative
cases — an unparseable specifier, an unknown specifier type, a digit count out of range, an
unknown IANA zone, an int64 above 2^53, a non-positive day length, a non-number and a
non-container — each as a `telo check` error where the argument is a literal, and each
caught at runtime where it is computed. Docs need no edit.

The vectors ship as a **manifest** (`tests/cel-formatting.yaml`), not as assertions inside
the templating package's TypeScript tests and not as a bespoke JSON. A plan is deleted when
its work lands, so examples in one are nothing a second engine can conform against — but
the artifact that closes that gap already exists: a manifest is what every Telo runtime
knows how to execute, so a second CEL engine conforms by running this file. It also needs
no encoding convention, because an int64 and an instant are written in CEL itself
(`size('abc')`, `timestamp('…')`) rather than tagged into JSON. Refusals are asserted in **two layers**, because they fire in two
places: a literal argument is a static error, asserted through `Assert.Manifest` on the
diagnostic code against a fixture; a computed one can only fail at evaluation, so it is
caught with `try:`/`catch:` **followed by a post-condition** asserting the catch actually
ran. Without that post-condition the case is vacuous — a `catch:` that never runs leaves
the step succeeding, so a guard that stopped refusing would keep the suite green, which for
a conformance document is the one failure mode that matters.

What stays in TypeScript is what a manifest cannot state: claims about **registration** —
that a timestamp argument resolves only when the signature names
`google.protobuf.Timestamp`, that `round` carries both arities, that a shift types as a
timestamp. A function registered under the wrong signature is unreachable from a manifest,
so the manifest would fail to check rather than say why.

Release: `.changeset/`, `"@telorun/templating": minor`.

### 3. Declare the runtime floor item 2 obliges

Item 2 widens what a manifest may say. An older analyzer reading a manifest that calls
`format(...)` reports `CEL_UNKNOWN_FUNCTION`, blaming the manifest's author for a version
skew; `requires: telo: ">=<the release that carries it>"` converts that into one
`MODULE_REQUIRES_NEWER_RUNTIME` naming the cause.

A standard-library manifest that starts *calling* a new CEL function needs one, per file.
None do — the only manifests here that call one are test manifests, which ship in no
module payload, so a bound on them would be a claim nothing checks. The consumer repo's
three applications need one, and saying so in the release notes is what this item
delivers.

**Verify by execution.** Strip the block, run the previous published CLI against the
manifest (`npx @telorun/cli@<previous> check <manifest>`), confirm it rejects; put the
block back and confirm the same runtime reports `MODULE_REQUIRES_NEWER_RUNTIME` instead.
A bound whose absence does not produce a rejection is a claim nothing checks and is not
added.

### Documentation fix, not a work item

Seven `Run.Iteration` resources in the audited repo exist purely to print one formatted
line per row, each ~22 lines of `metadata` plus an `inputType` schema declaring `rows:
array of object`, to carry a single format expression. None of that is required:
`Run.Iteration` does not require `inputType`, and a step's `invoke:` accepts an inline
declaration. Verified by running it, and `telo check` reports no issues. The `run`
module's docs gain the inline form as an example.

## Decisions

- **Numbers use the d3-format specifier grammar, delegating to `d3-format`.** Anything
  else would give the standard library two number dialects, so a chart axis label and the
  table cell beside it could round the same value differently.
- **The specification crosses runtimes; the library does not.** d3-format's grammar is
  modeled on Python's PEP 3101 mini-language, which has a stdlib implementation in Python
  and a Rust crate; d3 adds the `r`, `s`, `p` types, the `~` flag and `n`. A future Rust
  or Go CEL engine implements the spec, as both kernels already do for value types and
  manifest migrations. Rejected: printf verbs, which are universally implemented but
  cannot express grouping without a locale, percent scaling or SI prefixes — so they miss
  the padding and grouping gaps and still differ from every chart slot.
- **The full d3 surface, not a PEP 3101 subset.** Restricting it would make `.2s` valid on
  a chart's `tickFormat` and an error in `format()` — a dialect split by subset, which is
  the failure the previous decision exists to prevent.
- **Locale-free at the CEL layer.** The same manifest must render the same string on every
  runtime, and ICU version skew between Node builds and browsers would make a formatted
  number change underneath a stored document. Grouping and decimal separators are
  reachable through the specifier; month and day names are not reachable at all.
  `svg-chart` keeps its own `locale`, which governs axis labels and nothing persisted.
- **Time-zone data is accepted where locale is not**, and the asymmetry is deliberate
  rather than an oversight in the rule above. `dateIn`, `startOfMonth` and `addMonths`
  depend on tzdata, which skews between runtimes exactly as ICU does. It is admitted
  because a zone's offset is a fact about the world from a versioned, slow-moving source,
  and because refusing it means refusing zone-aware dates altogether — which every audited
  date site needs, since a calendar date without a zone is wrong for half the planet.
  Locale buys presentation and costs the same determinism, so it is refused; this buys
  correctness. A rendered date can therefore change under a tzdata update, and that is the
  accepted boundary.
- **`fixed` ships beside `format`.** Thirteen audited sites mean exactly "two decimal
  places", and the sugar cannot drift, being defined as the specifier form.
- **`round` gains an arity rather than a name**, sharing the formatter's rounding rule —
  otherwise `round(8.165, 2)` and the cell rendered beside it disagree at the boundary,
  which is the defect class this plan exists to close.
- **`formatDuration` requires the day length.** It is a per-organisation policy, not
  arithmetic: 450 minutes is `7h 30m` on an 8-hour day and `1d 30m` on a 7.5-hour one.
  These durations are sums of tracker work items, and a formatter disagreeing with the
  tracker's own workday produces an invoice line and a tracker screen showing different
  durations for the same work, both of which look correct. No week unit: a workweek is a
  second policy constant and no site needs one. The cost is stated rather than hidden: a
  catalog entry is cross-runtime surface, so every future CEL engine is committed to
  rendering this. It is accepted because the alternative shapes are worse — a unit table
  as the argument makes seventeen call sites carry a table instead of an integer, and a
  resource owning the constant is the whole-table shape this plan's closing note argues
  against — and because the day length being an argument is what keeps the policy out of
  the function.
- **Its output is a rendering, not a duration literal.** Its `d` is whatever the second
  argument says a day is; the `d` of a duration written at a manifest slot is 24 hours. So
  `1d 30m` from 510 minutes would mean 24h30m if it were fed back into a slot — a
  threefold error with nothing to report it. Two things keep that from happening, and
  neither is the function's name: the day length is a required argument, so every call
  site states the quantity it is rendering, and the space-separated output is not accepted
  by the slot grammar, which makes the round trip a check-time error rather than a silent
  one.
- **Every date function takes an IANA zone.** A calendar date and a month boundary are
  zone-dependent, and a zone-less version of either is silently wrong for half the planet.
  Rejected: a date pattern language, which opens escaping, locale month names and a
  grammar a second runtime must reimplement; `dateIn` / `isoIn` cover every audited site.
- **`compact` is a CEL function, not a behaviour change to `Http.Request`.** That map is
  typed as string values, so teaching it to omit empty ones would silently stop sending
  `?k=` for every published manifest, with no diagnostic. As a function it composes at the
  call site and works identically for `headers` or any other map. It drops null and `""`
  only — an empty list or map is a value someone deliberately built.
- **No `slug`, `basename`, or normalizing key fold.** The first needs a Unicode policy,
  the second a path-separator policy in a package that must stay browser-safe, and the
  third (`lower(trim(x))`, 15 sites) composes two functions that already exist; `cel.bind`
  plus a named binding is the fix for the copy-drift it causes.
- **No `Console.WriteLines`.** It would solve printing and leave iterate-to-invoke-anything
  untouched, and being JS-only it would drop `modules/console` from full to partial runtime
  reach, since `Console.WriteLine` carries a Rust controller. The inline `Run.Iteration`
  form already collapses the shape.

## Complete example after the change

A billing table cell, today:

```yaml
hours: !cel >-
  [int(round(l.hours * 100.0))].map(c,
    string(c / 100) + '.' + (c % 100 < 10 ? '0' : '') + string(c % 100))[0]
```

and after:

```yaml
hours: !cel "fixed(l.hours, 2)"
# or, once the same row carries exact minutes:
hours: !cel "formatDuration(l.minutes, variables.minutesPerWorkday)"
```

A console listing — today ~22 lines of `Run.Iteration` with an `inputType` schema, after:

```yaml
- name: print
  invoke:
    kind: Run.Iteration
    collection: !cel "inputs.rows"
    steps:
      - name: line
        invoke: !ref Console.writeLine
        inputs:
          output: !cel >-
            '  ' + formatDuration(item.minutes, variables.minutesPerWorkday) +
            '  ' + item.user + '  [' + item.shortName + ']  ' + item.problem
  inputs:
    rows: !cel "steps.run.result.problems"
```

A request that omits blank parameters, replacing eight hand-written conditionals:

```yaml
- name: fetch
  invoke: !ref worklogSearch
  inputs:
    query: !cel "compact({'from': inputs.from, 'to': inputs.to, 'user': inputs.user})"
```

## A note for the consumer side

Two things stay with the reports and are recorded here only so they are not mistaken for
runtime work.

The project rollups drop `minutes` and keep only a 2dp `hours` double, so a duration
formatter downstream has no exact minute count to work from. It turns out not to matter —
recovering minutes as `round(hours * 60)` is exact for every integer minute count from 0
to 200,000 (~3,300 h), because that inverts the specific rounding `round(m / 60 * 100) /
100` precisely; verified exhaustively over that range. But it is an accident of the
formula, tested nowhere, so the reports should carry `minutes` through the two rollups
rather than depend on it.

And the ring chart should stay in decimal hours. `1d 30m` against `2d 15m` is much harder
to compare at a glance than `7.5` against `18.25`, and proportion is the whole point of
the chart. That is a display call, and one more reason to want functions applied per site
over a resource that owns a whole table.
