# HTTP binary bodies and transport reliability

## Problem

A Google Drive v3 connector is 59-of-60 kinds pure manifest today. The one blocked kind is
`UploadFile`, and every reason it is blocked is a generic transport gap, not a Drive quirk.

`Http.Request`'s `inputs.body` is `oneOf [string, object]`, and the controller stringifies any
object — so a `Uint8Array` from `Octet.Decoder`, `S3.Get` or an embed is sent as
`{"0":137,…}`, silently. There is no way to stream a request body, so a multi-gigabyte upload
has nowhere to go. Retry is documented network-errors-only, while Google mandates exponential
backoff on 429/5xx and per-user quotas are hit routinely. Success is one boolean over all
4xx/5xx, so a request cannot say which statuses it actually expects — a resumable chunk PUT
should accept 308 and treat every other 3xx as a failure, and neither half is expressible. A
buffered binary
response is read as a raw string and corrupts. And `mode` is a config field, so a kind wrapping
`Http.Request` cannot vary buffering per call.

All of it applies to every HTTP kind anyone writes, so it belongs in the transport, not in a
Drive module.

## Solution

Seven packages change; the kernel does not.

**`modules/http-client`** carries most of it. `inputs.body` becomes an `anyOf` over string,
object, `Telo.Bytes` and `Telo.Stream of Telo.Bytes`, with a sibling `bodyEncoding: utf8 |
base64` governing the string branch — the slot [modules/fs/telo.yaml](../modules/fs/telo.yaml)
already ships for `Fs.FileWrite.content`, extended by the stream branch. A stream body is sent
chunked and is **single-shot** (below). `inputs.responseType: json | text | bytes | stream`
replaces the config-level `mode`, which stays as a deprecated alias.

`Http.Request` also gains the **invocation contract it has never had**: an `inputType:` declaring
the request-parameter shape it already documents, typed and `additionalProperties: false` but
**declaring nothing required**. Without a contract the step-input validator skips every
`Http.Request` step outright, so none of the checking below reaches this kind at all; and nothing
can be required, because the contract is validated against the caller's value before the
controller layers the instance's own `inputs:` over it, and baking `url` on the instance is the
dominant existing shape. What that buys is type, unknown-key and type-argument checking — not a
missing-`url` check.

Response classification becomes one concept. `success:` — a list of statuses or a CEL boolean
over `{status, headers, body}` — defines what failure *is*; the existing `throwOnHttpError`
keeps deciding whether failure throws. `retryOn:` takes the same dual shape, and both carry
`x-telo-eval: runtime` plus an `x-telo-context` declaring that scope with `body` nullable — the
kind's schema has no eval region today, so a predicate on a top-level request would otherwise be
rejected as non-eval and the null guard would never be demanded. `retry:` carries `{attempts,
honorRetryAfter, initialDelay, factor, maxDelay, jitter}`; `retries:` stays as a deprecated alias
for `attempts`. `Http.Client` carries defaults for all of them; `Http.Request` overrides.
`success:` is evaluated first and a successful response is never retried, so `retryOn:` is
consulted only for responses already classified as failures — a status named by both is a
success. Classification runs *before* redirect-following, so a status named by `success:` is
returned rather than followed.

**`modules/multipart`** is new, and is what makes Drive's single-call create-with-content
work: `Multipart.Encoder` takes an ordered list of parts, each with its own content type and a
string or byte-stream body, and returns `{output, contentType}` — the generated boundary has to
travel with the bytes, so the content type is an output rather than something the caller writes.
`Multipart.Decoder` is the inbound half for `http-server`. `multipart/form-data` and
`multipart/related` are the same framing under a different subtype. It is a module rather than a
`bodyEncoding` branch because the framing is a wire format like any other codec, useful to
anything that sends or receives one, and independent of HTTP.

**`modules/stream`** gains `Stream.Chunk`: a byte stream in, a stream of
`{bytes, offset, length, index, last}` records out. Carrying the offset in the record is what
makes a `Content-Range` header pure CEL.

**`modules/run`**: `Run.Iteration.collection` accepts a stream as well as an array, pulled
lazily under the existing `concurrency`. Nothing iterates a stream today, and `Stream.Collect`
buffers, which defeats chunking. The kind also gains a declared `inputType:`, without which its
`item` binding cannot be typed at all (below). `Run.Projection` carries the identical
`collection` / `item` / `items` shape and stays array-only: it maps a collection to a list, so a
lazily consumed source has no result to build.

**`sdk/value-types`** gains one optional key: a type parameter may declare itself the **element**
— what iterating a value of that type yields. `Telo.Stream`'s `of` is the first and only entry to
carry it. Both runtime readers tolerate the key; neither branches on a type name.

