---
sidebar_label: Controller Protocol
slug: /extend/controller-protocol
description: "What crosses between a Telo kernel and a controller: the closed set of operations, the two carriers that deliver them, and what a controller may and may not count on when the kernel running it is written in another language."
---

# The controller protocol

A controller you publish today will be loaded by kernels you have never seen, in
languages you did not write it for. What holds that together is a single contract
— the **controller protocol** — that says exactly which operations cross between
a kernel and a controller, in which direction, and what each carries.

The normative document is
[`kernel/specs/controller-protocol.md`](https://github.com/telorun/telo/blob/main/kernel/specs/controller-protocol.md); the
operations themselves are data, one JSON file per message under
`sdk/controller-protocol/messages/`. This page is the orientation: what the
protocol is for, what it deliberately leaves out, and the handful of rules that
decide whether your controller can be hosted at all.

## Two carriers, one set of messages

A controller reaches its kernel over one of two carriers:

- **In process, through the C ABI** — a native controller `dlopen`ed by the
  kernel that runs it.
- **Out of process, as framed messages** — length-prefixed binary frames over a
  dedicated channel, which is how a kernel in one language runs controllers
  written in another.

The important part is what the two have in common: **no operation exists on one
carrier only**. The ABI's next generation carries the protocol's messages rather
than being a contract of its own, so a controller's behaviour does not change
with how it happens to be loaded. Both carriers report the same generation number
in their handshake, and a mismatch is refused rather than negotiated down.

A peer that breaks the contract mid-session — a frame or message the protocol
does not permit — is not skipped: that carrier instance is finished, and every
call into it fails with `ERR_CONTROLLER_PROTOCOL_VIOLATION`. That is a different
fact from a host that exited (`ERR_CONTROLLER_HOST_EXITED`, which is also what the
kernel sees when an out-of-process host refuses a frame and closes its
connection) and from a peer that was never compatible
(`ERR_CONTROLLER_HOST_INCOMPATIBLE`).

## Writing a controller that can be hosted

The message set is **closed at a generation**. If your controller needs an
operation the protocol does not name, it cannot be hosted out of process, and the
kernel refuses the pairing with `ERR_CONTROLLER_HOST_INCOMPATIBLE` rather than
half-loading it.

In practice that rules out exactly one thing, and it is worth knowing why: **the
kernel's own module registry is outside the protocol**. Loading a module,
registering a kind or a definition, wiring an import, spawning a child evaluation
context, reading a manifest graph — none of those name a message. They are things
a kernel does natively over its own state, and no kernel ever runs inside a
controller host, so a controller that reaches for one has asked its host to be a
kernel.

Everything a controller normally does is in the set: building and tearing down an
instance, returning effect chains, holding the kernel open, reporting observed
state, dispatching to another resource, opening zones and spans, resolving
references and schemas, expanding a manifest's expressions, streaming bytes,
logging, running a child manifest, and reaching its own module's files.

## The rules that most often surprise people

**Dispatch always goes back through the kernel.** If you hold a live instance you
resolved from a `!ref`, do not call its entry point directly. The invocation
contract, execution zones, tracing, observed state and durable journaling all hang
off the kernel's dispatch chokepoint, and a direct call is silently outside all
five. Across a process boundary you could not do it anyway — what you hold is a
proxy exposing only the target kind's capability entry points.

**You never evaluate a Telo expression.** A compiled CEL value is code, and code
belongs to the side that compiled it. In a manifest crossing the boundary, every
unevaluated expression appears as a placeholder object, and you ask the kernel to
expand the one you need, supplying whatever extra bindings your handler scope
adds. That is also what stops a controller reading an unevaluated expression as a
literal string.

**Your standard streams are not the process's.** A controller's `stdin`, `stdout`
and `stderr` are three well-known flow-controlled channels belonging to your
resource and your session. The host process's own output — a panic message, a
runtime's warning — is forwarded separately and unchanged. Writing diagnostics to
standard error is still forbidden; that is what the logger is for. Writing to
standard output as *data*, the way a console module does, is a different and
perfectly legitimate thing.

**Cancellation is pushed, not polled.** You poll your token as often as you like:
it is a local mirror, seeded when the call arrived and updated by a notification.
A cancellation and a durable suspension are **signals**, not errors — anything
that catches must rethrow them, including your own `try`.

**A sink is written to directly.** A `Telo.Sink` never receives a dispatch, and a
sink write must not fail back into the runtime: a failure is counted out of band.
Synchronous flush is a capability you declare, not a guarantee the runtime makes
— say `false` and a kernel will not block on you.

## Effects across the boundary

`init()` and `run()` return what undoes them, and that survives the boundary
intact — but with a twist worth understanding. A chain is **yours**: the kernel
receives an ordered list of step reasons and a handle, and drives the chain one
step at a time, threading each result into the next. Each inverse reaches the
kernel **the moment your body produces it**, not when the step finishes. That is
what makes the generator form honest: a body that fails halfway has already
registered exactly the allocations it completed, and the frame unwinds precisely
those.

Everything else about effects — frames, LIFO recovery, disposal, what a failed
`init()` does — is
[`kernel/specs/revertible-effects.md`](https://github.com/telorun/telo/blob/main/kernel/specs/revertible-effects.md) and is
unchanged by which carrier you are on.

## Reentrancy, and the one deadlock to know about

Some requests are **synchronous**: you send one and block until it answers.
Some are **reentrant**: while one is outstanding, the other end may send you a
request, and you **must** serve it.

The two meet in one place. You ask the kernel to expand an expression and block.
The expression reaches a module function whose controller is you. The kernel sends
you that call on the same connection — and if your reader is blocked waiting for
your own response, nothing ever moves again. A conforming implementation never
blocks its reader on dispatch. If you are writing a carrier rather than a
controller, this is the rule to get right first; nothing in a manifest will tell
you that you got it wrong.

## Generations, and `abi=telo-4`

Generation `3` is the shape shipping today: JSON in ABI buffers, described only by
the ABI crate's layout. Generation `4` is the first one this specification
defines, and it is the generation in which the C ABI carries the protocol's
messages.

**Do not write `abi=telo-4` into a module yet.** The ABI carrier has not landed,
and a kernel meeting that declaration refuses it. Published `abi=telo-3`
candidates stay valid — specifying a new generation does not retire the old one.
