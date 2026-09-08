# A duration value type

## Problem

**A duration is the most common value in the standard library that JSON Schema cannot
describe, and nothing describes it.** Thirty call sites across thirteen modules —
`cache`, `cache-redis`, `durable`, `durable-local`, `http-client`, `idempotency`,
`kv-store-redis`, `lease`, `oauth-client`, `otlp`, `rate-limit`, `scheduler`, `sql` —
parse a duration string by hand at construction. Every one of those slots is declared
`type: string` with the grammar living in its `description`, so `ttl: "5 minutes"` and
`window: "60"` pass `telo check` and fail at boot, the editor renders a free-text box,
and the one parser is reachable only from a Node controller.

**CEL cannot be pressed into service, and this is the constraint the whole design turns
on.** `duration()` belongs to the CEL engine, its grammar is Go's `time.ParseDuration`
(`ns`, `us`, `ms`, `s`, `m`, `h` — no day unit), and it **cannot be replaced or
removed**. Verified by execution:

```
registerFunction('duration(string): Telo.Duration')
  -> Function signature 'duration(string): Telo.Duration' overlaps with existing
     overload 'duration(string): google.protobuf.Duration'.
```

There is no unregister, no override flag, and no option that omits the standard library.
So `duration("30d")` throws, permanently — while `reclaim: {afterDuration: 30d}` is what
the standard library ships and documents. A manifest that wants arithmetic over its own
duration slot has nowhere to go, and one that reaches for the obvious spelling gets a
runtime error the analyzer never warned about.

**The nominal alternative does not close either half.** `x-telo-type` with a `json`
representation adds a name and emits no check at all — a `json` entry "validates through
its own declared schema" — so it would need a constraint keyword added to the vocabulary
before it was worth anything, and even then the slot's value stays a string, which is
exactly what forces the `duration()` call that cannot work.

## Solution

Eight work items. The value type carries its own parser, so it is the grammar, the check
and the CEL type at once, and nothing has to call `duration()`.

### 1. The grammar

Units `ms`, `s`, `m`, `h`, `d`, `w`, where `d` is 24 hours and `w` is 7 days. Terms
compound (`1h30m`); each may carry a decimal fraction (`1.5h`); an optional `-` may lead;
whitespace is permitted between a magnitude and its unit but **not** between terms. The
total is rounded to the nearest millisecond. An empty string is invalid.

Every duration string in the repository today already parses under it: this is the
current parser's grammar plus `w`, plus compounding, plus a sign.

**Verify.** The vectors above, each direction; `1d` is 86,400,000; `1w` is `7d`;
`1d 30m` is rejected (whitespace between terms); `30 d` is accepted; `5 minutes`, `60`,
`1y`, `2M` and `""` are rejected with a message naming the accepted units.

Release: `.changeset/`, `"@telorun/sdk": minor`.

### 2. The vocabulary gains a parse rule

One entry, and one new field on the entry vocabulary:

```
name: Telo.Duration
representation: instance
binding: duration
parse: {from: string}
```

`parse.from` names the base JSON type a literal may be written as; each runtime supplies
the implementation behind its binding, exactly as `binding` itself is a symbolic name
resolved through a per-runtime table whose missing row is already a hard startup error.
The entry stays free of code, so the Rust reader gains the field and not an
implementation.

**Verify.** The entry loads in both readers; a `parse` naming a base type the runtime has
no row for is a startup error rather than a skipped check, matching `binding`'s rule.

Release: `.changeset/`, `"@telorun/sdk": minor`.

### 3. The literal is checked where it is written

**Before.** An instance-represented type asserts `instanceof` and nothing else, which is
why bytes are documented as never authorable inline — no YAML scalar satisfies it. A
duration slot cannot use that posture, so today it is not a value type at all and gets no
check.

**After.** The `x-telo-type` keyword gains one posture: an entry declaring `parse` passes
a value that is *either* an instance of the binding's constructor *or* a `from`-typed
value the parser accepts. The parser is reached through AJV's value scope, the path the
constructor already takes, so the check survives into the standalone validators the
kernel compiles and caches.

