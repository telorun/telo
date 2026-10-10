---
description: "Ai.Model and Ai.ModelStream: the declared model contracts every provider implements — messages and tools in, content parts and usage out, buffered or streamed. Walkthrough for adding a new provider."
sidebar_label: Ai.Model
---

# `Ai.Model` / `Ai.ModelStream` — the provider contract

> Examples below assume this module is imported with an `imports:` entry under alias `Ai`. Kind references (`Ai.Model`, `Ai.Text`, …) follow that alias — if you import the module under a different name, substitute your alias accordingly.

A provider implements one or both of two abstracts:

- **`Ai.Model`** — called for a complete answer. Used by `Ai.Text` and `Ai.Agent`.
- **`Ai.ModelStream`** — called for a stream of parts. Used by `Ai.TextStream` and `Ai.AgentStream`.

Both are `capability: Telo.Invocable` with **one declared entry point**, `invoke`. The
contract is declared, not conventional: the kernel binds `invoke` at its single
instance-production site and AJV-checks both directions at dispatch. So a consumer
validates nothing by hand, `telo check` sees the shape, and a provider written in any
language — or as a manifest — implements a declared contract rather than a TypeScript
interface.

```yaml
kind: Telo.Definition
metadata:
  name: MyModel
capability: Telo.Invocable
extends: Ai.Model
controllers:
  - pkg:telo/local/js?path=./nodejs/my.mjs&local_path=./nodejs/src/index.ts#MyModelController
schema:
  type: object
  additionalProperties: false
  required: [model]
  properties:
    model: { type: string }
```

A provider declares only its **config** schema. The call contract is inherited.

## Why two abstracts

A live value is exempt from contract validation — the exemption exists precisely to
forbid iterating a stream to inspect it. A single always-streaming abstract would
therefore take the check away from the *buffered* path too, which is the one most calls
use. Two kinds keeps that half enforced by the binding, and makes "this endpoint does
not stream" expressible rather than faked as a one-element stream.

A provider that only streams implements `Ai.ModelStream` alone; **`Ai.Buffered`** adapts
it for consumers that want a complete answer — it drives the stream, collects the parts
and folds them into one result:

```yaml
kind: Ai.Buffered
metadata: { name: folded }
model: !ref someStreamingProvider
```

It is a manifest, not a controller, which is the point of declaring the contract at all.
Prefer a provider's own buffered kind where the endpoint offers one: collecting a stream
to hand back a single answer pays a stream's latency for a buffer's result.

## Cancellation

Cancellation rides the `InvokeContext` the kernel passes as the **second argument** to
`invoke`, never a `signal` inside the input — an `AbortSignal` is not declarable data,
so a manifest-authored provider could never receive one that way.

```ts
async invoke(input: ModelInvokeInput, ctx?: InvokeContext) {
  const signal = ctx?.cancellation.signal;
}
```

## What goes in

| Field | Meaning |
| --- | --- |
| `messages` | The conversation, as `Ai.Message` turns. Required, non-empty. |
| `options` | Request options, already merged by the operation from its own and the caller's. |
| `tools` | The tools this call may ask for. Absent when the caller offers none. |
| `toolChoice` | `auto` or `none`; absent means `auto`. Legal only beside `tools`. |
| `providerState` | Opaque state a previous turn produced, replayed verbatim. |
| `responseFormat` | The shape the answer must take, when the provider enforces one. |

### `toolChoice` — a call that may not use a tool

`auto` leaves it to the model whether to ask for a tool. `none` asks for an answer
**without** requesting one, while `tools` stay declared: a conversation that already
holds tool calls and their results is only valid to most endpoints while the tools it
names are still described, so "no tools this time" cannot be said by leaving `tools`
out. An agent's concluding call (`onMaxSteps: conclude`) is this shape.

A provider maps `none` onto its endpoint's own switch. A model may still return a tool
call under `none`; what to do with it is the caller's — an agent neither runs nor
reports one.

