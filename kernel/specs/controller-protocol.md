---
description: "v1.0 spec: the Telo controller protocol — every operation that crosses between a kernel and a controller, its direction and payloads, the length-prefixed framed carrier pinned byte-exactly, and the generation counter both carriers report"
---

# Telo Controller Protocol Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines the **controller
protocol**: the complete set of operations that cross between a Telo kernel and a
Telo controller, the direction each travels, what each carries, and the two
carriers those operations ride — framed messages over a dedicated channel out of
process, and the C ABI in process.

It is normative because a controller is an artifact published independently of
every kernel that will ever load it. A controller written against one kernel's
source is bound to that kernel's refactoring history; a controller written
against this document runs unchanged on any kernel that conforms to it, in any
language. Nothing in a manifest shows which operations a controller reached for,
so a divergence here is invisible until a published module meets a second
runtime.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **RECOMMENDED** are to be interpreted as described in RFC 2119.

### 0.1 The boundary this binds

**The spec's normative force is scoped to the controller boundary** — what
crosses between a kernel and a controller — and **not** to a kernel's internals.
A kernel that hosts controllers in its own process, calling them through its own
language's function calls, satisfies this specification by carrying the same
operations with the same meanings; it is not required to re-express its internals
as messages, and no wording here obliges an existing kernel to change how it
calls a controller it already hosts. What this document fixes is the **set** of
operations, their directions, their payloads and their failures — so that a
controller needing one of them behaves identically whichever kernel and whichever
carrier it meets.

**In scope** — one section per class of transfer:

- `4. Session` — establishing a pairing and scoping every later message to one kernel instance.
- `5. Lifecycle` — the capability entry points that build, start and tear an instance down, and the revertible effects they return.
- `6. Invocation` — dispatch in both directions, and the per-call concerns that ride with it: cancellation, zones, spans, synchronous calls.
- `7. Resolution & schema` — turning what a manifest says into what a controller can use: references, schemas, and compiled values.
- `8. Channels` — flow-controlled byte streams, which is how anything too large or too long-lived to be one payload crosses.
- `9. Host facilities` — what a controller reads from the runtime hosting it: logging, child manifests, module files, the environment.

**Out of scope, deliberately:**

- **The kernel's own module registry.** Module loading, kind and definition
  registration, import wiring, child evaluation contexts and manifest loading
  name no message in this protocol. Those are things a kernel performs natively
  over its own state, and no kernel ever runs inside a controller host — so
  expressing them as messages would oblige a second implementation to drive the
  first kernel's registry over a wire in order to be conformant. Resource lookup
  by name is reachable as dispatch (§6.2) and as reference resolution (§7.1); the
  registry behind it is not.
- **Controller selection.** Which PURL candidate a kind's controller resolves to,
  where its bytes come from, and how they are verified, are the kernel's and the
  artifact spec's (`kernel/specs/module-artifact.md`). The protocol begins once a
  controller has been obtained (§5.1).
- **CEL.** A controller never evaluates a Telo expression. Compiled values are
  kernel-owned and are expanded by asking (§7.4).
- **What a controller does between its entry points.** The protocol says what
  crosses, not how a controller implements the work.

### 0.2 A controller that cannot be hosted

The message set is **closed** at a generation. A controller that needs an
operation this protocol does not name **cannot be hosted**, and a kernel MUST
refuse the pairing rather than degrade it: the refusal is raised at
`Controller.Create` with `ERR_CONTROLLER_HOST_INCOMPATIBLE`, naming the
controller, the kind and the operation. There is no third error code for this —
an incompatible controller and an incompatible peer are the same fact, discovered
at different moments, and a second code would only invite a caller to handle one
and not the other.

`modules/type` is the one standard-library module the registry exclusion reaches.
Its deprecated kinds register schemas and type rules into the kernel's own
registry, which names no message here, so they cannot be hosted out of process
and a kernel that hosts controllers only across this boundary MUST refuse them as
above. That module is deprecated: **`Telo.JsonSchema` is the kernel built-in that
replaced it**, and a kind declaring `inputType` / `outputType` against a
`Telo.JsonSchema` resource needs nothing this protocol lacks.

### 0.3 Generation `telo-4`

One generation counter covers both carriers, reported in the handshake (§4.1) and
written into a native controller's PURL as `abi=telo-<n>`.

- **Generation `3` is the prior, unspecified shape**: JSON payloads in `TeloBuf`
  buffers across the C ABI, described only by the ABI crate's own layout. This
  specification does **not** retroactively describe it, and a generation `3`
  controller keeps loading exactly as it does today.
- **Generation `4` is the first generation this specification defines.** It is
  the generation in which the C ABI carries this protocol's messages rather than
  a contract of its own, and it is the value in
  `sdk/controller-protocol/generation.json`.
- **No artifact may declare `abi=telo-4` until the ABI carrier lands.** A
  declaration reaching a kernel that does not implement the carrier MUST be
  refused with `ERR_CONTROLLER_HOST_INCOMPATIBLE`. Until then the ABI crate's
  `TELO_ABI_VERSION` stays `3`, which is what keeps the published `abi=telo-3`
  controller candidates valid: specifying `4` does not retire `3`.

### 0.4 Related specifications