Because every AJV instance in the analyzer and the runtime is registered through one
site, this checks in the browser as well: `ttl: "5 minutes"` becomes a `SCHEMA_VIOLATION`
anchored on its own line at `telo check`. That is the everyday defect this plan exists to
move, and it is the half a nominal brand could never deliver.

**Verify.** A bad literal is reported at `telo check` with no kernel; the same manifest
is refused at boot with the same text; a well-formed literal validates; a slot filled by
a live `Duration` (an expression result) validates; the cached standalone validator
carries the check after a process restart.

Release: `.changeset/`, `"@telorun/analyzer": minor`.

### 4. Coercion, at one site

A slot holding a duration string becomes a `Duration` before the controller sees it —
**after CEL expansion**, not at the point where embedded files are resolved. The ordering
is forced rather than chosen: schema validation deliberately runs before CEL evaluation
so it sees the original manifest shape, so a slot declared `x-telo-eval: compile`
(`Schedule.Interval`'s `every:` is one) holds no value at that point. One coercion site
after expansion, with the keyword accepting both forms, is what stops the rule being
written in two places that can disagree.

A duration crossing an invoke boundary coerces through the walk that already normalizes
declared scalars against a contract, so `inputType`/`outputType` may declare one. A
duration crossing a JSON boundary — the debug wire, a durable journal, an HTTP response —
encodes as its canonical string, the way a BigInt reaches an encoder today.

**Verify.** A literal slot, a `!cel`-valued slot and an invoke input each reach the
controller as a `Duration`; a durable run journals and replays one without loss; the
debug stream carries the canonical string; a resource whose duration slot is optional and
absent stays absent rather than becoming a zero duration.

Release: `.changeset/`, `"@telorun/kernel": minor`.

### 5. The CEL surface

Register `Telo.Duration` as a CEL type over the SDK's class, by constructor, and give it
operators and accessors. Verified to register, evaluate and type-check:

| Overload | Yields |
| --- | --- |
| `Telo.Duration + Telo.Duration`, `-` | `Telo.Duration` |
| `Telo.Duration` `==` `!=` `<` `<=` `>` `>=` | `bool` |
| `timestamp + Telo.Duration`, `Telo.Duration + timestamp`, `timestamp - Telo.Duration` | `timestamp` |
| `Telo.Duration ± google.protobuf.Duration`, and the mirror | `Telo.Duration` |
| `.toMillis()`, `.getSeconds()`, `.getMinutes()`, `.getHours()`, `.getDays()` | `int`, total and truncated |
| `string(Telo.Duration)` | `string` |

`string()` produces the canonical form — largest unit first, zero components dropped, no
spaces (`1d12h30m`, `0s` for zero, a leading `-` when negative) — so it re-parses at a
slot in every case. Member access that is not on the list stays a static `TypeError`, as
it is for any registered type.

`duration()` is left alone and keeps returning `google.protobuf.Duration` under the Go
grammar. The two coexist without a dialect problem because **a manifest never has to
cross**: a slot yields a `Telo.Duration` directly, so the `duration("30d")` call that
cannot work is never the thing an author reaches for. Where a value genuinely does cross
— `timestamp - timestamp` is the only producer of a protobuf duration in reach — the
mixed operators carry it.

**Verify.** Each row above evaluates and reports the stated type; a duration read from a
slot is arithmetic-compatible with one from `duration()`; `string()` output re-parses to
an equal value across the vector set; an unknown method is a static error.

Release: `.changeset/`, `"@telorun/templating": minor`.

### 6. Qualify the stream type, and give the name one reader

`Telo.Stream` is the vocabulary name and its CEL identity is a bare `Stream`. Once a
qualified type exists beside it the convention is a condition rather than a sentence, so
the stream type is renamed to `Telo.Stream` in CEL as well.

**It is invisible, which is why it can be done at all.** A bare type name is not a
resolvable identifier in cel-js — verified: `type(s)` reports `Type<Stream>`, while both
`Stream` and `type(s) == Stream` fail with *Unknown variable*. So the name is reachable
only in `type()`'s rendered output and in type-error text, neither of which a manifest can
write; the internal comparisons move on both sides at once.

**An alias is not available**, and the attempt is worse than the rename. Registering a
second name for the same constructor does not alias, it rebinds — last registration wins,
and everything declared under the losing name then fails:

```
registerType("Stream", S); registerType("Telo.Stream", S)
type(s) -> Variable 's' is not of type 'Stream', got 'Telo.Stream'
```

**The rename also closes a two-place agreement.** The name is written twice today — the
binding table declares `celType`, and the CEL environment separately hardcodes the string
it registers, importing the class from the SDK but not its name. They are different
packages, so a version skew between them yields exactly the mismatch above, silently. The
environment reads the name from the binding table instead, which is the single-reader rule
this repository applies to every other annotation vocabulary.

**Verify.** `type()` reports `Telo.Stream`; a stream flowing into a declared slot still
type-checks; a stream expression at a plain slot behaves as before; the registered name
and the binding table cannot disagree, because only one of them states it.

Release: `.changeset/`, `"@telorun/sdk": minor`, `"@telorun/templating": minor`.

### 7. The Rust half

The binding row, the parser and the slot coercion, in the same change and not after: a
binding with no row is a hard startup error, so shipping the entry alone would stop the
Rust kernel starting at all. No CEL surface there — that kernel has no CEL engine — so
the work is the grammar, the assertion and the coercion.

**Verify.** The shared grammar vectors pass in both runtimes from the same table; a
manifest with a duration slot loads on the Rust kernel; a bad literal is refused there
with the same units named.

Release: none — the Rust crates are `publish = false` and version with the workspace.

### 8. Adoption

Thirty sites across thirteen modules drop their parse call for `.toMillis()`, and each
slot gains the annotation. The existing millisecond parser stays as a thin deprecated
wrapper over the same implementation, so a third-party module that has not adopted the
annotation keeps working unchanged.

Each adopting module declares `requires: telo: ">=<the release that carries it>"`.
`x-telo-type: Telo.Duration` in a module's own manifest is an unknown value-type name to
every older analyzer, which reports `X_TELO_TYPE_UNKNOWN` and blames the module's author
for a version skew; the block converts that into one `MODULE_REQUIRES_NEWER_RUNTIME`
naming the cause. A consumer needs no bound — the annotation ships inside the module's
artifact, and a consumer still writes `ttl: 30d`.

**Verify by execution, per module.** Strip the block, run the previous published CLI
against the module, confirm it rejects; put the block back and confirm the same runtime
reports `MODULE_REQUIRES_NEWER_RUNTIME` instead. A bound whose absence does not produce a
rejection is a claim nothing checks and is not added.

Release: `.changes/pending/`, one fragment naming all thirteen modules, `Changed`.

## Decisions

- **An instance, not a nominal brand.** A `json` representation emits no check, so a brand
  would need a constraint keyword added to the vocabulary and would still leave the value
  a string — half the machinery for none of the outcome. "Instance implies unauthorable"
  is a property of bytes, which have nothing to parse, not of the representation.
- **`parse` is a field on the entry, not a pattern on each slot.** A regex repeated at
  thirty slots is the copy-drift this repository avoids everywhere else, it cannot produce
  a typed value, and it would state the grammar in a place no second runtime reads.
- **Days and weeks are in; months and years are out.** The honest line is fixed-length
  versus variable-length, not day versus hour: `d` and `w` are exact multiples, `M` and
  `y` are 28–31 days and 365–366. Go excludes `d` on an expectations argument that does
  not survive its own acceptance of `h`, and every audited use of `d` here — reclaim
  windows, TTLs, retention bounds — is elapsed wall-clock, where 24 hours is the meaning
  rather than an approximation of one. Calendar semantics live in `Schedule.Cron`.
- **No `ns` or `us`.** The runtime is millisecond-grained end to end — every consumer of a
  duration reaches a millisecond timer — so admitting sub-millisecond units would be a
  promise nothing keeps. This makes the grammar not a superset of Go's, which is stated
  rather than hidden: it is the only place the two differ apart from `d` and `w`.
- **Whitespace between a magnitude and its unit, never between terms.** The first
  preserves what the current parser accepts, so no published string stops parsing. The
  second is what keeps a work-time rendering (`1d 30m`, where `d` is a workday) out of a
  duration slot, where `d` is 24 hours — turning a threefold silent error into a
  check-time rejection.
- **A leading `-` is accepted.** Arithmetic produces negative durations, `string()` must
  round-trip whatever it is given, and a rule that parsed only what it could not print
  would be the one asymmetry in the type. A slot needing non-negative says so with a
  resource rule.
- **Coercion runs after CEL expansion, at one site.** Before validation is where embedded
  files resolve, and it is too early: validation deliberately precedes CEL evaluation, so
  a `x-telo-eval` slot has no value yet. Two coercion sites for one rule is the drift this
  design is meant to remove, so the keyword accepts both forms instead.
- **`duration()` is left alone.** It cannot be replaced — verified — and the alternatives
  are worse than coexistence: a second constructor under another name is a dialect split
  with two grammars, and registering the SDK's class under `google.protobuf.Duration`
  would leave one type name resolving to two classes with the unreplaceable built-in
  overloads still winning. Coexistence costs a handful of mixed operators and no author
  ever writes the crossing.
- **A Telo CEL type is qualified; the reason is collision, not symmetry.** The shipped
  instance type registers bare (`Telo.Stream` in the vocabulary is `Stream` in CEL), and
  that was unambiguous because nothing else is called Stream. Duration is the one name
  where a bare spelling sits beside a type with different units, a different grammar and a
  constructor that cannot be replaced: `Type<Duration>` against
  `Type<google.protobuf.Duration>` reads as one thing abbreviated, where
  `Type<Telo.Duration>` reads as two things. Qualifying is also the intended use of the
  namespace — it is where a host registers its own types, which is what a proto-backed
  deployment does with its whole schema.
- **`Telo.`, not the protobuf spelling.** Package names in protobuf are lowercase, so the
  foreign convention would be `telo.Duration`. The mechanism is worth adopting and the
  spelling is not: `Telo.` is already the prefix on all four value types and on every
  built-in kind an author writes, so a lowercase variant visible only in `type()` output
  would be a second spelling of one prefix.
- **Nothing constructs a `Telo.Duration` in CEL.** A value arrives from a slot or from
  arithmetic on one, and that is the whole set. A constructor would have to be a new
  global — `duration()` cannot be extended for it — so it would put a second duration
  constructor with a second grammar in the same namespace, which is the dialect split this
  design exists to avoid. Nothing needs one: the type's purpose is to be what a slot
  yields.
- **Accessors are totals, truncated.** `getMinutes()` on `2h30m` is 150, matching what the
  engine's own duration accessors already do. A component-wise reading would make two
  duration types in one environment answer the same question differently.
- **The existing millisecond parser is kept, deprecated, over the same implementation.**
  It is on the published module-author surface; deleting it would break third-party
  controllers for no gain, and reimplementing it separately would be a second grammar.
- **`Telo.Duration` is not in the formatting plan.** That plan is CEL's output layer —
  render a value as a string for a human — and its seventeen duration sites take integer
  minute counts from a tracker API, not manifest-declared durations. The two share a word
  and no mechanism.

## Complete example after the change

A cache entry, today — the grammar is prose, the check is at boot, and CEL sees a string:

```yaml
ttl: 30d
staleTtl: 5m
```

and after — the same text at the slot, and two things the manifest could not say before:

```yaml
ttl: 30d
staleTtl: 5m
expiresAt: !cel "string(timestamp(nowSeconds()) + self.ttl)"
grace: !cel "self.ttl + duration('12h')"
```

`ttl: "30 days"` is now a `SCHEMA_VIOLATION` on that line rather than a boot failure; the
controller receives a `Duration` and asks it for `.toMillis()`; and the two expressions
show the only crossing an author ever writes — a CEL duration literal still spells its
units Go's way, because that constructor is the engine's and cannot be replaced.