`toolChoice` without `tools` is refused by the contract: `telo check` reports the call,
and the kernel raises `ERR_INPUT_INVALID` at dispatch.

### `providerState` — how reasoning survives a tool loop

A provider that keeps its reasoning server-side hands back an opaque token. It must go
out again unchanged on the next request or the chain is broken. `ai` never inspects it,
and an agent replays it across every turn of its loop.

Tag it with the producing model and dialect. A state whose tag does not match the model
being called must be dropped, so a transcript moved between providers — or between two
dialects of one provider — cannot replay foreign items.

## What comes back

**`Ai.Model`** returns `content` (the answer as `Ai.ContentPart`s), `text` (its text
parts concatenated), `usage`, `finishReason`, and optionally `toolCalls`,
`providerState` and `alternatives`.

`text` is carried beside `content` because the overwhelmingly common consumer wants
exactly that and should not have to fold the list.

**`Ai.ModelStream`** returns `{ output }`, a stream of `Ai.StreamPart`: `text-delta`,
`reasoning-delta`, `content-part`, `tool-call-delta`, `tool-call`, `provider-state`,
and the one terminal `finish`.

### Tool calls in a stream, and who names them

A streaming model reports each tool call whole, as a `tool-call` part carrying
`toolCall: { id, name, arguments }` once the arguments are complete. It may also report
the arguments **as they are written**, as `tool-call-delta` parts ahead of the call:

| Field | Meaning |
| --- | --- |
| `toolCallId` | The id of the call being written. Never empty. |
| `toolName` | The tool being called. |
| `delta` | The next fragment of the argument text. A call's fragments joined in order are the JSON of its arguments. |

Deltas are advisory — the whole `tool-call` still follows and is the only part a
consumer must handle — and optional: an implementation with none to give emits the call
alone.

**The implementation assigns a call's id**, because only it can put the same id on a
call's deltas and on the call. What it owes:

- Every `tool-call-delta` carries a non-empty `toolCallId` **equal to the `id` of the
  `tool-call` that completes it**, and that call's `toolName`.
- **No delta is emitted for a call until its id is known.** Fragments that arrive
  earlier are held and released once it is — at the latest immediately before the
  `tool-call`.
- When the endpoint gives no id by the end of the call, the implementation **mints a
  unique one** (`call_<uuid>`). A positional id (`call_0`) is not unique: it repeats on
  the next model call of the same run, and two calls of one transcript then share an id.

```ts
// Hold fragments until the call can be named; mint a name if the endpoint never gives one.
for await (const chunk of upstream) {
  const call = calls.get(chunk.index) ?? { id: "", name: "", args: "", held: "" };
  call.id ||= chunk.id ?? "";
  call.name ||= chunk.name ?? "";
  call.args += chunk.arguments;
  call.held += chunk.arguments;
  if (call.id && call.name && call.held) {
    yield { type: "tool-call-delta", toolCallId: call.id, toolName: call.name, delta: call.held };
    call.held = "";
  }
}
for (const call of calls.values()) {
  call.id ||= `call_${randomUUID()}`;
  if (call.held) yield { type: "tool-call-delta", toolCallId: call.id, toolName: call.name, delta: call.held };
  yield { type: "tool-call", toolCall: { id: call.id, name: call.name, arguments: JSON.parse(call.args) } };
}
```