This one says how an operation crosses. What the operation MEANS is owned
elsewhere, and this document does not restate it:
`kernel/specs/revertible-effects.md` (frames, LIFO recovery, disposal),
`kernel/specs/invocation-contract.md` (resolution, binding, default-fill,
validation), `kernel/specs/execution-zones.md` (matching, correlation, the
payload rule), `kernel/specs/logging.md` (the record model, severity, sinks),
`kernel/specs/tracing.md` (spans and their export),
`kernel/specs/durable-execution.md` (the replay contract, and §6's typed frame,
which is this protocol's value encoding). The authoring guide is
`docs/extend/controller-protocol.md`.

## 1. The protocol

### 1.1 What a message is

A **message** is one operation of the controller contract: either a capability
entry point the kernel calls on a controller, or an operation a controller may
ask of the kernel while inside one. The set is the closure of that contract over
the capability vocabulary — `Telo.Service`, `Telo.Runnable`, `Telo.Invocable`,
`Telo.Provider`, `Telo.Mount`, `Telo.Sink`, `Telo.Callable` — and the operations
the normative specifications in §0.4 already define, plus the host-provided
facilities a controller reads.

A message is **not** a member of any one language's context interface. That
derivation was considered and rejected: it pins the protocol's generation to a
refactoring history, and it cannot see its own subject — `invoke` is *two*
operations with opposite directions, the kernel calling a controller's entry
point and a controller asking the kernel to dispatch, which a member census sees
as one. They are `Controller.Invoke` and `Dispatch.Invoke` here, and they are
distinct messages.

Each message is named `<Group>.<Operation>` and carries, as data in
`sdk/controller-protocol/messages/<kebab-name>.json`, its `direction`, the `spec`
section it realises, its `request` and `response` schemas, the protocol error
codes it may carry, and whether it is `synchronous` and `reentrant`. That
directory's README states its own contract; this document and that directory are
two halves of one artifact, kept in agreement by
`pnpm run check:controller-protocol`.

### 1.2 The two ends, and the two carriers

**The protocol's two ends are the kernel and the controller.** They are never the
kernel and a host: a host process is a property of one carrier, and the other
carrier has no host process at all. Every message declares its `direction` as
`kernel-to-controller`, `controller-to-kernel` or `either`, read against those
two ends.

Two carriers deliver them:

- **Framed** (§3) — length-prefixed binary frames over a dedicated bidirectional
  channel, never the process's own standard input or output. This is how a kernel
  in one language reaches controllers written in another, and one carrier
  instance serves every kernel instance in a process, which is why a session id
  rides every envelope.
- **ABI** — the C ABI, in process. The same messages, the same payloads,
  delivered through vtable slots rather than frames.

**No message exists on one carrier only.** That is a property of the message set
as a whole, not a per-message field, and it is what makes the ABI's next
generation a carriage of this protocol rather than a second contract. Its proof
is `sdk/controller-protocol/vectors/carrier-equivalence.json` (§11).

### 1.3 What crosses, and what stays

- **Values** cross as **typed frames** — the JSON form defined by
  `kernel/specs/durable-execution.md` §6, already normative in both languages.
  A runtime MUST NOT invent a second value encoding for this protocol. Every
  schema in `messages/` that describes a value describes the frame's decoded
  value, so a `bytes` field is a value of CEL type `bytes` and not a base64
  string a reader has to know to decode.
- **Instances** cross by **handle**: a kernel-minted `ResourceInstanceId` and the
  reference identity it was resolved from. Only the id is compared; the reference
  identity is for diagnostics. A handle is valid for the lifetime of the live
  instance and within the session that minted it.
- **Anything carrying code is owned by the side that created it**, and the other
  side holds a handle. A compiled CEL value is kernel-owned and is expanded by
  asking (§7.4). An effect body and the chain it sits in are controller-owned:
  the kernel orders and reverts them by handle and never looks inside one (§5.4).
  A durable run handle does not cross at all — the kernel carries it and never
  calls it, so a second runtime threads a handle it owns rather than
  deserializing one.
- **Streams, standard input and output, and a child manifest's output** cross as
  **flow-controlled channels** (§8), never as one payload.
- **A resolved reference** is live in the same realm where both ends of the
  reference are bound in one realm; otherwise it is a **proxy** exposing exactly
  the target kind's capability entry points and nothing else (§7.1).
- **Errors** cross as structured codes (§10). **Suspension and cancellation are
  distinct signals**, not errors: `ERR_DURABLE_SUSPENDED` and
  `ERR_INVOKE_CANCELLED` are re-raised by anything that catches, on both ends.

### 1.4 Handles, and who releases them

Every handle in this protocol is minted by one side and released by a message the
other side sends, or by the lifetime of something already handled:

| Handle | Minted by | Released by |
| --- | --- | --- |
| session | kernel | `Session.Close` |
| controller | controller | the session |
| instance | kernel | `Controller.Destroy` |
| chain | controller | the frame that executed it |
| effect | kernel | `Effect.Revert` or `Effect.Dispose` |
| inverse | controller | the effect that carries it |
| hold | kernel | `Hold.Release` |
| cancellation source | kernel | `Cancellation.Dispose` |
| span | kernel | `Span.Settle` |
| validator | kernel | the instance that compiled it |
| detached task | kernel | `Dispatch.DetachSettle` |
| channel | the opener | `Channel.Close` |
| child run | kernel | `Runtime.Exited` |

A handle a peer does not recognise is a protocol violation, terminal for the
carrier instance (§3.5). A runtime MUST NOT silently ignore one: a stale instance
handle reaching `Controller.Invoke` is a kernel that lost track of a teardown,
and answering it would run work against an instance that no longer exists.

## 2. Message inventory

One row per message, in the lexical order of the file names in
`sdk/controller-protocol/messages/`, compared as UTF-8 bytes.

| Message | Direction | Section | Synchronous | Reentrant |
| --- | --- | --- | --- | --- |
| `Callable.Call` | `kernel-to-controller` | `6. Invocation` | yes | yes |
| `Cancellation.Cancel` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Cancellation.Create` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Cancellation.Dispose` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Cancellation.Signal` | `kernel-to-controller` | `6. Invocation` | no | no |
| `Channel.Close` | `either` | `8. Channels` | no | no |
| `Channel.Credit` | `either` | `8. Channels` | no | no |
| `Channel.Data` | `either` | `8. Channels` | no | no |
| `Channel.Open` | `either` | `8. Channels` | no | no |
| `Controller.Bind` | `kernel-to-controller` | `5. Lifecycle` | no | no |
| `Controller.Create` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Controller.Destroy` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Controller.Init` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Controller.Invoke` | `kernel-to-controller` | `6. Invocation` | no | yes |
| `Controller.Provide` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Controller.Run` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Controller.SinkClose` | `kernel-to-controller` | `5. Lifecycle` | no | no |
| `Controller.SinkFlushSync` | `kernel-to-controller` | `5. Lifecycle` | yes | no |
| `Controller.SinkFlush` | `kernel-to-controller` | `5. Lifecycle` | no | no |
| `Controller.SinkWrite` | `kernel-to-controller` | `5. Lifecycle` | no | no |
| `Controller.Snapshot` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Dispatch.DetachSettle` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Dispatch.Detach` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Dispatch.InvokeResolved` | `controller-to-kernel` | `6. Invocation` | no | yes |
| `Dispatch.Invoke` | `controller-to-kernel` | `6. Invocation` | no | yes |
| `Dispatch.Run` | `controller-to-kernel` | `6. Invocation` | no | yes |
| `Effect.Dispose` | `controller-to-kernel` | `5. Lifecycle` | no | yes |
| `Effect.Perform` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Effect.Register` | `controller-to-kernel` | `5. Lifecycle` | no | no |
| `Effect.Revert` | `kernel-to-controller` | `5. Lifecycle` | no | yes |
| `Effect.Run` | `controller-to-kernel` | `5. Lifecycle` | no | yes |
| `Env.Read` | `controller-to-kernel` | `9. Host facilities` | yes | no |
| `Event.Emit` | `controller-to-kernel` | `5. Lifecycle` | no | no |
| `Hold.Acquire` | `controller-to-kernel` | `5. Lifecycle` | no | no |
| `Hold.Release` | `controller-to-kernel` | `5. Lifecycle` | no | no |
| `Log.Drop` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Log.LevelFor` | `controller-to-kernel` | `9. Host facilities` | yes | no |
| `Log.Threshold` | `kernel-to-controller` | `9. Host facilities` | no | no |
| `Log.Write` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Module.ControllerFile` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Module.File` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Native.File` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Ref.Declaration` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Ref.Ensure` | `controller-to-kernel` | `7. Resolution & schema` | no | no |
| `Ref.Resolve` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Runtime.Cancel` | `controller-to-kernel` | `9. Host facilities` | no | no |
| `Runtime.Check` | `controller-to-kernel` | `9. Host facilities` | no | yes |
| `Runtime.Exited` | `kernel-to-controller` | `9. Host facilities` | no | no |
| `Runtime.Run` | `controller-to-kernel` | `9. Host facilities` | no | yes |
| `Runtime.Started` | `kernel-to-controller` | `9. Host facilities` | no | no |
| `Schema.Check` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Schema.Compile` | `controller-to-kernel` | `7. Resolution & schema` | no | no |
| `Schema.Resolve` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Schema.Validate` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Session.Close` | `kernel-to-controller` | `4. Session` | no | yes |
| `Session.Hello` | `kernel-to-controller` | `4. Session` | no | no |
| `Session.Open` | `kernel-to-controller` | `4. Session` | no | no |
| `Span.Open` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Span.Settle` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Status.Set` | `controller-to-kernel` | `5. Lifecycle` | no | no |
| `Value.Decode` | `controller-to-kernel` | `7. Resolution & schema` | yes | no |
| `Value.Expand` | `controller-to-kernel` | `7. Resolution & schema` | yes | yes |
| `Zone.Attributes` | `controller-to-kernel` | `6. Invocation` | yes | no |
| `Zone.Close` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Zone.Find` | `controller-to-kernel` | `6. Invocation` | yes | no |
| `Zone.List` | `controller-to-kernel` | `6. Invocation` | yes | no |
| `Zone.Open` | `controller-to-kernel` | `6. Invocation` | no | no |
| `Zone.Require` | `controller-to-kernel` | `6. Invocation` | yes | no |

**Synchronous** means the sender is blocked while the request is outstanding: it
performs no other work and reaches no further state until the response arrives.
**Reentrant** means the responder MAY issue further requests to the sender while
the request is outstanding, and the sender MUST serve them. The two together are
what make a module function reachable from inside an expression the kernel is
evaluating on the controller's behalf (§6.7).

## 3. The framed carrier

Everything in this section is byte-exact, and
`sdk/controller-protocol/vectors/framing.json` carries the rows that assert it.

### 3.1 The frame

A frame is:

```
length      u32, big-endian   bytes that follow this field
class       u8                0x01 message frame, 0x02 data frame
metaLength  u32, big-endian   bytes of the meta region
meta        metaLength bytes  UTF-8
data        the rest          uninterpreted bytes
```

- `length` MUST equal `1 + 4 + metaLength + len(data)`.
- **`MAX_FRAME_LENGTH` is 16777216** (16 MiB), the largest value `length` may
  carry. A reader MUST refuse a frame whose `length` field exceeds it, **before
  reading the body** — a reader that allocates first is a reader a peer can
  exhaust with four bytes.
- A reader MUST refuse a frame whose `metaLength` exceeds `length - 5`, and one
  whose `meta` is not well-formed UTF-8.
- `length` counts bytes and nothing else: there is no padding and no alignment,
  and a frame of `length` 0 is a refusal.

Both fields are unsigned and big-endian. Big-endian because a frame header is
read by eye in a hex dump as often as by code, and a width fixed at four bytes
because a varint's own length is a second thing to get right at the one place a
reader has not yet validated anything.

### 3.2 The envelope

The `meta` region is the **typed-frame JSON text**
(`kernel/specs/durable-execution.md` §6) of an object with exactly four members:

- **`id`** — an unsigned integer correlating a request with its response.
- **`session`** — the session the message belongs to, or `null` on
  `Session.Hello`, which precedes every session.
- **`type`** — the message's `name`, exactly as `messages/` spells it.
- **`payload`** — the message body, validated against that message's `request`
  schema on a request and its `response` schema on a response.

Each member's spelling is fixed, because two runtimes writing one envelope must
write the same bytes: `id` is a plain JSON number, whole and non-negative;
`session` is a string or `null`; `type` is a string; `payload` is the body, whose
own values are typed frames and may therefore be tagged. The meta's members are in
the typed frame's own canonical order — by key, as `durable-execution.md` §6.2
states — so nothing about how a runtime holds an envelope reaches the bytes.

`session` rides the envelope rather than being implied by the connection because
one carrier instance serves every kernel instance in a process. A frame whose
`session` names no open session is a protocol violation.

**Ids are partitioned by parity**: the kernel end mints **even** ids, the
controller end **odd** ids, unique per carrier instance rather than per session.
A reader therefore knows from a frame's `id` alone whether it holds a request the
peer initiated or a response to something it sent itself, with no fifth envelope
member to keep in agreement. An id MUST NOT be reused while a request bearing it
is outstanding.

A **response** frame carries the requester's `id` and the same `type`, and its
`payload` is an object with exactly one member:

- `ok` — the response body; or
- `error` — `{ "code": "<ERR_*>", "message": "<text>", "data": <value> }`, `data`
  optional.

A message whose `response` in `messages/` is `null` is a **notification**: no
response frame is ever sent for it, and a peer that sends one is in violation.

### 3.3 The two frame classes

A **message frame** (`class` `0x01`) MUST carry an empty `data` region. Its whole
content is the envelope.

A **data frame** (`class` `0x02`) MUST carry `type` `"Channel.Data"`, and its
`data` region MUST be exactly `payload.byteLength` bytes long. **`Channel.Data`
is the only data frame.** A reader MUST refuse a data frame whose `type` is
anything else, and one whose `data` length disagrees with `byteLength`.

`Channel.Open`, `Channel.Credit` and `Channel.Close` are ordinary message frames.
Flow control is therefore in the inventory and is vectorable like every other
message, while the chunk itself stays raw: a stream chunk, a controller's
standard-output write and a child manifest's output would otherwise inflate
through base64 inside the typed frame, which is the cost that disqualifies a
line-delimited JSON carrier in the first place.

A `Channel.Data` chunk MUST NOT exceed **8388608** bytes (8 MiB), which leaves a
whole envelope's room under `MAX_FRAME_LENGTH` whatever the message names. A
writer with more to send splits it across frames with consecutive `seq`.

### 3.4 Correlation and reentrancy

Frames of different exchanges interleave freely on the one connection, correlated
by `id`. **A reader MUST NOT block on dispatch**: it MUST read the next frame
while a handler it started is still running, so a `Callable.Call` arriving while
a `Value.Expand` is outstanding is served rather than deadlocking against it.
That is not an optimisation — it is the only reason a synchronous, blocking
request is representable at all, and §6.7 depends on it.

Ordering is guaranteed **per channel** (§8) and nowhere else. Two requests sent
back to back may be answered in either order, and a runtime that needs ordering
between two operations sequences them itself.

### 3.5 A refused frame is terminal

A frame a reader refuses — a length over the maximum, a truncated prefix, meta
that is not the typed frame of an envelope, an unknown `type`, a payload its
message's schema rejects, a `Channel.Data` whose `byteLength` disagrees with the
frame, an id or a session that names nothing — is **terminal for that carrier
instance**.

- On the **framed** carrier, the reader MUST close the connection. Every in-flight
  call on it fails with `ERR_CONTROLLER_HOST_EXITED`, and the host is **never
  restarted silently**: a kernel that restarts it would hand back a controller
  with none of the state the failed calls assumed.
- On the **ABI** carrier there is no connection and no host to exit. The refusal
  is still terminal: the controller is marked unusable, every in-flight call
  fails, and no further call is made into it. **The carrier-neutral code naming
  that refusal is owed by the step that implements the ABI carrier** — both codes
  this specification defines name a host, and the ABI carrier has neither, so
  this generation ships no spelling for it rather than inventing one here.

A runtime MUST NOT attempt to resynchronise a stream after a refused frame. The
length prefix makes the next frame's boundary computable, which is precisely what
makes "skip it and carry on" look reasonable — and it is not: a peer that sent
one frame this protocol does not permit has already disagreed about the contract,
and every later frame from it is a guess.

### 3.6 The carrier process's own output, and a controller's

These are two different things, and conflating them is the obvious implementer
error:

- **The host process's own stdout and stderr** — whatever the process writes for
  its own reasons, including a runtime's own crash dumps — is **forwarded
  unchanged** by the kernel that started it, to the kernel's own stdout and
  stderr. It is not framed, not attributed to any resource, and carries no
  session.
- **A controller's `stdin`, `stdout` and `stderr`** are three **well-known
  channels** over §8's primitive, opened per instance with the `purpose` values
  `stdin`, `stdout` and `stderr`. They belong to a session and a resource; they
  are flow-controlled; and they are what a module writing to standard output as
  *data* uses. Writing diagnostics there is forbidden — that is `Log.Write` (§9.1).

**The protocol MUST NOT be carried over the process's own standard streams.** A
dedicated channel is what keeps the two apart: a controller's incidental
`println!` would otherwise corrupt the frame stream.

## 4. Session

### 4.1 `Session.Hello`

The first message on a carrier instance, before any session exists. The kernel
end states the generation it speaks and its own identity; the controller end
answers with the generation it speaks and its own — its telo version, and the
name and version of the runtime it runs on.

A generation mismatch MUST be refused with `ERR_CONTROLLER_HOST_INCOMPATIBLE`,
naming both generations. A runtime MUST NOT negotiate down to an older
generation: a generation is a complete message set, and half of one is not a
protocol.

### 4.2 `Session.Open` and `Session.Close`

`Session.Open` mints a session for one kernel instance; every later envelope on
that instance's behalf carries its id. `Session.Close` ends it — by then every
instance created in it has been destroyed and every frame unwound, so the
controller end is releasing bookkeeping rather than running work. It is
`reentrant` all the same, because an inverse that runs late may still reach back.

A kernel MUST NOT reuse a session id within a carrier instance, and a controller
end MUST refuse an `Session.Open` naming one already open.

## 5. Lifecycle

This section carries the capability entry points that build, start and tear an
instance down, and the revertible effects they return. What the lifecycle MEANS —
that `init()` allocates and `run()` performs the observable I/O, that frames open
per lifecycle entry and unwind LIFO — is `kernel/specs/revertible-effects.md`'s.

### 5.1 Binding and creating

`Controller.Bind` obtains the controller a kind names and learns two things: the
**entry points** it implements, and the controller-to-kernel operations it
**requires**. The second is what §0.2's refusal is decided on. Selecting the
candidate and fetching its bytes happen before this message and are not part of
the protocol.

`Controller.Create` builds one instance. Its request carries the resource's own
manifest document as a typed frame, the handle the kernel minted for the
instance, the owner prefix a controller composes sub-resource ids under, the
identity of the module that declared the resource and of the module that declares
the controller, and the resolved invocation contract. Its response narrows the
bound entry points to what this instance actually carries, and — for a
`Telo.Sink` — reports the sink's identity, its fan-out level and whether it can
be drained synchronously, which the kernel needs before it may write to it.

A controller MUST NOT perform observable I/O in `Controller.Create` or
`Controller.Init`. The protocol cannot enforce that, and states it because a
runtime's retry semantics rest on it: a failed `init` unwinds and **discards the
instance**, so a retry sends a fresh `Controller.Create`.

### 5.2 Snapshot, run, provide, destroy

- `Controller.Snapshot` reads **configured** state — what the resource was
  declared with, as the kernel republishes it. Observed state is pushed instead
  (§5.5).
- `Controller.Run` starts a `Telo.Service` or runs a `Telo.Runnable`. It carries
  an invocation context, so a boot run cancelled by a signal reaches the
  controller's own cancellation token.
- `Controller.Provide` reads a `Telo.Provider`'s value.
- `Controller.Destroy` releases the instance, after every frame has unwound.

A `Telo.Mount` declares **no entry point of its own**: it is reached by whichever
service mounts it, through `Ref.Resolve` (§7.1) and the target kind's own entry
points. A `Telo.Type` has no runtime instance at all and names nothing here.

### 5.3 Sinks

A `Telo.Sink` is written to **directly**, never through a dispatch:
`Controller.SinkWrite` per record, `Controller.SinkFlush` to drain,
`Controller.SinkFlushSync` to drain before returning, `Controller.SinkClose` at
teardown. Per-record dispatch would be far too slow for a logging hot path and
would emit telemetry from inside the telemetry path.

`Controller.SinkWrite` is a **notification**: a sink MUST NOT fail a write back
to the runtime. A sink failure is counted out of band (`Log.Drop`, §9.1) and
never propagated to whatever was being logged.

`Controller.SinkFlushSync` is the protocol's one **synchronous
kernel-to-controller** message, and a no-op at a sink that reported
`syncFlushable: false`. Synchronous flush is a sink capability, not a runtime
guarantee: a kernel MUST NOT block on a sink that cannot be drained synchronously
— on a single-threaded runtime that is a deadlock rather than durability.

### 5.4 Effects

**`init()` and `run()` RETURN what undoes them**, and a runtime provides no
`teardown()`. Across this boundary the chain is **controller-owned** — each step's
body and each inverse is a closure only its author can run — so the kernel holds
handles and drives them:

1. `Controller.Init` / `Controller.Run` answer with a **chain**: an id the
   controller minted and one entry per step, in order, carrying only the step's
   `reason`. The chain is lazy; nothing has run.
2. The kernel executes it step by step with `Effect.Perform`, threading each
   step's `result` into the next step's `input`. The kernel MUST NOT retain or
   interpret a result beyond that.
3. As the body produces each inverse, the controller sends `Effect.Register` —
   the reason, and its own handle for the inverse — and receives the effect's
   kernel id. **Registration is pushed as it happens, not returned at the end**,
   which is exactly what makes the iterator body form work: a body that fails
   between allocations has already registered the completed ones, and the
   frame unwinds precisely what happened.
4. At teardown the kernel sends `Effect.Revert` per registered effect, LIFO within
   a frame, innermost frame first. It never looks inside an inverse.
5. `Effect.Dispose` is the controller asking for one effect's inverse to run now
   and leave its frame — idempotent, unordered and never cascading. A refusing
   inverse is raised to the caller here, unlike at teardown, because a disposal
   has one.
6. `Effect.Run` is the imperative door: execute a chain in place against the
   resource's current frame, for an allocation whose lifetime is an *operation*
   rather than the resource. While it is outstanding the kernel is sending
   `Effect.Perform` back, which is why both are reentrant.

A chain id is minted by the controller end and is unique within its instance. An
inverse handle is likewise the controller's.

### 5.5 Holds, status, events

`Hold.Acquire` holds the kernel open; the application exits at zero holds. The
kernel registers **nothing** for a hold: which frame owns it is a fact only the
caller has, so the caller places `Hold.Release` in a chain itself. Registering at
acquisition would put every hold on whichever frame happened to be open and would
double-register wherever a caller also states it.

`Status.Set` publishes **observed** state: it replaces rather than merges, is
sticky until teardown, is validated against the kind's `status:` block, and is
illegal before the resource has started — `init()` performs no I/O, so there is
nothing observed to report there.

`Event.Emit` puts a lifecycle or debug event on the kernel's event bus. A runtime
MUST NOT emit one per effect; recovery failures surface through the resource's
logger and the aggregate error instead.

## 6. Invocation

### 6.1 The two directions

`Controller.Invoke` is the kernel calling a `Telo.Invocable`'s entry point. By the
time it is sent, inputs have been validated against the resolved `inputType`; the
result is validated against `outputType` on the way back. Neither validation is
the controller's, and a controller MUST NOT assume it can skip its own checks
because of them — a kind that declares no contract is validated against nothing.

`Dispatch.Invoke` is a controller asking the kernel to dispatch by name;
`Dispatch.InvokeResolved` does the same at an instance the caller already
resolved, so the invocation keeps the target's identity for tracing and error
wrapping. `Dispatch.Run` runs a `Telo.Runnable` or starts a `Telo.Service` by
name.

**Every dispatch crosses back to the kernel.** A controller holding a live
instance MUST NOT call its entry point directly and escape the chokepoint: the
invocation contract, execution zones, tracing, observed state and durable
journaling all hang off it, and a dispatch that bypasses it is silently outside
all five.

### 6.2 The invocation context

Every dispatch carries a context: the cancellation source it is scoped to, the
invocation and parent invocation ids, the trace id, the open zone stack and the
durable step path. One member of the in-process context deliberately does **not**
cross: the durable run handle, which is a live object with methods. The kernel is
a pure conduit for it — it carries it and never calls it — so a second runtime
threads a handle it owns rather than deserializing this one.

### 6.3 Cancellation

`Cancellation.Create` mints a writable source for a trigger to own;
`Cancellation.Cancel` cancels it, or arms it to trip at an absolute instant (a
deadline is not a separate concept); `Cancellation.Dispose` releases a pending
deadline and its subscribers without cancelling.

`Cancellation.Signal` is the kernel **pushing** a cancellation to a controller
that observes the token. A token is polled between units of work, so a round trip
per poll would put the carrier inside every loop; the controller end keeps a local
mirror, seeded from the context it was handed and updated by this notification,
and answers its own polls from it. A cancelled token raises
`ERR_INVOKE_CANCELLED`, which is a **signal**: anything that catches rethrows it.

### 6.4 Zones

`Zone.Open` opens the zone a resource's slot declares and returns the derived
context plus the minted entry; `Zone.Close` ends that region with an outcome. A
scope on the controller's side becomes a pair here because the carrier cannot see
an async boundary the controller crossed — the controller is responsible for
sending `Zone.Close` on every path out of the region, its own failure path
included.

`Zone.Require` and `Zone.Find` are the same lookup with different failure modes —
a refusal with `ERR_ZONE_REQUIRED`, and absence as a valid answer — and are two
messages for that reason. `Zone.List` answers the undeclared case: every ambient
zone correlated on an instance the caller holds. `Zone.Attributes` returns what
each open zone DECLARES about its contents, from the closed vocabulary in
`sdk/zone-attributes/`, each value being the author's own reason.

All four resolve against kind schemas and annotations the kernel holds, which is
why they are kernel round trips rather than reads off the context the controller
already has. All four are synchronous: a controller asks them to decide what to
do next.

### 6.5 Spans

`Span.Open` opens a trace span at an inbound boundary and returns the child
context to thread into the handler; `Span.Settle` closes it with an outcome.
`parked` is its own outcome and not a flavour of failure — a suspended invocation
neither succeeded nor failed.

A kernel with tracing off MUST still answer `Span.Open`, returning the base
context unchanged, so a controller has one code path whether or not a sink is
attached.

### 6.6 Detached work

`Dispatch.Detach` opens a detached task: the caller's cancellation and trace scope
are replaced with the uncancellable root, so request teardown cannot abort the
work and it does not nest under the request's trace. The task is tracked against
the resource and drained, under a bound, when the resource tears down.
`Dispatch.DetachSettle` reports that it ended. A failure goes to the event bus —
there is no caller to raise it to — and either way the drain stops waiting.

**A drain is not an inverse**: it waits for in-flight work and then abandons it,
where an inverse either succeeds or refuses, so it is not an effect and does not
unwind on a frame.

### 6.7 Callables, and reentrancy

`Callable.Call` is the kernel calling a `Telo.Callable` synchronously, with its
arguments as a typed frame keyed by parameter name. It is the one message that is
both **synchronous** and **kernel-to-controller**, and it is the reason §3.4
forbids a reader to block on dispatch.

The shape it exists for: a controller sends `Value.Expand` (§7.4) and blocks; the
kernel evaluates the expression and reaches a module function whose controller
lives at the very end that is blocked; the kernel sends `Callable.Call` on the
same carrier instance, and the controller end **MUST serve it** while its own
request is outstanding. A runtime that serialises its reads deadlocks here, and
nothing in a manifest shows why.

A `Telo.Callable`'s `call` is synchronous by contract: a controller MUST NOT make
it await anything, and a runtime MUST NOT make `Callable.Call` a door back into
asynchronous work.

## 7. Resolution & schema

### 7.1 References

`Ref.Resolve` turns a reference slot's value — a reference sentinel, an inline
definition, or a normalized kind/name pair — into a live instance. `expects`
names the contract the slot wants, so a mis-wire says what was missing rather
than what was found.

The response reports whether the instance is **local** and lists the entry points
reachable through it. Where the target's controller is bound in the same carrier
instance and the same realm, a runtime MAY hand over the live object; otherwise
the handle is a **proxy** exposing exactly those entry points and nothing else. A
proxy MUST NOT expose a controller's own methods beyond its kind's capability
entry points: a controller reaching into another's private surface is a coupling
the realm boundary is there to prevent, and one that would work in process and
fail across it.

`Ref.Ensure` is the inverse operation: a slot value in, a reference out,
registering an inline definition into the declaring module's scope on the way. It
is a separate message from `Ref.Resolve` — the two have different failure modes,
and a controller that wants the target's identity for a dispatch wants this one.

`Ref.Declaration` reads the manifest a name was DECLARED with, resolved in the
context that owns the asking resource. A declaration is readable whether or not
the target has been constructed, which is what lets a slot wanting a fact about
its target avoid an ordering edge — and what lets a resource read a slot pointing
at itself.

### 7.2 Schemas

`Schema.Validate` validates a value against an author-written schema through the
runtime's own engine, so its formats and `x-telo-*` keywords apply and one
process never holds two disagreeing validators. `Schema.Compile` compiles once
and `Schema.Check` validates per invocation against the result — the shape a
controller with a per-request schema wants. A compiled validator lives as long as
the instance that compiled it.

`Schema.Resolve` resolves a named type reference to its schema, in the scope of
the module that WROTE the name — never to whichever loaded module registered a
type of the same name.

`Schema.Check` answers with a verdict and its issues; `Schema.Validate` raises
`ERR_INPUT_INVALID`. A caller asking a question gets an answer; a caller
demanding validity gets a refusal.

### 7.3 Plain-encoded values

`Value.Decode` reads a value that arrived from OUTSIDE Telo — a transport body, a
query or header map — as the schema it was promised says it holds: every slot
declaring an instance value type with a plain encoding has its text decoded, and
every declared scalar comes back in its CEL form. Text a slot's encoding does not
read is refused with `ERR_INPUT_INVALID`, naming the slot and the form.

### 7.4 Compiled values

A compiled CEL value is **code**, and code is owned by the side that compiled it.
A controller never evaluates a Telo expression and never receives one to
evaluate.

In every manifest document that crosses this boundary, a node holding a compiled
value is written as the JSON object

```json
{ "$teloCompiled": "/pointer/to/this/node" }
```

— an ordinary string-keyed map in the typed frame, needing no tag and no addition
to that vocabulary's closed tag set. A controller reading its own manifest sees a
placeholder wherever an expression stands, which is also what stops it treating an
unevaluated expression as a literal.

`Value.Expand` evaluates the compiled value at a pointer into the instance's
manifest, under the resource's own scope plus whatever extra bindings the
controller supplies as typed frames — the handler scope a transport binds, the
per-item bindings a composer binds. The pointer `""` expands the whole document.

It is **synchronous and reentrant**: synchronous because a controller expands a
value in order to act on it, and reentrant because the expression may reach a
module function whose controller is at the blocked end (§6.7).

## 8. Channels

A **channel** is a one-way, flow-controlled byte stream between the two ends,
identified by a `channelId` unique within its session. Its four messages are
`Channel.Open`, `Channel.Data`, `Channel.Credit` and `Channel.Close`, and all four
are **notifications** — a channel is a stream, not a request/response exchange,
and a per-chunk acknowledgement would halve its throughput to no purpose.

**Ordering is guaranteed within a channel.** `Channel.Data` frames of one channel
MUST be delivered in `seq` order, `seq` starting at `0` and increasing by one per
frame, and they MUST sit between that channel's `Channel.Open` and
`Channel.Close`.

**Flow control is credit in bytes.** `Channel.Open` grants the initial credit;
`Channel.Credit` grants more. A sender MUST NOT send a `Channel.Data` whose
`byteLength` exceeds its outstanding credit, and each frame consumes credit equal
to its `byteLength` — framing bytes are not counted, so a receiver's budget is a
budget in payload rather than in a number it has to derive. A receiver MUST grant
credit as it consumes, and MUST NOT grant unbounded credit: a channel nobody
bounds is a buffer nobody bounds.

`Channel.Close` ends the channel. An `error` member closes it **abnormally**: the
reader sees a failure rather than end-of-input, which is what tells a truncated
stream from a finished one. A channel whose session closes is closed with it.

`purpose` says what a channel carries:

| `purpose` | carries |
| --- | --- |
| `stdin` / `stdout` / `stderr` | a controller's own standard streams (§3.6) |
| `stream` | one `Telo.Stream` value crossing as part of a payload |
| `runtime.stdin` / `runtime.stdout` / `runtime.stderr` | a child manifest's streams (§9.2) |

A `Telo.Stream` value is `live`: it is consumed by reading, so it exists exactly
once and MUST NOT be written into a typed frame. It crosses as a channel, named
by its `channelId` at the slot where the value stands.

## 9. Host facilities

### 9.1 Logging

`Log.Write` emits one record, as a notification. The kernel stamps the resource's
identity, its module, its import-alias scope and the active span's trace and span
ids; a controller never passes those. A controller emits diagnostics **only**
through this — writing to standard error for diagnostic purposes is forbidden,
while writing to standard output as *data* is a separate and legitimate concern
(§3.6).

`Log.Threshold` is the kernel telling a controller the effective severity
threshold for its logging scope, at creation and whenever it moves. A controller
answers its own `enabled` from this. A round trip per call would make the cheapest
question in the system the most expensive one, and a controller that cannot ask
cheaply builds records it then discards.

`Log.LevelFor` resolves a sink's declared level to a severity number, falling back
to the effective scope threshold when the sink declares none. `Log.Drop` counts
dropped records against a sink, taking a count so a sink that loses a whole batch
is not undercounted to one per failure.

A sink never attaches itself. The kernel attaches exactly the instances the root
application's `logging.sinks` / `tracing.sinks` list, and this protocol carries no
message for attaching one.

### 9.2 Child manifests

`Runtime.Run` starts a child manifest. **The kernel starts it as its own session**
— served by the same carrier instance — and answers with the child's run id, that
session's id, and the three channel ids carrying its standard streams. Values for
the child's declared inputs are supplied **by the name the child declares**,
never by the environment variable it binds them to: the child's `env:` mapping is
its own business, and a raw environment map lets a caller set keys the child never
declared.

`Runtime.Started` is sent once every one of the child's boot targets has been
dispatched — so a server it declares is listening — and is never sent for a child
that exited first. `Runtime.Exited` is sent when it has finished, including after
a cancel, by which time both output channels have closed. `Runtime.Cancel` stops
it and tears it down; it is idempotent and safe after the child has finished.

`Runtime.Check` runs the static-analysis pass over a manifest and its import
graph. **It is answered by the analyzer of the kernel's own telo generation**, and
a runtime MAY run that analyzer inside the controller host — an analyzer is not a
kernel, and **no kernel ever runs inside a host**. A manifest that fails to load
is an answer (`loadError`), not an error.

Both are reentrant: a child's output is flowing on its channels while the request
that started it is still settling, and `Runtime.Check` may reach back for module
files.

### 9.3 Module files and the environment

`Module.File` resolves a module-relative reference against the module that
DECLARED the resource — a path its author wrote. `Module.ControllerFile` resolves
one against the module that declares the CONTROLLER — the file ships with the code
asking for it. `Native.File` resolves a platform-specific file by the logical name
a `native:` entry declares. All three answer with a URI rather than a filesystem
path, because a path is only what one kind of host happens to hold, and all three
are asynchronous because a published module's layers are fetched on first use.

`Env.Read` reads one environment entry in the resource's module scope, one name at
a time. A map handed over at creation would ship everything a controller never
asks for across a process boundary, and a key the application binds to a declared
variable or secret MUST read as absent here — that is the same guardrail a
kernel applies in process.

## 10. Error codes

A failed request answers with an `error` payload (§3.2) carrying a `code`, a
`message` and optional structured `data`. The table below is the set of codes
**this protocol defines or re-raises**; a controller's own declared `throws:`
codes cross unchanged and are not listed here.

| code | raised when | carried by |
| --- | --- | --- |
| `ERR_CONTROLLER_HOST_INCOMPATIBLE` | the two ends report different protocol generations, or a controller requires an operation this generation does not name, or an artifact declares a generation the kernel does not implement | `Session.Hello`, `Session.Open`, `Controller.Create` |
| `ERR_CONTROLLER_HOST_EXITED` | the controller host died, or a refused frame closed the connection; every in-flight call fails with it | any request in flight |
| `ERR_INPUT_INVALID` | a value did not satisfy the schema it was promised against | `Dispatch.Invoke`, `Dispatch.InvokeResolved`, `Schema.Validate`, `Schema.Check`, `Value.Decode` |
| `ERR_OUTPUT_INVALID` | a result did not satisfy the resolved `outputType` | `Dispatch.Invoke`, `Dispatch.InvokeResolved`, `Controller.Provide` |
| `ERR_CONTRACT_UNRESOLVABLE` | a declared contract resolved to no schema at all | `Controller.Create`, `Dispatch.Invoke`, `Dispatch.InvokeResolved`, `Schema.Resolve` |
| `ERR_SCHEMA_PROJECTION_UNRESOLVED` | a projected schema could not be resolved | `Schema.Resolve` |
| `ERR_FUNCTION_FAILED` | a module function raised | `Callable.Call`, `Value.Expand` |
| `ERR_INVOKE_CANCELLED` | the invocation's token was cancelled — a **signal**, rethrown by anything that catches | `Controller.Invoke`, `Controller.Run`, `Dispatch.Invoke`, `Dispatch.InvokeResolved`, `Dispatch.Run` |
| `ERR_DURABLE_SUSPENDED` | a durable run parked — a **signal**, rethrown by anything that catches | `Controller.Invoke`, `Dispatch.Invoke`, `Dispatch.InvokeResolved` |
| `ERR_ZONE_REQUIRED` | a required zone was not open | `Zone.Require` |
| `ERR_EFFECT_SCOPE_CLOSED` | an effect was registered against a scope that has fully unwound | `Controller.Init`, `Effect.Perform`, `Effect.Register`, `Effect.Run` |
| `ERR_OBSERVED_STATE_BEFORE_START` | observed state was reported before the resource started | `Status.Set` |
| `ERR_OBSERVED_STATE_UNDECLARED` | observed state named a field the kind's `status:` does not declare | `Status.Set` |
| `ERR_OBSERVED_STATE_INVALID` | observed state did not satisfy the kind's `status:` | `Status.Set` |
| `ERR_RESOURCE_NOT_INVOKABLE` | a dispatch named a resource with no invocable entry point | `Dispatch.Invoke`, `Dispatch.InvokeResolved` |
| `ERR_SPAN_ATTRIBUTE_INVALID` | a span attribute name was malformed | `Span.Open` |
| `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE` | an interpolation hole held a value CEL cannot convert to text | `Value.Expand` |
| `ERR_HOST_PATH_RELATIVE` | a computed value at a host-path slot was not absolute | `Value.Expand` |
| `ERR_MODULE_FILES_UNAVAILABLE` | a module file could not be staged or is unpinned | `Module.File`, `Module.ControllerFile` |
| `ERR_NATIVE_FILE_UNAVAILABLE` | no `native:` entry of that name matches the host, or its staged file could not be brought to its pin | `Native.File` |

`ERR_DURABLE_SUSPENDED` and `ERR_INVOKE_CANCELLED` are **signals, not errors**.
Both ends MUST re-raise them out of any construct that catches — a `try` step, a
`catches:` block, a retry policy — and a runtime MUST NOT count either toward a
kind's declared `throws:`.

There is deliberately no code for "a peer sent something this protocol does not
permit". On the framed carrier that refusal closes the connection and the
in-flight calls fail with `ERR_CONTROLLER_HOST_EXITED` (§3.5); on the ABI carrier
its name is owed by the step that implements that carrier.

## 11. Conformance

Conformance vectors live at **`sdk/controller-protocol/vectors/`** — `framing.json`,
`messages.json`, `sequences.json` and `carrier-equivalence.json` — and **they are
normative**. Each opens with a `$comment` declaring its tables so, as
`kernel/specs/durable-execution.md` §6.6 does for the typed frame. A runtime's
tests MUST execute all four, with no skip path: a row class a runner cannot
execute is a failing test, never a silent zero.

A conforming runtime:

1. carries every message in §2, in the direction it declares, on every carrier it
   implements — and refuses a controller needing an operation the running
   generation does not name, at `Controller.Create`, with
   `ERR_CONTROLLER_HOST_INCOMPATIBLE` (§0.2);
2. reports one generation in the handshake for both carriers and refuses a
   mismatch rather than negotiating down (§0.3, §4.1);
3. encodes every value as the typed frame of `kernel/specs/durable-execution.md`
   §6, and invents no second encoding (§1.3);
4. frames exactly as §3.1 says, refuses a `length` over `MAX_FRAME_LENGTH` before
   reading the body, and refuses a `Channel.Data` whose `byteLength` disagrees
   with the frame;
5. carries `session`, `id`, `type` and the payload on the envelope, partitions ids
   by parity, and sends no response for a notification (§3.2);
6. reads without blocking on dispatch, so a reentrant request is served while a
   synchronous one is outstanding (§3.4, §6.7);
7. treats a refused frame as terminal for the carrier instance, never
   resynchronising and never restarting a host silently (§3.5);
8. keeps the carrier process's own output separate from a controller's standard
   streams, and never carries the protocol over the process's own streams (§3.6);
9. drives an effect chain as §5.4 states — lazy, stepwise, inverses registered as
   they are produced, reverted LIFO by handle, never interpreted;
10. dispatches every invocation through the kernel's chokepoint, in both
    directions (§6.1), and carries no durable run handle across (§6.2);
11. pushes cancellation rather than requiring a poll to cross (§6.3), and
    re-raises both signals out of everything that catches (§10);
12. owns compiled values kernel-side, writes a compiled node as
    `{"$teloCompiled": …}`, and evaluates no Telo expression on the controller end
    (§7.4);
13. bounds every channel by credit in bytes, delivers `Channel.Data` in `seq`
    order, and distinguishes an abnormal close from end-of-input (§8);
14. starts a child manifest as its own session and runs no kernel inside a
    controller host (§9.2);
15. executes all four vector files, in every language that implements a carrier.
