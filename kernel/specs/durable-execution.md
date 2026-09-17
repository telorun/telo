---
description: "v1.1 spec: the kernel's half of durable execution — the replay contract every step engine must satisfy, the determinism rules, the key scheme, suspension as a signal, and what a backend must guarantee about its journal"
---

<!--
Normative. Two runtimes that guessed differently here would not merely accept
different manifests — they would corrupt durable state, because a journal
outlives the process that wrote it and is read back by whatever is running then.
-->

# Telo Durable Execution Specification (v1.1)

## 0. Status, scope, and how to read this

This specification covers **the kernel's half** of durable execution and the
**replay contract** every step engine must satisfy. It deliberately does not
specify a durable-execution *engine*: there is no shared lifecycle vocabulary,
no shared start/schedule/cancel surface, and no portable `Durable.*` driver.
Each backend ships its own module in its own words.

What is normative here is only what two runtimes must agree on:

1. how the run handle is carried and what must not clear it (§2, §3);
2. the **replay determinism contract** the step engine is bound by (§4);
3. the **key scheme and entry format** for a backend that keys by path (§5);
4. what a journaled value may be (§6);
5. the conformance requirements every backend keeps (§7).

MUST / MUST NOT / SHOULD are as in RFC 2119.

**v1.1 adds suspension**: `park`, the swallow latch, branch-level parking under
concurrency and suspending retry (§2, §5.2, §7, §9). v1.0 specified a run that
could crash and resume but not wait; a run that can wait is what makes durable
execution useful for work measured in days rather than in retries.

## 1. What durable execution is here

Durable execution is **journal plus deterministic replay**. Telo can have it
because of a property that fell out of the step grammar's design: control flow is
a finite, DECLARED set of CEL expressions over run state, not arbitrary code. So
replay is re-running the step list while returning recorded values instead of
computing them. There is no continuation capture, and there MUST NOT be — a
mechanism that captured a continuation would be capturing one runtime's stack.

This is a structural advantage Telo has and hosted engines do not. Temporal and
Restate rely on determinism discipline plus divergence detection precisely
because their workflow bodies are arbitrary code with no finite set of decision
points; you cannot journal "the decisions" of a `while` loop in TypeScript
without instrumenting the language.

## 2. The run handle

A **run handle** is the object a step engine journals through. Its contract is a
language-level interface in `@telorun/sdk` (`DurableRunHandle`), not a resource
kind and not a kernel type:

- **`step(path, target, inputs, execute)`** — hand over an effect. The backend
  decides *whether* (replay returns the recorded result) and *where* (in process
  now, or shipped elsewhere and awaited).
- **`decide(path, kind, compute)`** — a control-flow decision, recorded on first
  execution and returned verbatim on replay.
- **`park(where, until)`** — suspend the run, recording WHERE it parked. A
  backend MUST write the park before it unwinds: the signal only unwinds the
  calling process's stack, so a park that threw first leaves a run marked
  running with nothing executing it, and its wake token lost. (§7.)
- **`writesInside(zone)`** — a *question*: does this handle's own recording land
  inside the given zone's atomicity? (§8.)

**Why `step` and not lookup-plus-record.** The obvious factoring — *have you a
result at this key* / *record this one* — is a leaky decomposition: two halves of
a single operation, split so that the CALLER performs the effect in between. That
bakes in an assumption nothing stated, that the step engine and the resource
graph are co-located. But *where an effect executes* is a real architectural
axis: orchestration is deterministic and cheap, effects are neither, and
separating them is what lets a system scale, version and retry them
independently. A seam that hardcodes in-process chooses one side of that axis
permanently.

`execute` is therefore the *local capability* the backend may use, not a caller
that runs the effect between two halves.

**The kernel is a pure conduit.** It carries the handle and MUST NOT call it. A
runtime therefore needs no durable contract of its own, and a backend is an
ordinary module.

## 3. Carriage

**The handle MUST be reachable from nested dispatches, and so MUST the path of
the step that dispatched them; how is the runtime's choice.** That is the whole
normative statement. The Node kernel satisfies it by putting both on
`InvokeContext` beside `zones` and letting the existing ambient store carry them;
a runtime with no ambient mechanism threads them explicitly.

Two things travel, not one, and the second is easy to miss because a backend that
matches by ORDER never reads it. A path-keyed backend does, and a nested body that
never received the enclosing path keys its records as though it were the only body
in the run (§5.1).

**It is its own member, not a zone-entry payload.** The durable zone IS a real
zone and rides the landed stack, but a `ZoneEntry` is three identities *because*
that keeps it ABI-serializable and stops any controller reading another module's
open state off the stack. A live object with methods on the entry would trade
that property away for every zone, durable or not — and the payload rule
(provider-private state lives on an instance injected across the boundary) cannot
carry it either, since a nested step body holds no durable reference and has no
injected instance to read from.

The consequence is stated rather than implied: **unlike `zones`, the handle does
NOT cross the ABI.** A second runtime threads a handle it owns.

**Every context rebuild MUST go through the runtime's single derive function.** A
fresh object literal at a rebuild site drops whatever it does not restate, which
for this member means durability that is present with tracing off and absent
under a debug flag.

**Clearing follows the zone rules unchanged.** A detached dispatch and an inbound
trigger's `rootContext()` both replace the ambient with a root that carries no
handle — which is correct, and is what makes a nested durable run a *new* run
rather than a continuation of its parent.

## 4. The replay determinism contract (normative)

> On replay, a step engine MUST reach the same steps, in the same order, against
> the same targets, with the same collapse decisions, as the execution the
> journal records.

It is **discharged by construction**, not by discipline: every value that could
make the engine reach a different step is journaled through `decide`. Stating it
as a contract rather than relying on it as an assumption is what lets a backend
that matches replayed frames against re-issued calls assert something real.

**Every decision point MUST be journaled.** The set is closed by the grammar, and
for v1.1 it is exactly:

| Decision | Journaled as |
| --- | --- |
| a step's resolved `inputs` | `inputs` |
| an `if` / `elseif` predicate, a `when` guard | `predicate` |
| a `while` condition, per turn | `condition` |
| a `switch` key | `switch` |
| a `value:` step's expression | `value` |
| a park's wake time, token, or retry attempt | `value` |
| a collection a composer iterates | `collection` |