An agent forwards `toolCallId` verbatim and rejects a delta without one as
`ERR_CONTRACT_VIOLATION`. A whole `tool-call` whose `id` is empty — a buffered model's,
or a stream that sends no deltas — is given a generated id by the agent where it is
first seen. Two tool calls of one response sharing an `id` — buffered or streamed — fail
the agent's run with `ERR_CONTRACT_VIOLATION`, since a result, an approval and a resume are
each joined to their call by it. [`Ai.Buffered`](#why-two-abstracts) folds a stream by its whole `tool-call` parts
and ignores the deltas.

## Modality lives in the parts

`Ai.ContentPart` covers `text`, `image`, `audio`, `video` and `file`, plus the
output-only `tool-call`, `reasoning`, `citation` and `refusal`. A document is a matter
of **value**, not of a separate kind.

| `type` | Must carry |
| --- | --- |
| `text`, `reasoning`, `refusal` | `text` |
| `image`, `audio`, `video`, `file` | `mediaType`, and exactly one of `data` or `uri`; optionally `name` |
| `tool-call` | `toolCall` |
| `citation` | `citation` |

For a media part:

- `data` is the bytes — raw bytes at runtime, or base64 when a manifest authored them.
- `uri` is where the bytes live when they are referenced rather than carried: an
  absolute URI (`https://…`, `s3://…`, `file:///…`), handed to the model as written.
  Never a `data:` URI — bytes in hand go in `data` — and never beside `data`.
- `mediaType` is the IANA media type (`image/png`, `application/pdf`).
- `name` is the part's file name (`report.pdf`), for a model that shows or needs one.

A part a caller sends may also carry `cacheBreakpoint` (see
[Prompt-cache breakpoints](#prompt-cache-breakpoints)). It carries nothing else: there
is no per-part provider directive.

```yaml
messages:
  - role: user
    content:
      - { type: text, text: "What does this contract say about termination?" }
      - { type: file, mediaType: application/pdf, name: contract.pdf, uri: "https://example.com/contract.pdf" }
      - { type: image, mediaType: image/png, data: !cel "steps.scan.result.data" }
```

A model returning a picture is an image part in an ordinary completion. `Ai.ImageModel`
is a different *call shape* — prompt, intent, reference images, mask — not the image
modality.

### Shape is the schema's; capability is the model's

Two different questions are answered in two different places.

**Is this a well-formed part?** `Ai.ContentPart` answers, once, and the contract of
whatever takes a message enforces it — `Ai.Text`, `Ai.TextStream`, `Ai.Agent`,
`Ai.AgentStream` and every model alike. A part written in a manifest that breaks the
shape is `CONTRACT_INPUTS_MISMATCH` under `telo check`, reported at the key at fault; a
computed one is `ERR_INPUT_INVALID` at dispatch. No operation and no provider checks a
part's shape by hand.

**Can this model carry it?** Only the provider knows. A well-formed part its endpoint
cannot take — audio on a text-and-vision API, a document by reference where only bytes
are accepted, a `uri` scheme the endpoint could never reach — is refused by the
provider as **`ERR_MODEL_CONTENT_UNSUPPORTED`**, before it sends anything, with
`data: { partType, scheme?, mediaType? }` and a message naming what the endpoint takes
instead. See the provider's
own documentation for which parts it carries.

If you implement a provider:

- Refuse, never drop. A request quietly missing part of the message is answered
  wrongly with nothing to say why.
- Translate a `uri`; never fetch it. Pass it on in the form your endpoint takes, or
  refuse it.
- Refuse while **building** the request, in `invoke` itself — for a streaming model
  too, before the stream is returned (see
  [When a streaming call fails](#when-a-streaming-call-fails)).
- Raise it with `modelContentUnsupported` from `@telorun/ai`, so the code and its
  `data` are the declared ones (see
  [Failures: one list for every model](#failures-one-list-for-every-model)).

### Prompt-cache breakpoints

`cacheBreakpoint: true` on a `text`, `image`, `audio`, `video` or `file` part means: the
request from its start through this part — the tools and system prompt before it
included — is a prefix the caller expects to send again unchanged. `false` is the same
as absent. The shape forbids the key on the parts a model produces, and
`isContentPart` agrees, so a tool result carrying a marked part is still carried as
parts.

It is a hint, and a provider owes it exactly this:

- An endpoint that caches on its own: drop the marker and send nothing for it.
- An endpoint that takes at most N breakpoints: honour the **last** N in request order
  and drop the earlier ones.
- Never raise an error for a breakpoint, and never let one change the answer.
- How long an entry lives is your kind's own setting, never the part's.

The system prompt arrives as an ordinary `system` message whose content is a string or
text parts; a marker there covers the tools and the prompt. Report what a call wrote
to a cache as `cacheWritePromptTokens` (see [Usage](#usage-two-shapes-and-who-fills-them)).

## Failures: one list for every model

`Ai.Model` and `Ai.ModelStream` declare the **same thirteen codes**, and that list is a
ceiling:

| Code | Meaning | `error.data` | Try again? |
| --- | --- | --- | --- |
| `ERR_MODEL_ACCESS_DENIED` | The credential was refused, or has no permission for the model. | `status?` | no |
| `ERR_MODEL_RATE_LIMITED` | The endpoint asked the caller to slow down. | `status?`, `retryAfterSeconds?` | yes |
| `ERR_MODEL_QUOTA_EXCEEDED` | The account's credit or plan is exhausted. | `status?` | no |
| `ERR_MODEL_UNAVAILABLE` | The provider is overloaded or failing on its side, including a failure it reported after the answer began. | `status?`, `retryAfterSeconds?` | yes |
| `ERR_MODEL_TIMEOUT` | No complete response in time; whether the request ran is unknown. | `status?` | yes |
| `ERR_MODEL_UNREACHABLE` | Nothing answered: refused connection, unresolved host name, failed handshake. | — | yes |
| `ERR_MODEL_CONTEXT_TOO_LONG` | The input exceeds the context window or the endpoint's request size limit. | `status?` | not with that input |
| `ERR_MODEL_CONTENT_REFUSED` | The endpoint rejected the request on content-policy grounds. | `status?` | no |
| `ERR_MODEL_REQUEST_REJECTED` | The endpoint refused the request as one it cannot serve, the provider refused it before sending, the request could not be built, or it failed in a way nothing else here names (`cause` holds the original). | `status?` | no |
| `ERR_MODEL_CONTENT_UNSUPPORTED` | A well-formed content part this endpoint cannot carry; raised before anything is sent. | `partType`, `scheme?`, `mediaType?` | no |
| `ERR_MODEL_TOOL_ARGUMENTS_INVALID` | The model asked for a tool with arguments that are not a JSON object. | `tool` | yes |
| `ERR_MODEL_RESPONSE_INVALID` | The endpoint reported success but the answer cannot be read: it is not the dialect's answer, a member of it has the wrong shape, or it could not be read for any other reason (`cause` holds the original). | — | yes |
| `ERR_INVALID_REFERENCE` | A resource the model depends on did not resolve to a live instance. | — | no |

`status` is an integer, present only when an HTTP response carried the failure.
`retryAfterSeconds` is a non-negative integer read from a standard `Retry-After` header
and rounded up; it is carried on a rate limit and on an unavailable endpoint, and never
from a vendor's own reset header.

If you implement a provider:

- **Restate all thirteen codes** in each kind's `throws:`, with the same `data`, not the
  subset you raise. A kind with no `throws:` is read as throwing nothing, and a
  `catches:` naming a code one provider lacks would stop two providers being
  interchangeable. A code outside the list is refused (`THROWS_NOT_SUBSTITUTABLE` under
  `telo check`, `ERR_THROWS_NOT_SUBSTITUTABLE` when the kind is loaded).
- **Raise nothing else.** No vendor code, no transport code, no uncoded error. A model's
  own refusal given as its answer is data — a `refusal` part and
  `finishReason: content-filter` — not `ERR_MODEL_CONTENT_REFUSED`, which is the
  endpoint rejecting the request.
- **Pass every error of a call through `modelFailureFromError`** — one that rejects a
  stream's iteration included. It lets what is not a model failure pass unchanged: a
  cancellation (`ERR_INVOKE_CANCELLED`, also when the transport reports a bare abort), a
  durable suspension (`ERR_DURABLE_SUSPENDED`), the kernel's contract errors
  (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_CONTRACT_UNRESOLVABLE`,
  `ERR_SCHEMA_PROJECTION_UNRESOLVED`, `ERR_FUNCTION_FAILED`, `ERR_PREDICATE_NOT_BOOLEAN`)
  and a failure that is already one of the thirteen. Everything else is yours to name,
  in the function you hand it. Do not test for any of these yourself.
- **Give that function one default per phase.** Until a success response is in hand —
  building the request, replaying carried state, the request call — an error you cannot
  name is `ERR_MODEL_REQUEST_REJECTED`, not something retryable: a model call is not
  known to be unsent. From a success response in hand to the returned answer or the
  terminal `finish` part it is `ERR_MODEL_RESPONSE_INVALID`. Say what could not be done
  ("the request could not be built", "the answer could not be read") and quote the
  original's message; do not say whose fault it was.
- **Keep the original as `cause`** on every failure you re-code, and keep its code out
  of `data`.
- **Decode the answer yourself.** Ask your transport for the body as text (or as a
  stream) and read your dialect from it, so an answer that is empty, not JSON, or
  missing what your dialect requires is `ERR_MODEL_RESPONSE_INVALID` rather than an
  empty completion — as is a malformed or oversized stream frame, a body that breaks
  mid-stream, and a stream that ends before its terminal event.
- **Read a decoded answer as untrusted.** Whatever you walk or index must have its
  shape when it is present — a list of objects, or an object — and one that does not is
  `ERR_MODEL_RESPONSE_INVALID` naming the member. A text, id, name, count or reason of
  the wrong type is absent: never copy it into an answer or a part. The exception is a
  tool call's arguments, which are `ERR_MODEL_TOOL_ARGUMENTS_INVALID` when they are
  present in the wrong form, never a call with no arguments.
- **Read your vendor's error object wherever it turns up** — a failed response, a
  success body, a stream frame — in one order: a specific vendor name first (it wins
  over the status), then the status rows when a response carried the failure, then the
  error's family only when no status did, then `ERR_MODEL_UNAVAILABLE`.

`@telorun/ai` exports what that takes:

| Export | What it is |
| --- | --- |
| `modelAccessDenied`, `modelRateLimited`, `modelQuotaExceeded`, `modelUnavailable`, `modelTimeout`, `modelContextTooLong`, `modelContentRefused`, `modelRequestRejected` | `(message, data?, { cause }?)` — `data` is `{ status? }`, plus `retryAfterSeconds?` on the rate-limited and unavailable ones. |
| `modelContentUnsupported` | `(message, { partType, scheme?, mediaType? }, { cause }?)` |
| `modelToolArgumentsInvalid` | `(message, { tool }, { cause }?)` |
| `modelUnreachable`, `modelResponseInvalid`, `modelInvalidReference` | `(message, { cause }?)` — these carry no data; the last builds `ERR_INVALID_REFERENCE`. |
| `modelFailureFromStatus(status, message, { retryAfter?, cause }?)` | The status rows every provider shares: 401/403 access denied, 402 quota, 429 rate limited, 408/504 timeout, 413 context too long, any other 4xx request rejected, 5xx unavailable. A status outside those classes, or none, is request rejected. `retryAfter` is the header's text. |
| `retryAfterSeconds(text)` | The one reader of `Retry-After`: delta-seconds rounded up, an HTTP date as seconds from now, anything else absent. |
| `modelFailureFromError(err, ctx, otherwise)` | What an error leaving a model kind is raised as; returns it, first match wins. (1) The call's cancellation signal is aborted, or `err` is a structured cancellation: the cancellation — a structured one unchanged, a raw abort as `ERR_INVOKE_CANCELLED` with it as `cause`. (2) `ERR_DURABLE_SUSPENDED`: unchanged. (3) A contract error of the dispatch: unchanged. (4) One of `MODEL_FAILURE_CODES`: unchanged. (5) Anything else: `otherwise(err)`, called once, which returns a failure built with one of the constructors above, `err` as its `cause`. |
| `MODEL_FAILURE_CODES` | The thirteen names. |

`modelFailureFromError` holds only the rows that name no vendor and no transport. What
your transport raises — a refused status, a network failure, a credential that could not
be applied — is your module's own to read, inside `otherwise`, since only your module
knows which transport it chose.

Keep a unit test in your module that reads both manifests and fails when a kind's code
set or `data` differs from the abstract's.

## When a streaming call fails

For `Ai.ModelStream` there are two moments a failure can arrive, and the contract says
which is which:

- **A call is refused by rejecting.** An implementation raises from `invoke` every
  refusal it can decide from the request alone — a content part it cannot carry, an
  option it cannot honour — *before* it contacts its endpoint. Nothing has been sent on
  yet, so a `catch:` step or a route's `catches:` can still answer it.
- **An answer fails by rejecting its iteration.** Whatever fails after the call has
  returned — the endpoint refusing the request, a dropped connection, a failure
  mid-generation — rejects the iteration of the returned stream.
- **A caller that received a stream reads it to its `finish` or cancels it.** A stream
  that is neither read nor cancelled leaves its request open.

## A stream fails by rejecting

`finish` is the **only** terminal part. A failure mid-stream **rejects the iteration**
with a structured error; it is never yielded as a part.

An error part has to be remembered by every drainer, and one that forgets truncates
silently. A thrown error also reaches machinery a data part cannot: `catches:`, a throws
union, a `try:` step — so a provider failure is handleable from a manifest.

Parts already yielded still reach the consumer, so a forwarder can flush partial output
and encode an error frame from its catch. Both shipped encoders do exactly that,
carrying the error's `code` when it has one.

```ts
async *parts(input) {
  for await (const chunk of upstream) {
    if (chunk.error) throw modelUnavailable(chunk.error.message);
    yield { type: "text-delta", delta: chunk.text };
  }
  yield { type: "finish", usage, finishReason: "stop" };
}
```

### Part field names are contract

`text-delta.delta`, `tool-call.toolCall` and `finish.usage` are read **by name** by
consumers outside this repo — an editor rendering a forwarded stream keys on them.
Renaming one is a breaking change with nothing in this repo to catch it.

## Usage: two shapes, and who fills them

A provider reports the **token triple** (`Ai.TokenUsage`), plus three breakdowns of it
when its endpoint gives them: `cachedPromptTokens`, the part of `promptTokens` read
from a cache; `cacheWritePromptTokens`, the part written to one on this call; and
`reasoningTokens`, the part of `completionTokens` spent reasoning. Each is a share of
the count it belongs to, never an addition to it: `promptTokens` is the whole prompt,
so an endpoint that reports its cached and cache-written input separately has them
added in. Report one only
when the endpoint reports it — **absent means "not said", which is not zero** — and an
operation carries it through unchanged; an agent sums it across its calls, leaving it
absent when no call reported it.

The provider-neutral half (`unit`, `total`, the pair that lets one consumer
sum spend across modalities) is stamped by the **operation**, since the triple already
carries the answer.

So a model's declared output requires three fields and an operation's requires five.
Collapsing them would either make every provider report a figure it does not have, or
drop the guarantee exactly where a consumer reads it.

**A declared `integer` crosses a dispatch boundary as an int64.** A consumer that adds
to one must convert first — `0 + 1n` is a `TypeError`, not a sum. `@telorun/sdk`'s
`integerInput` is what that conversion is for.

## Secrets

Carry no credential of your own: reference an `Http.Client` and let its `credential`
do it. `Http.BearerToken`, `Http.ApiKeyHeader` and `Http.QueryKey` cover the static
cases, the 401 re-acquire-and-retry is inherited rather than re-implemented, and the
credential's own output is marked `x-telo-sensitive`, so the material never reaches the
debug wire. This is what the `openai` kinds do: they hold no key at all.

Where a provider genuinely must hold one, `snapshot()` has to redact it
(`redact(["apiKey"], resource)`) — a snapshot is a reading, published into CEL and onto
the debug stream.
