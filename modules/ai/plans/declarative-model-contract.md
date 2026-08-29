# A declared model contract, and providers written as manifests

## Problem

Newer reasoning models refuse the one combination this repo's agents are built out of:

> 400: Function tools with reasoning_effort are not supported for `gpt-5.6-terra` in
> `/v1/chat/completions`. To use function tools, use `/v1/responses` or set
> reasoning_effort to `'none'`.

The authoring agent is nothing but tools, so it ships with reasoning off — measurably
worse at building an application (1/2 on structure, 0/1 on a green suite).

The reason a second wire dialect is expensive is the deeper defect. `Ai.Model`
declares `capability: Telo.Provider`, no schema, and neither `inputType` nor
`outputType`. Its `invoke` and `stream` are duck-typed JavaScript methods, checked at
the call site with a `typeof`. So a provider can only be TypeScript: nothing is
statically checked, no non-Node kernel can host one, and every new endpoint shape is
controller work. A manifest cannot express a model at all, because the only methods a
declared kind can expose are the four the template grammar synthesizes, and a
`Telo.Provider` template is reached parameterlessly through `provide:`.

## Solution

**Two declared abstracts.** `Ai.Model` (buffered) and `Ai.ModelStream` (streaming),
both `capability: Telo.Invocable` with one bound entry point. `inputType` carries
`messages`, `options`, `tools`, `providerState`, `responseFormat`. `Ai.Model` returns
`content`, `text`, `usage`, `finishReason`, `toolCalls`, `providerState` and
`alternatives`; `Ai.ModelStream` returns `output`, a stream of `Ai.StreamPart`.
Cancellation rides the invocation context. `Ai.Text` and `Ai.Agent` take an
`Ai.Model`; `Ai.TextStream` and `Ai.AgentStream` take an `Ai.ModelStream`. The
buffered slots are `use: call`; the streaming slots are `use: [call,
trigger.consumer]`, because that invocation returns a handle and the response, the
transform chain and every error happen while the consumer drains, after it closed. So
a zone's lifetime stops at the streaming boundary instead of falsely extending over
work that runs after it closed. Throws still reach the caller at runtime on all four —
the static throws union is built from `invoke:` steps and `throws.inherit`, not from a
slot's `use`, so that part is a runtime fact rather than a checked one, and nothing
today reads the recorded boundary to warn about a streaming model drained inside a
`noSuspend` or `atomic` region.

**Modality lives in the content vocabulary, not in kind names.** Two
`Telo.JsonSchema` resources exported from `ai`: `Ai.ContentPart` (`text`, `image`,
`audio`, `video`, `file`, plus the output-only `tool-call`, `reasoning`, `citation`,
`refusal`) and `Ai.StreamPart` (`text-delta`, `reasoning-delta`, `content-part`,
`tool-call`, `provider-state`, `finish`). Every part carries `data` or `uri` plus
`mediaType`, so documents are a matter of value, and a part may carry `cacheControl`.
The stream slot names `Ai.StreamPart` as its element type, which types what a consumer
reads but not what a producer emits — see the element-typing group below.

**A stream fails by rejecting, never by yielding.** `finish` is the only terminal part;
a mid-stream failure rejects the iteration with a structured error. Parts already
yielded still reach the consumer, so an SSE forwarder flushes partial output and
encodes an error frame from the catch.

**Abandonment is the iterator protocol; the gap is at the producer.** A consumer that
breaks out of `for await` calls `return()` on the source iterator, and a generator
suspended at a `yield` inside its own `for await` passes that upstream — so every
transform propagates early exit by construction, and forwarding `Symbol.asyncIterator`
is exactly what makes it work. What is missing is the head of the chain: the streamed
HTTP body pumps eagerly and nothing aborts the request when its iterator is returned,
so a user stopping a turn leaves the socket open and tokens billing. So the rule is
that **producers honour `return()`** — the streamed body aborts its request and
destroys its readable — and a consumer that is not an iterator (an SSE forwarder
stopping on client disconnect) reaches the producer through the existing invocation
cancellation, the way the current streaming controllers already do, rather than through
a new stream-scoped object.