**The last two rows are the composer's own, not the step engine's.** A kind that
DRIVES a body — an iteration, a projection, a loop of its own — evaluates the
collection it will walk and the condition it tests per turn *before* it hands a
step list over, so the engine never sees either and cannot journal them on the
composer's behalf. Each such kind records them itself, through the same `decide`,
under a path qualified by the dispatch it belongs to and by the turn. A composer
that skips this leaves two holes in the closure property at exactly the points
this table names.

**The tempting claim — "a run's entire mutable state is the `steps` map" — is
FALSE, and this is the load-bearing paragraph of the whole specification.** The
CEL scope those expressions evaluate against also carries `resources.<name>`
snapshots, `resources.<name>.status` (a live reading, republished on every
dispatch *by design*), provider values, variables and secrets. Re-evaluating any
of them in a fresh process against freshly-created resources can yield a
different answer, and the sharpest case is silent: an iteration whose collection
comes from a resource read returns a different order on resume, index N now names
a different element, and the journal hands back the recorded result for that path
— with the same target, so no mismatch is detectable. Wrong results, no error,
which is the precise failure durability exists to prevent.

**A digest-and-detect scheme MUST NOT be substituted.** It is equally closed for
*detection* and much cheaper, and it is wrong: observed state is *defined* as a
live reading, so a run would fail on every resume where the world had moved,
which it usually has. That is fragility with good error messages, not durability.
Recording the value removes the failure instead of reporting it.

Replay is then a pure function of `(journal, manifest)` — a **closure property**,
and closure is what makes this survive: an ambient value source added years from
now (a new scope variable, a new binding form, a new provider kind) is covered
without anyone re-auditing a list.

**A module function is covered by the same property, with no journaling of its
own.** A call inside an expression has no step path, and needs none: the
expression it sits in is a decision point, so its whole value — calls included —
is recorded once and replayed. `value: !cel "Billing.total(items)"` that reads the
clock on the first pass yields the recorded result on resume, however the clock
has moved. What a function's determinism still decides is whether a region
declared `idempotent` may call it, since such a region RE-RUNS its body rather
than replaying a recorded value (`DURABLE_NONDETERMINISM`, which names the chain
to the non-deterministic leaf).

## 5. The key scheme and entry format

This section binds any backend that **keys by path**. A backend that assigns its
own indices (both hosted engines do) satisfies §4 instead, which is what makes
order-based matching sound.

### 5.1 A step path

A path is `/`-joined segments; a repetition qualifies its segment with `[index]`.

```
steps/createAccount
steps/checkStock/if
steps/checkStock/then/reserve
steps/poll/while[3]
steps/poll/do[3]/fetch
steps/importAll/cases/bulk/write
```

Both the segments and the indices are properties of the **written structure plus
the run's own journaled decisions**, never of wall-clock order. This is what
makes the scheme survive concurrency, where a per-run call ordinal would not: two
branches of a fan-out interleave their dispatches, so an ordinal numbers them
differently on every run while these paths stay fixed. It is also what makes each
branch of a fan-out an **independently resumable subtree**.

**A NESTED body's paths hang under the step that dispatched it.** A step body is
not only found at the top of a run: a step may dispatch a target that has a body
of its own, and that body's engine MUST continue the enclosing path rather than
start again at `steps`.

```
steps/charge                     ← the step
steps/charge/announce            ← a step of the body it dispatched
steps/charge/work
```

This is normative because getting it wrong is silent and is wrong on the FIRST
run, not merely on a resume. A nested engine that restarted at the root would
record `steps/<name>` for every body in the run, so two nested bodies with a
same-named step share one key; the first record wins, and the second body's step
is handed the first's RESULT without executing. Where both dispatch the same
target there is no mismatch to detect (§5.3) and nothing reports it.

It is also what makes a nested body independently resumable: an interruption
inside one resumes at the step of it that had not finished, rather than re-running
the whole body.

**A record the runtime keeps beside a step's nested body uses a reserved
segment.** A decision recorded under a step's own path — its `when:` guard — shares
that path with every step of the body the step dispatches, so a segment spelled
like a step name is a key a nested step can collide with: the first record wins,
and the nested step is handed the decision's value instead of running, on the
first pass. Such a segment MUST therefore start with a character outside the
step-name grammar (`^[A-Za-z_][A-Za-z0-9_]*$`); the guard is `@when`:

```
steps/charge/@when               ← the guard of the step `charge`
steps/charge/when                ← a step named `when` in the body it dispatched
```

Older records keyed by a plain word (`inputs`, `retry[<n>]`) predate this rule
and keep their spelling, because journals written with them must still replay.

**How the enclosing path reaches the nested engine is the runtime's choice**, and
the requirement is only that it does. The Node kernel carries it on
`InvokeContext` beside the run handle, so a composer that knows nothing about
durability — an ordinary sequence — passes it along with the context it already
threads. A runtime with no ambient mechanism threads it explicitly, exactly as it
threads the handle.

A path is composed by the runtime's shared helper (`stepPath` in
`@telorun/sdk`). A backend MUST NOT compose one itself: a journal outlives the
process that wrote it, so two step engines keying differently produce one neither
can replay.

**What a path-keyed backend treats as a change, an order-matched one does not.**
Renaming a step, or moving one into a nested body, leaves the ORDER of dispatches
identical while changing the key — so the edit is invisible to a backend
satisfying §4 by order, and causes that step to execute afresh on a backend keyed
by path. Neither is wrong; they are the two matching strategies this section
deliberately permits, and the difference is a property of the backend rather than
of the manifest. An author moving steps under a live run should expect the
path-keyed backend to re-run what it can no longer find.

### 5.2 Entries

Three entry shapes. A backend MAY store them however it likes; what is normative
is that these fields exist and mean this.

**A step entry** — written on COMPLETION, never on dispatch:

```yaml
path: steps/createAccount
kind: step
target: { kind: Sql.Transaction, name: accountTx }   # §5.3
v: 1
result: { id: 41 }
```

**A decision entry**:

```yaml
path: steps/checkStock/if
kind: decision
decision: predicate
v: 1
value: true
```

