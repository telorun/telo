# A stream stage that can fail

## Problem

A streaming protocol reports failure **in band**. Once the response headers are sent
the HTTP status can no longer say anything, so every wire format carries its own
failure record: an `error` event in SSE, an exception frame in Bedrock's binary event
stream, an error record in an NDJSON feed, a page that comes back carrying `error`
mid-pagination.

A manifest cannot act on one. `Stream.Map`'s `value` and `Stream.FlatMap`'s `values`
are CEL expression slots — one produces a value, the other a list — and neither has a
spelling for *this element is not data; end the stream with this error*. The two
expressible alternatives are both wrong:

- **emit an error-shaped value**, which the `Ai.StreamPart` contract forbids outright.
  An error that travels as data has to be remembered by every drainer, and one that
  forgets truncates silently — the failure mode the suspension latch and the effect
  chain were both designed out of existence;
- **make CEL fail**, which surfaces the transform's own error code and a message about
  an expression, not the provider's own words, so nothing downstream can name it.

The ability to end a stream abnormally is **not** what is missing: both transforms
already declare `ERR_INVALID_VALUE` as raised per element, consumers already handle a
rejected iteration, and abandonment already propagates from a stage to its source. What
is missing is a way for a manifest to say **when** an element means failure and **what
error** to raise.

Concretely, this is what stops a provider being written as a manifest at all. A
manifest-authored `Ai.ModelStream` cannot honour the contract's central rule — *a
stream fails by rejecting, and the failure is catchable by name* — which the
TypeScript providers honour today.

## Solution

**`Stream.Guard`**, in `stream`: a stage that passes every element through untouched
and rejects the iteration when a declared predicate holds.

Four fields. `when` is the predicate, evaluated per element against the same context
the transforms already offer — the element, its position, and the call's inputs, under
the identical names, so a predicate reads like a `Stream.Map` expression and no author
learns a second vocabulary. `code` is the error code raised. `message` is its message.
`data` is optional structured detail carried on the error, which is how a status, a
provider's own error object or a frame id reaches a `catch`.

The predicate is evaluated **before** the element is passed on, so the element that
means failure is never delivered. Elements already emitted have already reached the
consumer, which is the existing and correct behaviour: a partial answer plus a terminal
error is exactly what an SSE forwarder needs in order to flush what it has and encode
one error frame.

It **only** guards. It does not transform (`Stream.Map`), and it does not drop
(`Stream.FlatMap` returning an empty list) — a stage that could also drop would make
"this element is a failure" and "this element is uninteresting" two readings of one
slot.

### The raised code has to be visible to `telo check`

`code` is chosen at the instance, and catchability by name is the whole point: a
consumer writes `catches:` against a code, and a route mounting a handler must cover
its throws union or end with a catch-all. A union that does not contain the guard's
code makes the coverage check reject a correct manifest and accept a broken one.

Today a kind's declared `throws.codes` is authoritative — the union is gathered from
those declarations plus `inherit` / `passthrough` dataflow, with no check that the body
produces what it declares. So a manifest-authored provider declaring
`ERR_OPENAI_REQUEST_FAILED` on its own definition and raising that same string from a
guard inside its body already works. What it does not do is *notice a typo*: a guard
raising a string the enclosing definition never declared produces an error no consumer
covers, silently.

So the guard's code is **derived, not asserted**, through one new generic annotation:
**`x-telo-throws-from`**, a JSON Pointer on a kind naming the slot that holds the code
it raises. The throws resolver reads the literal at that pointer and contributes it to
the union like any declared code. Nothing in the analyzer learns what a guard is — the
annotation is the whole interface, and any later kind that raises a caller-chosen error
opts in by declaring one, exactly as `x-telo-value-schema-from` and
`x-telo-schema-projection-from` name a slot to read a fact from.

A `code` written as an expression is not statically knowable. That is
**`THROWS_CODE_DYNAMIC`**, a warning rather than an error: the same posture the ref
slot's case-map selector takes, since the manifest is not wrong, it is only unanalyzable
— and the coverage check must then fall back to whatever the kind declares rather than
inventing a code.

## Decisions

- **A kind, not a `fail:` field on the three transforms.** A field would be implemented
  three times, kept in agreement by convention, and implemented a fourth time by the
  next transform. A stage states the rule once and composes with every transform,
  including ones not yet written.
- **Named `Guard`, after `RateLimit.Guard`** — a stage that inspects and refuses. The
  alternatives all mislead: `Fail` reads as unconditional, `Assert` belongs to the test
  vocabulary and would suggest a suite, `Reject` collides with promise vocabulary.
- **The code is derived from the manifest, not from a declared union on the guard.**
  The alternative — one declared code on `Stream.Guard` with the author's own string in
  `data`, the `RESOURCE_RULE_VIOLATED` shape — is what that precedent is *for*: a
  diagnostic nothing branches on. Here everything branches on it. A consumer's
  `catches:` names a code, so burying it one level down converts a nameable error into
  an unnameable one and defeats the only reason this primitive exists.
- **No `unless:`.** A negated predicate is `!`, and two spellings of one condition is
  how a manifest ends up with both.
- **Not a decoder concern.** A `Codec.Decoder` meeting bytes it cannot frame is a
  different failure — malformed input, not a well-formed record that says failure — and
  belongs to the decoder that met it. This plan does not change `Sse.Decoder`.
- **Out of scope, deliberately**: a `responseCodec` reference on `Http.Request`, so a
  streamed call returns decoded frames rather than raw bytes. It is a good idea and a
  separate one — it removes a stage from the chain, and it removes no blocker.

## Sequence

1. **`x-telo-throws-from` and its resolution.** Standalone: the annotation, its single
   reader, the throws-union contribution, and `THROWS_CODE_DYNAMIC`. Verifiable against
   a fixture kind before any stream work exists.
2. **`Stream.Guard`.** The kind, its controller, and the module docs.
3. **The consumer that motivated it** — a manifest-authored streaming provider — is a
   separate change and stays behind its own gates.

## Verify

The guard's own behaviour, all offline against hand-written elements rather than a live
endpoint, because the interesting cases are ones a well-behaved producer never emits:

- a predicate that never holds passes every element through **unchanged and in order**,
  and the stream's end is unaffected;
- a predicate that holds rejects the iteration with the declared code, message and
  `data`, and the tripping element is **not** delivered;
- elements emitted before the trip **have** reached the consumer — asserted by
  collecting them, since "already emitted" is the property an SSE forwarder depends on;
- a consumer that stops draining still reaches the transport with a guard in the chain,
  so early exit propagates through the new stage as through every other.

The static half:

- the raised code appears in the enclosing sequence's throws union at `telo check`, and
  a `catches:` naming it type-checks — the assertion that this primitive did its job;
- a route mounting a handler that contains a guard is required to cover that code or
  end with a catch-all, which is the existing coverage rule applying to a code it could
  not previously see;
- a `code` written as an expression reports `THROWS_CODE_DYNAMIC`, and the coverage
  check degrades to the declared union rather than inventing an entry.

## Release

`stream` takes an `Added` fragment. `x-telo-throws-from` widens the manifest surface, so
every module whose own manifest writes it declares a `requires: telo:` floor at the
release carrying it — verified by execution: strip the block, confirm the previous
published CLI rejects the manifest, restore it, confirm the same CLI reports
`MODULE_REQUIRES_NEWER_RUNTIME`. A module that is not rejected does not get a floor, and
an annotation inside an open schema body is unlikely to earn one.