**`analyzer`** — three changes. Two are in the step-context resolver, both driven by that
vocabulary rather than by any type: `x-telo-context-element-from` resolves an element as an
array's `items`, else the argument bound to whichever parameter the resolved value type declares
as its element, else nothing; and a new `x-telo-context-collection-from` sits beside it, typing
the collection binding and withholding it when the resolved type is `live` — the flag the
vocabulary already carries, and exactly the property that makes a value unsafe to re-expose. No
value-type name appears in analyzer code, so a future parameterized or live type is covered by
its entry alone. Element resolution additionally has to read the declared contract: it resolves
today only through a legacy `inputs:` property map on the resource, which `Run.Iteration` does
not have, so `item` is untyped there already — before any stream is involved. It must resolve
through `inputType` in every form the rest of the contract machinery accepts (bare name, `!ref`,
inline, raw schema). The third change is in `checkSchemaCompatibility`, which today returns
silently the moment either side is a union: it must distribute over branches on **both** sides,
reporting a mismatch only when no source-branch/target-branch pair is compatible. That keeps its
existing posture — flag definite conflicts only — while a four-branch `body` would otherwise
switch the type-argument check off by construction.

**`templating`** adds `slice(dyn, int, int)` over string/bytes/list, plus `bytesFromBase64` and
`bytesToBase64`.

## Decisions

- **The body slot copies `Fs.FileWrite.content` rather than inventing a spelling.** `anyOf`, not
  `oneOf`: a reader that does not know `x-telo-type` sees the byte branch as an empty schema
  matching everything, so under `oneOf` a plain string would match both branches and fail.
- **Written as `x-telo-type: Telo.Bytes` / `{name: Telo.Stream, of: Telo.Bytes}`,** the current
  vocabulary — the legacy `x-telo-binary` / `x-telo-stream` spellings still visible in shipped
  manifests are rewritten at load by `normalize-value-types`. The `of` argument is what lets a
  step's `inputs:` check a byte stream against this slot.
- **The static checking this rests on is built, not assumed.** Four things stand between the
  annotation and an actual diagnostic, and each is scoped in as work rather than asserted: the
  kind declares no `inputType`, so step-input validation skips it entirely; the type-argument
  comparator goes silent on any union, which a four-branch `body` is; the classification fields
  sit in a schema with no eval region, so a CEL predicate there is rejected before it can be
  type-checked; and element resolution reads only a legacy `inputs:` property map, so `item` is
  untyped in `Run.Iteration` today. Rejected: keeping the slot and dropping the claims, enforcing
  byte-vs-stream at dispatch only — a manifest that type-checks and then fails at run time is the
  outcome the analyzer exists to prevent.
- **The contract declares no required inputs, and the instance's `inputs:` stays where it is.**
  Contract validation runs against the caller's value, before the controller layers instance
  values over it, so a kind cannot both require `url` and let an instance bake it — a request
  with a baked URL invoked with only a body would be rejected statically and at dispatch.
  Declaring nothing required keeps every check the rest of this plan needs and gives up only the
  missing-input one. Rejected: dropping the `inputs:` config field so an instance declares its own
  `inputType` with `default:` keywords, which is the mechanism the kernel already fills — it
  turns `inputs: {url: …}` into a nested JSON Schema for the commonest case in the module, and
  there is no migration path to rewrite existing manifests.
- **Element typing and materializability are vocabulary-driven, not stream-specific.** The value
  types are data (`sdk/value-types/*.json`) precisely so that consumers derive behaviour from
  declared fields, and the analyzer is under the same no-hardcoded-knowledge rule as it is for
  resource kinds. So "what does iterating this yield" becomes a declared element parameter on the
  entry, and "may this be re-bound" becomes the `live` flag already there. Rejected: teaching the
  step-context resolver about `Telo.Stream.of` directly — it would work today and would have to
  be reopened for every parameterized value type added after it.
- **`bodyEncoding` and a byte branch both.** The base64 string path is the escape hatch when
  bytes come from CEL or a text-shaped source; the byte branch avoids a 1.33× round-trip when
  they come from a resource that already produces them.
- **A stream body is single-shot, stated and enforced.** Any re-send raises a named
  `ERR_HTTP_BODY_NOT_REPLAYABLE` rather than silently sending zero bytes, and the two decidable
  cases are static diagnostics: a stream body with `retry.attempts > 0` (a sibling literal), and
  a stream body on a request whose `client:` declares a `credential:` — the credential's
  401-refresh-and-retry-once fires even at `attempts: 0`, and the ref is in the call graph.
  Redirects are not a third case: the controller follows only 301/302 and already switches to
  GET and drops the body. Rejected: accepting a producer reference that yields a fresh stream per
  attempt — it puts a call-graph edge inside a per-invocation `inputs` field, and the retryable
  large-upload case is already served by chunking, where each chunk is a replayable `Telo.Bytes`.
- **Classification precedes redirect-following.** The alternative — a status-aware
  `followRedirects` — makes two fields answer one question and lets them disagree.
- **`success:`/`retryOn:` accept a status list or a CEL predicate.** Lists cover the common case,
  stay visually editable and are statically checkable; the predicate exists for
  `403 rateLimitExceeded`, whose meaning is in the body. The predicate's `body` is null when the
  response is streamed, so the analyzer's existing `CEL_NULLABLE_ACCESS` forces a guard — that is
  what keeps one field from meaning two things.