Two consequences the bodies must respect: the transport stays out of a `with:` scope,
which closes before the caller drains; and a step `timeout:` over a stream-returning
target is refused — the analogue of `LIVE_VALUE_RETRIED`, derived from the target's
live output rather than a bespoke check, because the timeout orphans its cancellation
token the moment the handle returns. Separately, `Http.Request` reads a failed status's
body before throwing even under `responseType: stream` — without that the structured
error above has nothing in it, and it is a gain for every streaming API.

**`Ai.Buffered`** is a manifest-authored `Ai.Model` whose config is a reference to any
`Ai.ModelStream`; it collects and folds the parts into a buffered result. It exists
for a provider that only streams, and for third parties — not for OpenAI, whose
buffered kind sends a genuinely non-streaming request.

**Reasoning survives a tool loop.** `providerState` is opaque to `ai`, emitted on the
assistant turn, replayed verbatim on the next request, and tagged with the producing
model and dialect — a state whose tag does not match the model being called is
dropped, so a transcript moved between providers or between dialects cannot replay
foreign items.

**Generic primitives** make a manifest able to produce a token stream: `Sse.Decoder`
in `sse-codec` (extending `Codec.Decoder`), and `Stream.Map`, `Stream.Scan` and
`Stream.FlatMap` in `stream`. `Collection.Fold`, `Stream.Collect`, `parseJson` and
`bytesToBase64` already exist and carry the rest.

**Enforcing an element type needs four pieces, and three do not exist yet.** Nothing
before the manifest pipeline needs them, so this whole group sits behind the same gate
as the dialects: if byte-identity or the latency budget fails and a dialect keeps its
controller, this work relaxes with it rather than shipping for a pipeline that does not
land. Each transform declares an `elementType`. Then:

- **`x-telo-type-argument-from`** (new annotation) places a config field's resolved
  schema into a value-type argument, so a stage's `elementType` fills the `of` of its
  own output stream — the same field-to-schema step `x-telo-value-schema-from` already
  performs, landing in an argument slot. Generic to any parameterized value type.
- **A validating iterator at the contract binding** (new kernel work): a declared `of`
  on a stream **output** wraps the returned stream so each element is checked as it is
  pulled, with the `Telo.Stream` vocabulary entry amended to say so. **The declared
  `of` is itself the opt-in** — typing a stream's elements is what asks for them to be
  checked, so there is no second spelling to invent or remember. Nothing checks stream
  elements today: the `live` exemption erases the node at every boundary, and it exists
  precisely to forbid iterating one to inspect it. Serves `Codec.Decoder` and
  `Stream.Chunk` equally.
- **Two analyzer corrections**: a whole-value `!cel` at an `elementType`-typed slot is
  refused, because `x-telo-value-schema-from` runs after CEL leaves become
  schema-shaped placeholders and a whole-value expression — the natural spelling for a
  conditional element — passes by construction; and `x-telo-context-element-from` is
  extended to resolve `steps.`-rooted chains through the step context, without which
  `item` types open however the stages are wired.
- **A prerequisite**: `Http.Request`'s streamed body and `Codec.Decoder`'s input
  declare no `of`, so nothing propagates until those two are typed. That is the first
  link of the chain, not a detail.

With all four, a field renamed between stages is a `telo check` error and a computed
element that does not match is caught once, at the model kind's declared output —
where the contract is claimed to a consumer. Validating at each successive stage would
re-check what the previous one guaranteed, per token, on the most latency-visible path
in the repo.