**A recorded value is a TYPED FRAME (§6.1), under a codec version.** A journal is
a boundary whose reader turns the value back into a live value inside a Telo
runtime, and it is the boundary where getting that wrong is least visible: plain
JSON replays a timestamp as text, an `int` as a `double` and `bytes` as an object
keyed by index, so an expression that worked on the first pass computes something
else on resume with nothing reported. `v` is `1`, and it is bumped only for a
change an older reader would MISREAD.

- An entry carrying **no `v`** is read with whatever codec its store used before
  this rule existed. Legacy entries are read rather than refused: refusing one
  would strand every run parked before the change, which is the opposite of what
  a journal is for.
- An entry carrying a **`v` the reader does not know** MUST be refused, never
  read for the fields it recognizes — the same rule §5.3 states for a step
  target's encoding, applied to the record. A later codec may mean something else
  by the same bytes, and a run replayed against a misread value is the corruption
  durability exists to prevent. `ERR_DURABLE_ENTRY_UNDECODABLE`.

**A step that produced NOTHING is journaled all the same, as an entry with no
value.** The entry is what says the step completed, so omitting it would re-run
the step on every resume; and absence belongs to the ENTRY rather than to a
value, because `undefined` is not a CEL value and a frame that gave it a form
would stop being one-to-one (§6.1 refuses a bare `undefined` by design). Such an
entry replays as the absent value, which is what the target returned.

**A run record**:

```yaml
run: "onboard:ada@example.com"
manifestDigest: sha256-9f2c…
digestScope: reachable        # `reachable` | `manifest`
status: running               # scheduled | running | parked | completed | failed | cancelled
parked:                       # present while `status: parked`
  path: steps/waitForApproval # where a resume re-enters, and where a delivery writes
  resource: approval          # what it is waiting on, for an operator
  token: 0f3c…                # the address a delivery must carry
  at: 1787159304535           # when it becomes due with no delivery
inputs: "…"                   # a scheduled run's inputs, as a typed frame
inputsCodecVersion: 1
result: "…"                   # present once completed, as a typed frame
resultCodecVersion: 1
```

**A run record's `inputs` and `result` are recorded values too**, under the same
codec and the same version rules as an entry's value, each beside its own version
— one per value, because a run admitted by one runtime may be settled by another.
A scheduled run's body starts from `inputs`, and a caller reads `result`, so
either written as plain JSON would hand a later reader a value of a different
type. A member of `result` holding no value — a step that produced nothing — is
left out, the reading an entry with no value already has.

`cancelled` is deliberately distinct from `failed`: a failed run earned a
verdict, a cancelled one was called off, and collapsing them makes every
cancelled run indistinguishable from a broken one in the report an operator
reads to find out which happened.

**Journal on completion** is the rule the whole format rests on, and it is what
makes `with:` scopes work unchanged: a scope target that completed is skipped on
resume, while a long-lived service whose `run()` stays pending has no entry and
is re-dispatched — which is exactly right after the process holding its listener
died.

### 5.3 Target identity

A step entry records **where its target is declared**, not which live object it
was. Instance identity is process-local by construction (`ResourceHandle.ref` is
declaration-site *diagnostics*, and there is deliberately no reverse
handle→instance mapping), so a recorded instance would be meaningless to the
process that reads the journal back.

The identity has three forms, derivable identically by the analyzer and at
runtime:

- a **module-level** resource — `(module ref, resource name)`; names are dot-free
  by the reference grammar's load-bearing invariant, so the pair is unambiguous;
- a **`with:`-scoped** resource — `(module ref, scope owner, scope site, step
  path, resource name)`. The scope *run* is what makes a scoped instance
  distinct, and inside a durable run a scope run is opened by a step at a
  determined path, so the tuple is deterministic;
- an **inline-declared** target — `(module ref, declaring resource name, JSON
  pointer to the declaration)`. Anonymous in the manifest, not anonymous in the
  graph. A step's inline dispatch target is the exception: it carries no pointer
  and is identified by its name, the concatenation of `P(ownerKind)`,
  `P(ownerName)`, `P(s)` for each step-path segment `s` in order, and
  `P(stepName)`, where `P` splits its argument on runs of characters outside
  `[A-Za-z0-9]`, drops empty pieces, upper-cases each piece's first character
  and joins them.
  - `ownerKind` is the `metadata.name` of the definition whose controller runs
    the body: the kind itself, or its nearest `extends` ancestor carrying a
    controller. `ownerName` is the name of the resource holding the body.
  - The step path is the body field — for a `base:` child, the ancestor field
    it is mapped onto — and the step's index in it, then for each enclosing
    branch its key and the index within it: `then`, `elseif` + index + `then`,
    `else`, `do`, `cases` + case key, `default`, `try`, `catch`, `finally`.
  - An inline target declaring its own `metadata.name` keeps that name.

  The name is not injective (`a` with a step `steps0B` and `aSteps0` with a
  step `b` both yield `SequenceASteps0Steps0B`), so it identifies a target only
  as far as it is distinct among the module's resource names.

#### The encoding

An identity that never leaves the process needs none of this — a local backend
resolves it in place. What follows binds a runtime that **sends one anywhere**: a
step executed in another process, a frame on an open invocation, an entry read by
a second-language kernel.

It is **JSON**, because a journal entry already carries its target as JSON and a
second serialization vocabulary for one value is a second thing to keep agreeing.
What the format adds over "some JSON" is what a format has to add:

- **A canonical key order** — `v`, `kind`, `name`, `module`, `pointer`, `scope`,
  and inside `scope`, `owner`, `site`, `stepPath`. Two runtimes producing the same
  identity MUST produce the same bytes, so a recipient can compare, log and key on
  the encoded form without parsing it first.
- **A version.** `v` is `1`. A reader receiving a version it does not know MUST
  refuse the identity rather than read the fields it recognizes: those fields may
  mean something else in a form it has never seen, and resolving anyway executes a
  step against a resource nobody named. `v` is bumped only for a change an older
  reader would MISREAD; a new optional field it can ignore is not one.
- **Required fields per form.** `kind`, `name` and `module` are required in every
  form. `module` in particular: it is what tells two libraries' same-named
  resources apart, and a recipient resolving without it picks whichever it saw
  first. `pointer` marks the inline form, `scope` the scoped one, and a value
  carrying **both** MUST be refused — that is not a fourth form but a
  contradiction. A `scope` MUST carry all three of its fields, since a scoped
  instance is distinguished by its scope RUN and an identity missing that names
  every run of the scope at once.

