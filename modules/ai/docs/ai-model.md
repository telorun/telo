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
| `providerState` | Opaque state a previous turn produced, replayed verbatim. |
| `responseFormat` | The shape the answer must take, when the provider enforces one. |

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

**`Ai.ModelStream`** returns `{ output }`, a stream of `Ai.StreamPart`.

## Modality lives in the parts

`Ai.ContentPart` covers `text`, `image`, `audio`, `video` and `file`, plus the
output-only `tool-call`, `reasoning`, `citation` and `refusal`. A media part carries
`data` (bytes, or base64 when a manifest authored them) or a `uri`, plus a
`mediaType` — so a document is a matter of **value**, not of a separate kind.

A model returning a picture is an image part in an ordinary completion. `Ai.ImageModel`
is a different *call shape* — prompt, intent, reference images, mask — not the image
modality.

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
    if (chunk.error) throw new InvokeError("ERR_PROVIDER_FAILED", chunk.error.message);
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

A provider reports the **token triple** (`Ai.TokenUsage`) — that is all its endpoint
tells it. The provider-neutral half (`unit`, `total`, the pair that lets one consumer
sum spend across modalities) is stamped by the **operation**, since the triple already
carries the answer.

So a model's declared output requires three fields and an operation's requires five.
Collapsing them would either make every provider report a figure it does not have, or
drop the guarantee exactly where a consumer reads it.

**A declared `integer` crosses a dispatch boundary as an int64.** A consumer that adds
to one must convert first — `0 + 1n` is a `TypeError`, not a sum. `@telorun/sdk`'s
`integerInput` is what that conversion is for.

## Secrets

`snapshot()` must redact credentials (`redact(["apiKey"], resource)`); a snapshot is a
reading, published into CEL and onto the debug stream.

Better still, carry no credential of your own: reference an `Http.Client` and let its
`credential` do it. `Http.BearerToken`, `Http.ApiKeyHeader` and `Http.QueryKey` cover
the static cases, the 401 re-acquire-and-retry is inherited, and the credential's own
output is marked `x-telo-sensitive`, so the material never reaches the debug wire.