**`http-client` gains the static credentials it never had.** `Http.Credential` has
exactly one implementation in the repo — OAuth's — which is why providers grew their
own key fields. `Http.BearerToken`, `Http.ApiKeyHeader` (Anthropic's `x-api-key`, most
gateways) and `Http.QueryKey` (Google AI Studio) close that, serving every
authenticated-API module rather than this one. A static credential answers
`forceRefresh` with the same material unchanged, as the abstract already anticipates.

**`x-telo-sensitive: true` marks a contract field, and `Http.Credential` marks its
output.**
This is a fix the rest of the design requires rather than a nicety: making auth a
dispatched `Telo.Invocable` turns the token into an invoke *output*, so under
`--inspect` — every watch session — it would ride the debug wire on each call, which
the kernel's substring scrubbing does not cover (one call site, the resource-Created
event's properties). The mechanism is a marker on an `inputType` / `outputType`
property that the trace payload builder reads and omits, declared by the kind that owns
the contract — the `x-telo-eval` shape, so the kernel names no kind and any module opts
in. Exempting "an `Http.Credential` result" directly would be kind-knowledge in the
kernel and would stop at that one kind while the same token surfaces elsewhere.

**A single `openai` module replaces `ai-openai` and `embedding-openai`**, holding
`Model`, `ModelStream`, `ImageModel` and `EmbeddingModel` — one module per system, so
moderation, audio, batch and files later arrive as kinds rather than as a module
apiece. Both old refs carry a module-level `metadata.deprecated` naming the new one.

**The endpoint posture is a plain `Http.Client`**, referenced by all four kinds. It
already holds `credential`, `baseUrl`, `timeout`, `retry` and `headers`, so the
account is declared once with no new kind — the vendor base URL is one line per app.
The model kinds carry only call shape: the client reference, `model`, `api` (`chat` or
`responses`, defaulting to `chat`), `reasoning.effort` and `options`. Four of those are
restated between the buffered and streaming kinds when an app uses both, which is
inherent to two kinds and is the residual cost of the split.

**The two shapes send different requests, and share their translation.** `OpenAI.Model`
posts a non-streaming request and reads one JSON response — no SSE, no transforms.
`OpenAI.ModelStream` posts a streaming request and runs `Http.Request` → `Sse.Decoder`
→ `Stream.Map` → `Stream.Scan` → `Stream.FlatMap` as the steps of a `Run.Sequence`,
which is `capability: Telo.Runnable` and reached from a step's `invoke:` through
`Telo.Executable`; wiring the stages as steps is what puts each one's `inputs:` at the
site where element types are compared. The message translation is written **once per
dialect** as an internal kind that both model kinds instantiate; only the response
reading differs. The TypeScript model controller is deleted, and `ImageModel` and
`EmbeddingModel` move across unchanged apart from their names.

Under `api: responses` the messages become `input` items, the system turn becomes
`instructions`, a tool result becomes a `function_call_output` item keyed by call id,
tools are flat (`type: function` with `name`, `description`, `parameters`), reasoning
is nested under `reasoning.effort`, and usage arrives as `input_tokens` /
`output_tokens` / `total_tokens`.

**Observed, not assumed** — the gate ran against `gpt-5-nano`, one call with a function
tool AND `reasoning.effort: low`, the pair `/chat/completions` refuses. Two things the
documented reading did not say, and both are traps:

- **A tool call carries `call_id` AND `id`, and they are different values.**
  `{type: function_call, id: "fc_…", call_id: "call_…", name, arguments}` — `arguments`
  is a JSON *string*. The `function_call_output` item keys on **`call_id`**; keying on
  `id` produces a request the endpoint accepts and answers wrongly.
- **`providerState` is the reasoning ITEM, replayed verbatim.** The response's `output`
  array carries `{id, type: "reasoning", encrypted_content: "<opaque>", summary: []}`
  beside the function call. That item is what must go back out in the next turn's
  `input` for the chain to survive a tool loop — so `providerState` carries an output
  ITEM, not a response id. (`previous_response_id` exists and stays unused, for the
  reason already stated.)