**Knowing a target is scoped is separate from identifying which run**, and a
runtime MUST keep the two apart. A step engine can see that a name resolved
inside a scope — the resolution is what answers it — while the tuple needs the
step path the scope was opened at, which a scope handle may be built without. A
scoped target whose tuple is unavailable MUST be refused, exactly as an
incomplete `scope` is: encoded as though it were module-level, it resolves at the
far end to a DIFFERENT resource that merely shares its name, which is the failure
this whole section exists to prevent.

An identity that cannot meet this MUST be refused **at the sender**, where the
manifest that produced it is still in reach, rather than encoded partially and
resolved to something merely similar at the far end.

```json
{"v":1,"kind":"Mail.Send","name":"sendMail","module":"oci://ghcr.io/acme/mail@1.2.0"}
```

**Deriving the identity is the runtime's own problem, and it is not free.** A
step's `invoke:` slot resolves at DISPATCH rather than at injection, so the value
the step engine holds is a reference, not a stamped instance — a runtime MUST
recover the declaration site from the instance the reference resolves to, by the
same resolution the dispatch itself uses, or the identity it encodes will describe
a resource other than the one the step reaches.

A replay that reaches a **different target** than the entry at that key records
MUST raise `ERR_JOURNAL_ENTRY_MISMATCH`.

## 6. What may be journaled

A journaled value MUST be serializable. Two consequences:

- **A live value is not journalable.** A `live`-representation value (`x-telo-type`
  with `live: true` — a stream handle today) is consumed by reading, so it exists
  exactly once and a recording of it is a recording of nothing. This holds in
  BOTH positions — a step result and a decision — and a runtime MUST raise
  `ERR_DURABLE_UNJOURNALABLE_VALUE`, **at the step path that produced it**.
- **A declared `outputType` is better but not required.** Demanding one on every
  journaled step's target does not prove what it advertises — the contract
  resolver's layers mean a declared `{type: object, additionalProperties: true}`
  satisfies such a check and proves nothing, while an *undeclared* contract falls
  back to the same permissive shape. So the runtime is the gate and the static
  half is a warning. This is the *enforced at runtime, warned early* division
  applied to the same kind of problem as containment.

### 6.1 The typed frame

A boundary whose reader turns a value back into a live value inside a Telo
runtime writes it as a **typed frame**: one JSON form, independent of any schema,
covering the whole CEL value domain. It is one-to-one — reading a frame gives back
the value that was written, CEL type included, and two different values never
share a frame. A schema cannot give that: an open contract declares no type to
read against, and replay must be a pure function of journal and manifest down to
the CEL type.

- `null`, `bool`, `string` and `list` are JSON null, boolean, string and array.
- A `double` is a JSON number, and an untagged number always reads back as a
  `double`, whatever its digits. The four doubles a JSON number cannot carry
  faithfully are tagged `double`: NaN, `+Infinity` and `-Infinity` have no JSON
  number, and negative zero does not survive common stores (a PostgreSQL `jsonb`
  number has no negative zero).
- An `int`, `uint`, `bytes`, `google.protobuf.Timestamp` or
  `google.protobuf.Duration` is always tagged:
  `{"$telo":"<CEL type name>","value":"<payload>"}`.
- A `map` whose keys are all strings, none of them `$telo`, is a JSON object. Any
  other map — one with an `int`, `uint` or `bool` key, or with the key `$telo` —
  is tagged `map`, its value a list of `[key, value]` pairs. That is what keeps
  the frame one-to-one: an object member named `$telo` is always a tag.

A tagged value carries exactly the two members `$telo` and `value`.

**The domain.** Each runtime maps each CEL type to its own representation; in
Node `int` is a `bigint`, `uint` the SDK's `UnsignedInt`, `bytes` a `Uint8Array`,
a timestamp a `Date`, a duration the SDK's `Duration`, a list an array and a map a
plain object or a `Map`. A writer MUST refuse, with
`ERR_TYPED_FRAME_UNENCODABLE` and the JSON Pointer of the offending node inside
the value, anything else a host value can be:

- a value of no CEL type — an instance of any other class, **including one that
  offers a JSON conversion** (`toJSON`), which would read back as a different
  value; a function; a symbol; an absent or undefined value, at the root or inside
  a container; a hole in a list;
- a map key that is not an `int`, `uint`, `bool` or `string`, or two keys with the
  same value — **including an `int` and a `uint` of the same number**, which CEL
  equality makes one key, so a map carrying both is not a map and is refused in
  both directions;
- an `int` outside int64, a timestamp outside `0001-01-01T00:00:00.000Z` to
  `9999-12-31T23:59:59.999Z`, a duration of more than 315,576,000,000 whole
  seconds either side of zero;
- a string that is not Unicode text (an unpaired UTF-16 surrogate);
- a value that contains itself.

A runtime that must record such a value re-raises the refusal in its own terms —
at a step path, `ERR_DURABLE_UNJOURNALABLE_VALUE` (§6).

### 6.2 Canonical text

A writer MUST produce one text per value, so two runtimes writing one value write
the same bytes and a frame can be compared or keyed on without parsing it. The
text is the RFC 8785 canonical form of the frame:

- no whitespace;
- a string escapes `"` and `\`, writes U+0008, U+0009, U+000A, U+000C and U+000D
  as `\b`, `\t`, `\n`, `\f` and `\r`, writes every other code point below U+0020 as
  `\u00xx` in lowercase hex, and writes everything else literally, including `/`,
  U+007F and U+2028;
- a number is written in ECMAScript `Number::toString` form: the shortest digits
  that read back as the same double — of two such candidates, the one closer to
  the double, and of two equally close, the one ending in an even digit — in
  exponent form (`1e+21`, `1e-7`) outside the range 1e-6 ≤ |x| < 1e21;
- object members are ordered by key, compared as UTF-16 code units.

A tagged map's pairs are ordered by the canonical text of each key's frame,
compared as UTF-16 code units, so keys of different types share one order.
Nothing about a host's representation reaches the text: insertion order, a
string-keyed `Map` against a plain object, or a duration held as `-2s + 0.5s`
against `-1s - 0.5s`.

A reader MUST accept any JSON syntax for the frame's structure — whitespace and
member order included — because a store may rewrite it (`jsonb` reorders
members). A reader reads a JSON number as the double nearest its decimal value,
rounding half to even, whatever form it is written in, so a store that rewrote
`1e-7` as `0.0000001` yields the same value. It MUST refuse, with `ERR_TYPED_FRAME_UNDECODABLE` and the JSON Pointer
of the offending node inside the frame: a tag outside §6.3, a tagged object with
any other member, a payload not in its canonical form, a tagged map whose keys
are all strings other than `$telo`, a map key that is not an `int`, `uint`,
`bool` or `string`, a repeated key, a string that is not Unicode text, a member
name an earlier member of the same object already carries (no writer produces
one, and a store that rewrites a frame keeps one), and a number whose nearest
double is not finite (`1e400`; an infinity is tagged). Text that is not JSON is
refused before anything else, at the empty pointer; a repeated member name is
refused before any value is read, at the first repeat in text order. A key in a
pointer is written with each unpaired surrogate replaced by U+FFFD.
Payloads are read only in their canonical form because a lenient reader silently
changes what another writer meant: a timestamp carrying nanoseconds would be read
at millisecond precision, and a duration written `1.500s` would read back equal
to one written `1.5s` while its frame differs.

### 6.3 Tag vocabulary

The vocabulary is closed. A new tag is a change to this specification, and a
reader refuses a tag it does not know rather than reading the object as a map.

| Tag | CEL type | Payload |
| --- | --- | --- |
| `int` | `int` | Decimal text of an int64: `0`, or an optional `-` and digits with no leading zero |
| `uint` | `uint` | Decimal text of a uint64: `0`, or digits with no leading zero |
| `double` | `double` | One of `NaN`, `Infinity`, `-Infinity`, `-0` |
| `bytes` | `bytes` | Base64url (RFC 4648 §5) without padding, unused trailing bits zero |
| `google.protobuf.Timestamp` | `google.protobuf.Timestamp` | `YYYY-MM-DDTHH:MM:SS.sssZ`: UTC, exactly three fractional digits |
| `google.protobuf.Duration` | `google.protobuf.Duration` | Seconds with an `s` suffix: an optional `-`, whole seconds with no leading zero, and, when not whole, `.` and up to nine digits with no trailing zero (`5400s`, `-1.5s`, `0.000000001s`) |
| `map` | `map` | A list of `[key, value]` pairs, each a frame |

**A timestamp's precision is one millisecond**, the finest instant every Telo
runtime holds (Node's timestamp is the host `Date`). A runtime whose own timestamp
type is finer MUST hold only whole milliseconds in a value that reaches a frame,
and its writer MUST refuse one that is not rather than round it. A duration keeps
nanoseconds.

### 6.4 Plain encoding

The **plain encoding** is the one canonical JSON form of each value at an
external boundary — a transport body, a log line, a CLI's JSON output — whose
reader is not a Telo runtime. A write there is keyed on the value and a read on
the slot's declared schema, and `$telo` never appears.

| CEL type | Written | Read |
| --- | --- | --- |
| `google.protobuf.Timestamp` | RFC 3339 in UTC, as the payload in §6.3 | RFC 3339 with any offset |
| `google.protobuf.Duration` | Seconds, as the payload in §6.3 | Any CEL duration string (`1h30m`) |
| `bytes` | Base64url without padding | The same form |
| `int`, `uint` | Its exact decimal digits, as a JSON number | A JSON number |

An `int` or `uint` follows `kernel/specs/invocation-contract.md` §4.4: exact
digits, never a double and never a quoted string, with the `otlp` and `json` log
encodings as that section's named exceptions (the `json` encoding writes a number
within ±(2^53−1) and a decimal string beyond it). A typed frame carries the same
digits as its payload text. Every tagged scalar payload in §6.3 is the type's plain
encoding, so each type still has exactly one written form.

### 6.5 Error codes

`ERR_TYPED_FRAME_UNENCODABLE` (§6.1) and `ERR_TYPED_FRAME_UNDECODABLE` (§6.2) each
carry `path`, a JSON Pointer: inside the value for the first, inside the frame for
the second.

### 6.6 Conformance vectors

These tables are normative. `kernel/specs/durable-execution-typed-frame-vectors.json`
carries the same rows for tests to read, and a runtime's codec tests MUST assert
both directions of every row: the value writes exactly the frame and the frame
reads back as the value, and every undecodable frame is refused with the path
shown. The same file's `doubles` corpus pairs the IEEE 754 bits of a double, in
hex, with the text a writer produces for it — random doubles and equally close
ties — and a runtime's tests MUST write every one of them exactly.

A value is written in a notation independent of every frame form, one member per
node:

- `{"null":null}`, `{"bool":<boolean>}`, `{"string":<string>}`;
- `{"double":<number>}`, or `{"double":"NaN" | "Infinity" | "-Infinity" | "-0"}`;
- `{"int":"<decimal>"}`, `{"uint":"<decimal>"}`;
- `{"bytes":[<byte>, …]}`;
- `{"timestamp":{"seconds":"<decimal>","nanos":<0..999999999>}}`, seconds since
  the Unix epoch;
- `{"duration":{"seconds":"<decimal>","nanos":<number>}}`, `nanos` carrying the
  sign of `seconds`;
- `{"list":[<value>, …]}`;
- `{"map":[[<key>, <value>], …]}`, in the order given — the writer orders them.

Values a runtime writes and reads:

| Name | Value | Frame |
| --- | --- | --- |
| null | `{"null":null}` | `null` |
| bool | `{"bool":true}` | `true` |
| empty string | `{"string":""}` | `""` |
| string escapes | `{"string":"quote\" backslash\\ tab\t nl\n cr\r bs\b ff\f ctl\u0001\u001f del ls  slash/ é 😀"}` | `"quote\" backslash\\ tab\t nl\n cr\r bs\b ff\f ctl\u0001\u001f del ls  slash/ é 😀"` |
| double zero | `{"double":0}` | `0` |
| double fraction | `{"double":1.5}` | `1.5` |
| double integral | `{"double":5}` | `5` |
| double large exponent | `{"double":1e+21}` | `1e+21` |
| double small exponent | `{"double":1e-7}` | `1e-7` |
| double above exponent threshold | `{"double":0.000001}` | `0.000001` |
| double above exponent threshold with digits | `{"double":0.000001234}` | `0.000001234` |
| double below exponent threshold | `{"double":123456789012345680000}` | `123456789012345680000` |
| double subnormal | `{"double":5e-324}` | `5e-324` |
| double most negative | `{"double":-1.7976931348623157e+308}` | `-1.7976931348623157e+308` |
| double tie to even | `{"double":1887591991632234.2}` | `1887591991632234.2` |
| double NaN | `{"double":"NaN"}` | `{"$telo":"double","value":"NaN"}` |
| double infinity | `{"double":"Infinity"}` | `{"$telo":"double","value":"Infinity"}` |
| double negative infinity | `{"double":"-Infinity"}` | `{"$telo":"double","value":"-Infinity"}` |
| double negative zero | `{"double":"-0"}` | `{"$telo":"double","value":"-0"}` |
| int zero | `{"int":"0"}` | `{"$telo":"int","value":"0"}` |
| int min | `{"int":"-9223372036854775808"}` | `{"$telo":"int","value":"-9223372036854775808"}` |
| int max | `{"int":"9223372036854775807"}` | `{"$telo":"int","value":"9223372036854775807"}` |
| uint zero | `{"uint":"0"}` | `{"$telo":"uint","value":"0"}` |
| uint max | `{"uint":"18446744073709551615"}` | `{"$telo":"uint","value":"18446744073709551615"}` |
| bytes empty | `{"bytes":[]}` | `{"$telo":"bytes","value":""}` |
| bytes url-safe alphabet | `{"bytes":[251,255,0]}` | `{"$telo":"bytes","value":"-_8A"}` |
| timestamp epoch | `{"timestamp":{"seconds":"0","nanos":0}}` | `{"$telo":"google.protobuf.Timestamp","value":"1970-01-01T00:00:00.000Z"}` |
| timestamp before epoch | `{"timestamp":{"seconds":"-1","nanos":500000000}}` | `{"$telo":"google.protobuf.Timestamp","value":"1969-12-31T23:59:59.500Z"}` |
| timestamp min | `{"timestamp":{"seconds":"-62135596800","nanos":0}}` | `{"$telo":"google.protobuf.Timestamp","value":"0001-01-01T00:00:00.000Z"}` |
| timestamp max | `{"timestamp":{"seconds":"253402300799","nanos":999000000}}` | `{"$telo":"google.protobuf.Timestamp","value":"9999-12-31T23:59:59.999Z"}` |
| duration zero | `{"duration":{"seconds":"0","nanos":0}}` | `{"$telo":"google.protobuf.Duration","value":"0s"}` |
| duration whole seconds | `{"duration":{"seconds":"5400","nanos":0}}` | `{"$telo":"google.protobuf.Duration","value":"5400s"}` |
| duration negative fraction | `{"duration":{"seconds":"-1","nanos":-500000000}}` | `{"$telo":"google.protobuf.Duration","value":"-1.5s"}` |
| duration one nanosecond | `{"duration":{"seconds":"0","nanos":1}}` | `{"$telo":"google.protobuf.Duration","value":"0.000000001s"}` |
| duration max | `{"duration":{"seconds":"315576000000","nanos":999999999}}` | `{"$telo":"google.protobuf.Duration","value":"315576000000.999999999s"}` |
| duration min | `{"duration":{"seconds":"-315576000000","nanos":-999999999}}` | `{"$telo":"google.protobuf.Duration","value":"-315576000000.999999999s"}` |
| list empty | `{"list":[]}` | `[]` |
| list mixed | `{"list":[{"int":"1"},{"string":"a"},{"null":null},{"list":[{"bool":false}]}]}` | `[{"$telo":"int","value":"1"},"a",null,[false]]` |
| map empty | `{"map":[]}` | `{}` |
| map string keys in code unit order | `{"map":[[{"string":"b"},{"double":1}],[{"string":"ｚ"},{"double":2}],[{"string":"a"},{"double":3}],[{"string":"😀"},{"double":4}],[{"string":"B"},{"double":5}],[{"string":"ä"},{"double":6}]]}` | `{"B":5,"a":3,"b":1,"ä":6,"😀":4,"ｚ":2}` |
| map key naming the prototype | `{"map":[[{"string":"__proto__"},{"string":"own key"}]]}` | `{"__proto__":"own key"}` |
| map with the tag key | `{"map":[[{"string":"a"},{"int":"1"}],[{"string":"$telo"},{"string":"x"}]]}` | `{"$telo":"map","value":[["$telo","x"],["a",{"$telo":"int","value":"1"}]]}` |
| map int keys | `{"map":[[{"int":"10"},{"string":"ten"}],[{"int":"2"},{"string":"two"}],[{"int":"-1"},{"string":"minus one"}]]}` | `{"$telo":"map","value":[[{"$telo":"int","value":"-1"},"minus one"],[{"$telo":"int","value":"10"},"ten"],[{"$telo":"int","value":"2"},"two"]]}` |
| map mixed key types | `{"map":[[{"uint":"3"},{"string":"y"}],[{"int":"2"},{"string":"x"}],[{"bool":true},{"null":null}],[{"string":"a"},{"double":1.5}]]}` | `{"$telo":"map","value":[["a",1.5],[true,null],[{"$telo":"int","value":"2"},"x"],[{"$telo":"uint","value":"3"},"y"]]}` |
| nested | `{"map":[[{"string":"meta"},{"map":[[{"string":"$telo"},{"string":"not a tag"}]]}],[{"string":"events"},{"list":[{"map":[[{"string":"size"},{"int":"3"}],[{"string":"at"},{"timestamp":{"seconds":"1768469400","nanos":250000000}}]]}]}]]}` | `{"events":[{"at":{"$telo":"google.protobuf.Timestamp","value":"2026-01-15T09:30:00.250Z"},"size":{"$telo":"int","value":"3"}}],"meta":{"$telo":"map","value":[["$telo","not a tag"]]}}` |

Frames a runtime refuses to read:

| Name | Frame | Path |
| --- | --- | --- |
| not JSON | `{` | `""` |
| unknown tag | `{"$telo":"float","value":"1"}` | `"/$telo"` |
| tag not a string | `{"$telo":1,"value":"1"}` | `""` |
| tag without value | `{"$telo":"int"}` | `""` |
| tag with an extra key | `{"$telo":"int","value":"1","x":1}` | `""` |
| int payload not text | `{"$telo":"int","value":1}` | `"/value"` |
| int leading zero | `{"$telo":"int","value":"01"}` | `"/value"` |
| int negative zero | `{"$telo":"int","value":"-0"}` | `"/value"` |
| int overflow | `{"$telo":"int","value":"9223372036854775808"}` | `"/value"` |
| uint negative | `{"$telo":"uint","value":"-1"}` | `"/value"` |
| uint overflow | `{"$telo":"uint","value":"18446744073709551616"}` | `"/value"` |
| double finite | `{"$telo":"double","value":"1.5"}` | `"/value"` |
| bytes padded | `{"$telo":"bytes","value":"-_8A="}` | `"/value"` |
| bytes standard alphabet | `{"$telo":"bytes","value":"+/8A"}` | `"/value"` |
| bytes nonzero trailing bits | `{"$telo":"bytes","value":"AB"}` | `"/value"` |
| timestamp with offset | `{"$telo":"google.protobuf.Timestamp","value":"2026-01-15T09:30:00.000+02:00"}` | `"/value"` |
| timestamp without milliseconds | `{"$telo":"google.protobuf.Timestamp","value":"2026-01-15T07:30:00Z"}` | `"/value"` |
| timestamp with nanoseconds | `{"$telo":"google.protobuf.Timestamp","value":"2026-01-15T07:30:00.000000001Z"}` | `"/value"` |
| timestamp year zero | `{"$telo":"google.protobuf.Timestamp","value":"0000-12-31T23:59:59.000Z"}` | `"/value"` |
| duration units | `{"$telo":"google.protobuf.Duration","value":"1h30m"}` | `"/value"` |
| duration trailing zero | `{"$telo":"google.protobuf.Duration","value":"1.500s"}` | `"/value"` |
| duration out of range | `{"$telo":"google.protobuf.Duration","value":"315576000001s"}` | `"/value"` |
| map payload not a list | `{"$telo":"map","value":{}}` | `"/value"` |
| map entry not a pair | `{"$telo":"map","value":[[1]]}` | `"/value/0"` |
| map key a double | `{"$telo":"map","value":[[1.5,"x"]]}` | `"/value/0/0"` |
| map key repeated | `{"$telo":"map","value":[[true,1],[true,2]]}` | `"/value/1/0"` |
| map int and uint keys of one number | `{"$telo":"map","value":[[{"$telo":"int","value":"2"},1],[{"$telo":"uint","value":"2"},2]]}` | `"/value/1/0"` |
| map tagged with plain string keys | `{"$telo":"map","value":[["a",1]]}` | `"/value"` |
| nested payload | `[{"a":{"$telo":"uint","value":"x"}}]` | `"/0/a/value"` |
| unpaired surrogate | `"\ud800"` | `""` |
| unpaired surrogate in a key | `{"\ud800":1}` | `"/�"` |
| repeated member | `{"a":1,"b":2,"a":3}` | `"/a"` |
| repeated tag member | `[{"$telo":"int","$telo":"uint","value":"1"}]` | `"/0/$telo"` |
| number beyond a double | `{"a":1e400}` | `"/a"` |

Frames a runtime reads but does not write — a store's rewriting is legible, and
the value it yields is written back in one form only:

| Name | Frame | Value | Canonical |
| --- | --- | --- | --- |
| tag after value | `{"value":"1","$telo":"int"}` | `{"int":"1"}` | `{"$telo":"int","value":"1"}` |
| members out of order, with whitespace | `{ "b" : 1, "a" : 2 }` | `{"map":[[{"string":"b"},{"double":1}],[{"string":"a"},{"double":2}]]}` | `{"a":2,"b":1}` |
| number in another form | `0.0000001` | `{"double":1e-7}` | `1e-7` |
| number written out in full | `1000000000000000000000` | `{"double":1e+21}` | `1e+21` |

## 7. Conformance requirements

Every backend, whatever its vocabulary:

1. **Admit before executing.** A start that executes before it is durably
   recorded is unrecoverable if the process dies in between; recording first is
   what lets recovery find a run with no progress and replay it. This is a
   conformance requirement rather than a contract method, because there is no
   shared contract to put it on.
2. **Dispatch through your own chokepoint.** Wherever a step executes, the
   executing side MUST dispatch through that runtime's invocation chokepoint, so
   the invocation contract, tracing, zones and observed state hold identically. A
   backend may move *where* a step executes; it MUST NOT move it outside the
   runtime's dispatch.
3. **A body starts outside every enclosing zone.** A run outlives whatever
   triggered it, so no enclosing zone's lifetime may reach its body. A backend
   that dispatches its body detached gets this from the detach primitive; one
   re-entered from an inbound trigger gets it from the inbound obligation. The
   workflow kind then layers its own zone and the run handle onto that root.
4. **Declare `replayed`.** A backend's workflow kind MUST carry
   `x-telo-provides-zone` with the `replayed` attribute on the slot holding the
   body, and MUST extend the marker abstract the parking kinds require. One
   without the other yields either parking kinds no zone satisfies, or a durable
   zone the static checks never look inside.
5. **Locality is decided by zones.** A step whose dispatch sits inside any open
   zone *other than the durable zone itself* MUST execute locally. A zone is
   ambient process state (an open transaction, a held lease) and a remote
   executor would have none of it — which the payload rule already says must fail
   loudly rather than silently run unzoned. One rule, covering every case a
   hand-written exception list would try to enumerate.
6. **A detached dispatch inside a replayed zone is forbidden.** Journal-on-
   completion would record the *dispatch* as done while the work runs on, so a
   resume skips it and a crash loses it — durability's exact inverse. The
   replacement is a nested durable run started without awaiting, whose run id is
   itself a journalable value.
7. **A suspension is a signal, not an error, and it MUST NOT be absorbed.** It
   unwinds to the workflow that owns the run, so a `try:` step, a composer's
   `catches:` and a retry policy MUST all let it pass — and a runtime's own
   dispatch chokepoint MUST NOT wrap it, since every hop between the parking kind
   and the workflow goes through one.

   **Naming the known absorbers is not a defence.** The signal passes through
   every controller in between, including third-party ones with a `catch (e)` in
   them; a swallowed suspension converts a park into a completed step and
   duplicates every effect after it, and a pure-conduit kernel cannot see that
   happen. So it MUST be **latched** when raised, and a workflow kind MUST treat
   *an invocation that returned normally while a suspension is latched* as
   `ERR_DURABLE_SUSPENSION_SWALLOWED`, **before** settling the run. Detection is
   O(1) and needs no cooperation from the absorber.
8. **Parking inside a concurrent region parks the BRANCH.** A fan-out settles
   every branch — resolved, rejected, or parked — and propagates the suspension
   only once all of them have. Unwinding on the first park tears its siblings
   down mid-step, and because a step is journaled on completion they have no
   entry: every one re-runs whole on resume, making parallel fan-out routinely
   at-least-once. The semantics need no new machinery, because a branch's step
   paths are already index-qualified and each branch is therefore an
   independently resumable subtree.
9. **A suspending retry MUST journal its attempt state.** A backoff long enough
   to park records which attempt it was on and when the next is due; without it a
   run that parks mid-retry and resumes elsewhere restarts the policy from zero
   and a bounded budget becomes unbounded. A backoff short enough to sleep in
   process still journals only the outcome.

## 8. Collapse, and exactly-once

### 8.1 The rule

> A region collapses to one entry when **re-running it is safe** — because its
> effects are discarded together, or because re-running is a no-op.

Collapse is derived from a declared **zone attribute** (`kernel/specs/execution-zones.md`
§4.1.1), never from a field at a call site:

- **`idempotent`** — collapse, full stop. There is nothing for the journal to be
  inside, and re-running is a no-op either way.
- **`atomic`** — collapse **unless** the run handle attests via `writesInside`
  that its own entries land inside that zone's atomicity.

Everything is journaled by default; collapse is opt-in and visible, because a
region is wrapped by a kind that declares the property with a written reason.
Forgetting to journal an effectful step re-executes it on replay, which is the
failure nobody notices, so the opposite polarity would put the burden on the
cheap case.

**Collapse suppresses per-step entries, not the journal.** A direct `decide` — a
resource inside the region pinning an impure evaluation — still records, which is
what lets such a resource work inside a collapsed region rather than be a
prescription with nowhere to write.

### 8.2 Why `atomic` is conditional

A collapsed atomic zone is **at-least-once**: the whole zone re-runs on resume,
because a crash between COMMIT and the journal write leaves work done and
unrecorded. That is unavoidable *only while the journal is somewhere else*. When
the journal writes into the very transaction whose effects it records, COMMIT is
atomic over both and the window closes: either the write and its entry both land
or neither does.

So the conditional is not an override of the attribute; it is the attribute read
correctly. `atomic` says *effects inside are discarded together*, and collapse
follows only when the journal's own writes are **not** among them. When they are,
per-step journaling is consistent by construction and strictly better: finer
replay granularity, and no re-running a committed transaction.

The outer step — the one whose target *is* the atomic region — records after
COMMIT, so its own window stays open; it is harmless. A crash there replays the
step, which re-invokes the region; every inner step returns its recorded result
instead of executing, the transaction commits empty, and the outer entry is
written. No duplicate effect, at the cost of one empty transaction.

**What stays at-least-once, stated precisely:** a non-transactional effect inside
a transactional zone. An HTTP call in a transaction body is not rolled back while
its journal entry is, so replay repeats it. Exactly-once is a property of
*effects in the same database as the journal*, not of durable execution in
general.

### 8.3 It MUST be reported

Which regime a deployment got turns on whether the journal's connection *is* the
transaction's connection at runtime — invisible in the manifest, and silently
degrading if someone repoints it. A runtime MUST therefore make the resolution
observable: a structured record per atomic region at the moment collapse is
resolved, and a per-run count of collapsed regions. A durability feature whose
guarantee is decided by an invisible runtime coincidence has to say which way it
resolved.

The record is named **`durable.zone.mode`** and carries the run, the providing
kind, the attribute that decided it, the resolved `mode` — `collapsed` or
`perStep` — and, for `perStep`, the `attestation` that produced it. **Both
outcomes are reported, at the same level**, and that is deliberate twice over:
`perStep` is the exactly-once regime and is reached by a runtime attestation, so
the affirmative answer is as much wanted as the negative; and collapse is the
correct, expected resolution under a journal on separate storage, so raising its
level would put a warning on every development run. One field to filter on, not
the presence or absence of a line.

One record per REGION, not per suppressed step: the question is how many regions
of this run re-run whole, and a hot loop inside one transaction is one region.

## 9. Error codes

| Code | Raised when |
| --- | --- |
| `ERR_DURABLE_UNJOURNALABLE_VALUE` | a step result or decision cannot be serialized, at the step path that produced it |
| `ERR_JOURNAL_ENTRY_MISMATCH` | replay reaches a different target than the entry at that key records |
| `ERR_DURABLE_MANIFEST_CHANGED` | a resume would replay against changed code (backend-specific; see the backend's own docs) |
| `ERR_DURABLE_NO_RUN` | a kind requiring a durable run was dispatched with no handle ambient |
| `ERR_DURABLE_SUSPENDED` | not an error — the suspension SIGNAL, carried on an `Error` so it unwinds. It MUST reach the workflow that owns the run |
| `ERR_DURABLE_SUSPENSION_SWALLOWED` | a body returned normally while a suspension was latched (§7) |
| `ERR_DURABLE_SUSPEND_FORBIDDEN` | a park was attempted inside a zone declaring `noSuspend`, quoting that zone's own reason |
| `ERR_DURABLE_TARGET_UNENCODABLE` | a step target could not be written down completely enough to cross a process boundary (§5.3) |
| `ERR_DURABLE_TARGET_UNDECODABLE` | a step target arrived malformed, or in an encoding version this runtime does not read (§5.3) |
| `ERR_DURABLE_ENTRY_UNDECODABLE` | a journal entry records its value under a codec version this runtime does not read (§5.2) |
| `ERR_TYPED_FRAME_UNENCODABLE` | a value outside the CEL value domain was given to a typed frame writer, at its path inside the value (§6.1) |
| `ERR_TYPED_FRAME_UNDECODABLE` | a typed frame is malformed, carries an unknown tag or a non-canonical payload, at its path inside the frame (§6.2) |

## 10. What v1.1 deliberately leaves out

- **Any shared start / schedule / cancel / status surface.** There is none, by
  design: those are where engines genuinely differ, and flattening them costs
  fidelity in both directions.