- **The backoff curve is declared inline in `http-client`, not extracted.** Sharing it with
  `Run`'s step `retry:` was the whole case for a separate module, and that field is not a
  consumer: it is declared on four `Run` kinds, plumbed on one of the SDK step leaf's four
  dispatch branches (the Phase-5-injected `!ref` path, which is the dominant one, drops it), and
  honoured by nothing in the kernel — `totalRetryDelay` is read by a diagnostic and written by
  no one. Extracting a shared shape into a policy nothing enforces would leave that field looking
  implemented, which is worse than the duplication. Extraction is revisited when step retry
  becomes real; fixing it is its own change, not a rider on this one. `honorRetryAfter` and
  `retryOn` stay on the request either way, because only the transport knows what a 429 is.
- **`items` is bound on the runtime value, and the static rule is only an early warning.**
  `Run.Iteration`'s step body binds the whole collection as `items`, which cannot exist under a
  lazily pulled stream — the only candidate is the cursor the loop is pulling from, and handing it
  to a step's `inputs:` is a legal pass-through that would drain the loop's own source and end it
  early, silently. So the controller binds `items` **iff the expanded collection is materialized**
  and never binds a live cursor on any path; a reference that survives analysis then fails loudly
  at evaluation as an unknown identifier. The static half only decides whether the analyzer flags
  that reference up front: it does when the collection resolves as `live`
  (`CEL_UNKNOWN_IDENTIFIER`, naming the reason), and it stays quiet when the type does not resolve
  — a comprehension, a `filter(...)`. Deciding the binding statically was rejected: non-resolution
  is the common case, and the controller's non-array guard, which would have been the backstop,
  is exactly what admitting streams removes. Making non-resolution a hard diagnostic was also
  rejected — computed collections work today and would break for an unrelated reason. The
  asymmetry with `element-from`, which always binds, is deliberate: `item` holding a live stream
  is fine when iterating a stream of streams, since each item is a distinct handle rather than the
  loop's cursor.
- **No `Stream.ForEach`.** A dedicated stream-consumer kind would sidestep `items` entirely, but
  a step body in another module is blocked on [step-grammar-in-sdk](step-grammar-in-sdk.md).
- **No circuit breaker.** Its state is shared across calls, so it cannot be a field — it needs a
  resource over a store, modelled on `RateLimit.Guard`, and a `breaker:` ref on `Http.Client`.
  Coherent, and deliberately out of scope; it blocks nothing here.
- **`mode` and `retries` are deprecated in place, not renamed.** A migration entry matches a
  literal document kind, and a consumer writes `kind: <TheirAlias>.Request` — so no core entry
  can name a standard-library kind, and the module migration surface does not exist yet. The same
  is why `http-server`'s inbound `mode` is left alone rather than aligned to `responseType`.
- **`Multipart.Encoder` does not extend `Codec.Encoder`, and the module is not `-codec`.** That
  abstract's `inputType` is a single `input` stream; a multipart encoder takes N parts with
  per-part headers, so extending it would claim substitutability at every `Codec.Encoder` slot and
  be false. The suffix follows: it is not a marker for codec implementations — `gzip` extends both
  abstracts and is plain `Gzip` — but a repair for format names that do not stand alone (`octet`,
  `ndjson`, `sse`, `plain-text`). `multipart` does, and since the suffix lands in `metadata.name`
  it would put `MultipartCodec.Encoder` in every consumer's `kind:` while being the one deliberate
  non-member of that family.
- **`base64Decode` keeps its string→string, UTF-8 semantics.** It silently corrupts non-text, but
  changing it would silently change what existing manifests mean; `bytesFromBase64` is the
  correct alternative and the old one is documented as text-only.

Delivery: `http-client`, `stream`, `run` and `multipart` each need a release fragment
(`telo release add --module … --kind Added`); `sdk`, `analyzer`, `kernel` and `templating` need
changesets, and the Rust value-type reader must accept the new optional key. Module docs under
`modules/<name>/docs/` and the `apps/authoring-agent` system prompt are updated in the same
change.

## Complete example after the change

A Drive resumable upload — the case that needed every piece:

```yaml
- name: chunks
  invoke: !ref ChunkFile          # Stream.Chunk, size: 786432
  inputs: { input: !cel "steps.read.result.output" }

- name: put
  invoke: !ref UploadChunks       # Run.Iteration over the chunk stream
  inputs:
    collection: !cel "steps.chunks.result.output"
    total: !cel "steps.stat.result.size"
```

`collection` resolves to a `Telo.Stream` whose `of` is the chunk record, so `item.offset` and
`item.length` stay typed inside the body while `items` is never bound. Each step invokes an
`Http.Request`
declaring `success: [200, 201, 308]`, `throwOnHttpError: true` and
`retryOn: [429, 500, 502, 503, 504]`, sending `body: !cel "item.bytes"` under a `Content-Range`
assembled from `item.offset` and `item.length`. A genuine 4xx still raises; 308 returns normally
and is never followed; a 429 backs off and retries with the same chunk — replayable, because a
chunk is bytes rather than a stream.