The stream's event names, in the order they arrive:

    response.created · response.in_progress
    response.output_item.added · response.output_item.done      (per item)
    response.content_part.added · response.content_part.done    (text items only)
    response.output_text.delta · response.output_text.done      (text)
    response.function_call_arguments.delta · .done              (tool calls)
    response.completed

A tool-calling turn emits NO text delta, so the two paths have to be probed separately
— one probe covering both is a probe that silently covers one. `response.output_text.delta`
carries `{delta, item_id, content_index, output_index}`; the function-call deltas
accumulate a JSON string that `.done` repeats whole. **Usage arrives only on
`response.completed`**, inside `response.usage`. Frames also carry an `obfuscation`
padding field, which is ignorable and must not be treated as part of the vocabulary.

## Decisions

- **Two model abstracts, not one always-streaming abstract.** A live output is exempt
  from validation, so a single streaming contract would take the check away from the
  *buffered* path too — the one `Ai.Text` and `Ai.Agent` use, and the majority of
  calls. Two kinds keeps that half enforced by the binding and leaves only the
  streaming half to the transforms. It is also the repo's standing answer when one
  entry point cannot serve two slots, and it makes "this endpoint does not stream"
  expressible instead of faked as a one-element stream.
- **`Telo.Invocable`, not `Telo.Provider`.** A provider template is reached through
  `provide:`, which is parameterless, so per-call messages and tools have nowhere to
  enter. Rejected: relaxing `PROVIDE_DISPATCHER_CONFLICT` and
  `PROVIDER_MISSING_IMPLEMENTATION`, which weakens a rule that states something true.
- **Generic kind names, modality in the parts.** `Ai.ImageModel` is a different *call
  shape* — prompt, intent, reference images, mask — not the image modality; a chat
  model returning a picture is an image part in `Ai.Model`'s output. Rejected:
  `Ai.TextModel`, which would need a third pair of abstracts per modality.
- **No new secret type — but the existing coverage is narrower than it looks.** The
  kernel's substring scrubbing has one call site, the resource-Created event's
  properties; log attributes match exactly, and dispatch payloads are not scrubbed at
  all. That is why the sensitive-field marker above is part of this change rather than
  an aside — and it is deliberately one annotation on a contract field read by one
  consumer, not a `Telo.Secret` value type, which would drag publication, logging and
  diagnostic-rendering work into an AI release. If that type is wanted it is its own
  plan, which must state coverage per path, say which mechanism wins where they
  disagree, and admit that a config-field type cannot govern what a TypeScript
  controller's `snapshot()` returns.
- **Both dialects as manifests, with a stated fallback.** Keeping the chat dialect in
  TypeScript would leave two implementations of one translation to drift apart.
  `Collection.Fold` carries the tool-message contiguity and image-carrier ordering it
  needs, and the per-dialect translation kind stops the buffered and streaming shapes
  becoming a second copy. If byte-identity or the latency budget cannot be met, **this
  decision is the one that relaxes**: that dialect keeps its controller. For that to
  leave the rest genuinely unchanged the fallback controller **drives an injected
  `Http.Request`** rather than calling `fetch` — otherwise it sits over a plain
  `Http.Client` and has to apply the credential and re-implement the 401
  `forceRefresh` retry that `http-client` owns, which is a second implementation of the
  thing this design just consolidated.
- **The element chain types itself, rather than each stage restating the previous.**
  An `inputElementType` per stage is the `Collection.Fold` `accType` precedent and
  works today, but it fails in the dangerous direction — an under-declaration silently
  switches the check off, once per stage. `x-telo-type-argument-from` costs one generic
  annotation and removes the restatement entirely.
- **`api` on the model kind, not on the client.** Azure, Ollama, vLLM, Groq and
  OpenRouter do not serve `/v1/responses`, so the default stays `chat`. Which surface
  an endpoint serves reads like a property of the endpoint, but putting it there makes
  the reasoning refusal span a reference: rules see the raw manifest, so the condition
  would have to restate the `chat` default to avoid throwing on an omitted `api`, and a
  `!cel` there switches the rule off entirely. On the model kind it is one
  `x-telo-resource-rules` entry over one resource. Rejected: switching dialect
  automatically when reasoning is asked for, which sends a request half the supported
  endpoints 404.
- **Auth is a credential reference on the client, and nowhere else.** An `apiKey` field
  beside a `credential` ref is two ways to say one thing kept apart by a rule. Since
  the model kinds carry no credential of their own, a plain `Http.Client` is the single
  home and no precedence rule arises. Rejected: putting `credential` on `Ai.Model`
  itself, which would make `ai` import `http-client` for a field meaningless to a
  non-HTTP provider — the abstract owns the call contract, the provider owns its
  transport. Rejected: a provider-owned account specializing `Http.Client` to add
  `api` — that shape now works (a merge-form child publishes its own fields), so it is
  rejected on the reason above rather than on a mechanism gap: `api` on an account
  resource is the same reference-spanning rule, and it buys a kind where a field on the
  model already says it.
- **A stream fails by rejecting.** An error part must be remembered by every drainer,
  and one that forgets truncates silently — the shape the suspension latch and the
  effect chain exist to design out. A thrown structured error also reaches machinery a
  data part cannot: `catches:`, a throws union, a `try:` step — so `ERR_AGENT_MAX_STEPS`
  and a tool error under `onToolError: throw` become handleable from a manifest for the
  first time.
- **A module is named after the system it talks to.** `postgres`, `sqlite` and now
  `openai`; a contract module keeps the contract's name, and a bridge with no system
  of its own stays composite (`kv-store-sql`, `ai-mcp`, `vector-store-pgvector`).
  `ai-openai` was the only module in the repo whose kinds stuttered the vendor
  (`OpenAI.OpenaiModel`) while every other backend names its kinds by role —
  `Postgres.Connection`, `CacheRedis.Store`. The prefix also buys nothing for
  discovery, since the hub groups backends by resolving `extends`, not by name.
  Rejected: keeping the prefix and dropping only the stutter, which multiplies modules
  per vendor as OpenAI's surface grows. Renaming rides on a change that already breaks
  every consumer's imports; done later it is a second break of the same manifests.
- **`providerState` rather than server-side `previous_response_id`.** A response id
  would have to live on a model instance shared across concurrent invocations, leaking
  one conversation's state into another's.
- **Other transports are additive.** Bedrock's binary event stream and chunked-JSON
  providers are further `Codec.Decoder` implementations; nothing here has to know how
  many framings exist.

## Sequence

One release, but not one commit — the order is part of the design, since two gates
decide whether the last group ships at all.

1. **`http-client` fixes**, standalone and useful alone. *Landed and covered.* The
   failed-status body is asserted for both response types. Abandonment is asserted
   twice, because one test cannot reach both halves: a manifest test pins the
   consumer-visible behaviour (the failure propagates, nothing hangs, the client stays
   usable — and it passes with the handler removed, which is stated in the test), and a
   unit test drives the body reader directly to assert the abort and the reader
   cancellation, failing when the handler is removed. A partial consumer costs nothing:
   a stage failing part-way unwinds the drain and reaches the transport.

2. **The three static credentials and `x-telo-sensitive`.** *Landed.* Neither earned a
   `requires:` floor — verified by execution: `@telorun/cli@0.82.1` reads both modules
   with no complaint, since a contract body is open and the new kinds are ordinary
   schema.
3. **The responses probe.** *Passed.* Tools plus a non-`none` reasoning effort are
   accepted on `/v1/responses`, and the confirmed field and event names are recorded
   above — including the `call_id` / `id` split and the reasoning item that
   `providerState` has to carry, neither of which the documented reading gave.
4. **`Sse.Decoder` and the three transforms.** *Landed*, tested against hand-written
   wire bytes rather than probe fixtures: the interesting cases are the ones a
   well-behaved encoder never produces (a comment keep-alive, a frame with no `data:`,
   a chunk boundary inside a frame).
5. **The contract**: `Ai.Model` / `Ai.ModelStream`, the parts vocabulary,
   `providerState`, `Ai.Buffered` and the four consumers. *Landed.* `ai` now imports
   `run` and `stream` — both strictly more generic than it, neither importing anything,
   so no cycle. `Ai.Buffered` passes its whole input through rather than enumerating
   the fields: enumerating them dropped `tools`, which turned an agent's first turn
   into a plain answer with nothing to report it.
6. **The `openai` module.** The MERGE and RENAME are *landed*: `ai-openai` and
   `embedding-openai` are one module whose kinds are named by role (`OpenAI.Model`,
   `ModelStream`, `ImageModel`, `EmbeddingModel`), both old refs publish deprecated
   naming it, and every live test passes against the real API. Doing this now is what
   keeps it ONE break for consumers rather than two.

   Still open: **the credential move** (the model kinds carry an `apiKey` while
   `Http.BearerToken` sits unused beside them — the fallback controller should drive an
   injected `Http.Request`, which is what inherits the credential and the 401 retry
   instead of re-implementing them), and **the manifest dialects**, which are gated on
   the byte-identity and latency harness. Only one in-repo consumer used a relative
   path and has moved; the rest are digest-pinned and are repointed at publish time.
7. **The element-typing group**, last and behind its gate. **Not started**; it relaxes
   with 6 by the rule stated above. Each transform already declares an `elementType`
   held by `x-telo-value-schema-from`, which is the half that works today.

Two consumers cannot move until the modules publish: `apps/authoring-agent/chat` and
`examples/chat-console` pin `ai` and `ai-openai` by digest, so they reference the old
contract and are consistent doing so. Repointing them is release work, not a step here.

The agent switch and the latency harness ride with 6, since the harness needs both
implementations in hand to compare.

## Verify

The responses wire shape above is stated from documentation, not observation, so
confirming it is a **gate, not a test**: one non-streaming and one streaming call
carrying a tool and a reasoning effort, run before any translation is written, and the
recorded fixtures below are captured from them. Everything downstream rests on those
field and event names.

`Sse.Decoder` and the three stream transforms are tested standalone against recorded
fixtures, including both halves of element typing: a transform whose per-element
expression writes an unknown property fails `telo check`, and one that computes an
element the declared type rejects fails at dispatch rather than reaching a consumer.
Both dialects are covered offline — a buffered call, a streamed call, a tool
call, a tool result fed back, and reasoning round-tripping across two turns. The chat
dialect is asserted as request bytes identical to what the current controller
produces, not merely as a passing suite. A consumer that stops draining is asserted to
close the socket — breaking out of the drain reaches the producer's `return()`, so the
assertion has a mechanism behind it — and a failed status is asserted to carry the
provider's message into the raised error even on a streamed call. A mid-stream failure
is asserted to reject the iteration rather than yield, and to be catchable by name from
a manifest.

Four assertions cover the pieces with no natural home above: an `Invoked` payload under
`--inspect` omits a field marked `x-telo-sensitive`; a static credential returns the
same material under `forceRefresh` and a 401 retries exactly once; `Ai.Buffered` folds
a streaming provider into a buffered result; and the authoring agent's SSE forwarder
emits the same error frame it emits today, now from a caught rejection rather than a
forwarded part — without which the wire silently loses its error frame and the editor
never learns a turn failed.

**A latency budget sits beside the correctness fixtures**, because token streaming to
an interactive editor is the most latency-visible path here and every number above is
a quality number. The same harness captures the current controller's numbers first, and
the budget is **no regression in time to first part and total per-part overhead no more
than twice that baseline** — a number the run itself establishes rather than one
guessed here. A miss triggers the same relaxation as a byte-identity miss.

One live check exercises a non-`none` reasoning effort with function tools on
`/v1/responses`. End to end, the authoring agent's own e2e suite
runs on a reasoning model with reasoning on; 1/2 on structure and 0/1 on a green suite
are the numbers to beat.

## Release

`x-telo-type-argument-from` and `x-telo-sensitive` both widen the manifest surface, so
every module whose own manifest writes either — `stream` and `http-client`, plus any
later consumer — declares a `requires: telo:` floor at the release carrying it,
verified by execution: strip the block, confirm the previous published CLI rejects the
manifest, restore it, confirm the same CLI reports `MODULE_REQUIRES_NEWER_RUNTIME`. A
module that is not rejected does not get a floor.

**`x-telo-sensitive` will most likely not earn one**, and that is worth saying rather
than discovering: a contract body is open, so an older analyzer reads the marker as an
unknown keyword and passes. The consequence is that an older kernel ignores it and puts
the token on the debug wire — which is what happens today for OAuth's credential output
anyway, so this is an unprotected older runtime rather than a regression, and the floor
rule stands as written. What must not happen is reading "verified by execution" as
evidence the protection is universal.
`ai` and `openai` take release fragments and every `Ai.Model` implementation
republishes. The fragments are `Added` and `Fixed` only: the kind renames, the
capability change and the module merge are breaking, and breaking-as-minor is the
convention here — `Changed` and `Removed` are major-inducing and rejected outright, so
no major bump is proposed and none should be.

`openai` publishes at a new module ref, so a consumer edits its `imports:` by hand —
`telo upgrade` moves a pin within a ref and does not cross a rename — and the hub
carries two deprecated refs pointing at it. `ai-openai` and `embedding-openai` publish
one final version each, declaring `metadata.deprecated` and nothing else.

**The in-repo consumers move in the same change.** Naming `OpenaiModel` today:
`examples/chat-console`, `examples/agent-console`, `examples/draw-shapes-agent`,
`templates/apps/ai-agent-console`, `apps/authoring-agent/chat`, and the four
`modules/ai-openai/tests/*.yaml` that travel with the module. Of those,
`examples/chat-console` and `apps/authoring-agent/chat` gain a second resource, since
`Ai.TextStream` and `Ai.AgentStream` now need an `Ai.ModelStream`. One test changes
meaning rather than location: `openai-snapshot-redacts-secrets.yaml` asserts the
model's `snapshot()` redacts `apiKey`, a field this design deletes, so it becomes an
assertion about a credential's reading and `x-telo-sensitive`.

**Studio needs no change, but not because it is uncoupled.** The agent's SSE protocol
*is* the forwarded stream parts: Studio reads `text-delta.delta`, `tool-call.toolCall`,
`finish.usage` and an `error` frame off them by field name, with an open
`{ type: string }` fallback for every other type. So the new part types cost it nothing,
and the existing ones **must keep their field names** — an invariant on the
`Ai.StreamPart` vocabulary rather than an absence of coupling, since renaming `delta`
would break the panel with nothing failing in this repo. The error frame must likewise
be emitted from the caught rejection.

Module documentation is rewritten where it describes the convention interface, along
with the kind names in `modules/ai/docs`, `modules/ai-mcp/docs`, the module READMEs and
the generated `pages/static/reference/standard-library.md`. The authoring agent's
system prompt is updated in the same change — it names `Ai.Model`'s
`Telo.Provider`-but-`use: call` oddity explicitly, and that note goes. The agent's
`model` variable default moves to the reasoning model and the comment above it
explaining why one cannot go there is deleted; there is no `reasoningEffort` setting to
remove, in that manifest or anywhere else. Because the agent pins its provider by
digest, the end-to-end verification runs against the module by relative path until the
import is repointed at `openai`.
