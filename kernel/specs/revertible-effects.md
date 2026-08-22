---
description: "v1.0 spec: revertible effects — the per-resource inverse accumulator, its frames, LIFO recovery, the iterator form, early disposal, and the failure rules for a failed init and for teardown"
---

# Telo Revertible Effects Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines the accumulator a
runtime keeps behind `ctx.effect`, when frames open and unwind, in what order
inverses run, and what a runtime MUST do when an inverse refuses.

It is normative for the same reason the invocation contract and execution zones
are: a controller written against this surface must behave the same on any
runtime that hosts it, and a lifecycle guarantee enforced by one implementation's
tests is not a contract. Tracking rules in particular diverge silently — nothing
in a manifest shows whether a runtime unwound a frame — so the Rust kernel
implements this spec rather than reading the Node kernel's source.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **MAY** are per
RFC 2119.

**In scope:** the effect model, frames, recovery order, the two body forms, early
disposal, and the failure rules.

**Out of scope:** what `init()` and `run()` DO (see the resource lifecycle),
the detached-task drain (it waits for in-flight work rather than undoing
anything — §7), and `teardownPriority`, which orders resources against each other
while this spec orders one resource's own effects.

## 1. What an effect is

An **effect** is a forward action paired with the **inverse** that undoes it,
produced by the action itself. `ctx.effect(reason, body)` returns a **chain**;
`.effect(...)` extends it, threading each step's result into the next body.

**`init()` and `run()` RETURN the chain, and a runtime MUST NOT provide a
`teardown()`.** That is the load-bearing rule of this spec, not a style
preference: an optional second method is one an author can forget, and a
mechanism that exists to stop something being forgotten cannot itself be
forgettable. Returning it makes the signature ask the question, at the one place
every controller already writes.

A runtime MUST NOT interpret an inverse. It is an opaque closure; only its author
knows what it undoes.

**A chain MUST be lazy**: nothing runs until the runtime executes what the
lifecycle method returned. Sequencing and recovery are then the runtime's, and
the chain is a description rather than a side effect — which is what a second
runtime executes rather than reimplements.

**A chain MUST NOT be a thenable** in a runtime whose `async` functions unwrap
one on return (JavaScript), or the runtime would receive the chain's last result
instead of the chain. A runtime MUST provide an explicit way to execute a chain
in place (`perform()`), which is the imperative door §2 requires for
operation-scoped work.

**`result` is pass-through.** A runtime MUST hand each step's result to the next
step's body and to the caller of `perform()`, and MUST NOT retain or interpret
it. It exists so an inverse closes over what the forward action produced.

## 2. Frames

The accumulator is a **stack of frames**. A runtime MUST open a frame:

- when the resource's context is constructed, covering `create()`;
- at each `init()`;
- at each `run()`.

A runtime MUST NOT open a frame per invocation. A chain executed with
`perform()` MUST remain usable from `invoke()`, and what it registers there MUST
join the innermost open frame. A scope that ends when a call returns is the
controller's own `try`/`finally`; what needs tracking at a call site is the
allocation that OUTLIVES the call (a hold taken per durable run), and a frame
closing at return would release it at exactly the wrong moment. Such an effect
MUST be disposed by the operation that made it (§5), or it accumulates for the
resource's lifetime.

An effect registers onto the frame open **at the moment its inverse is produced**,
not the frame open when its body started.

## 3. Recovery order

Unwinding a frame runs its inverses **last-in-first-out**, then closes it.
Unwinding a resource runs its frames innermost-first. Tearing a resource down IS
unwinding it; there is nothing else to call.

Ordering follows from this and MUST NOT be a separate rule. A subclass that
extends its parent's chain (`super.init(ctx).effect(…)`) therefore unwinds in the
reverse of construction by construction — the case that used to be an
`init()`/`teardown()` pair each half of which restated the other's order.

## 4. The two body forms

`body` MUST be accepted in either form:

- **Single**: resolves to `{ result, inverse }`. The inverse is registered when
  the body resolves, and is **optional** — a step that allocated nothing that
  outlives a failure returns its result alone, and a runtime MUST register
  nothing for it. A chain is the sequencing structure for lifecycle work as well
  as the record of what to undo, so a step that only orders is a normal shape;
  requiring a no-op closure would make "nothing to undo" indistinguishable from
  "the author forgot", which is the distinction this mechanism exists to keep.
- **Iterator**: an async generator yielding one inverse per completed step and
  returning the result. Each yielded inverse MUST be registered at the moment it
  is yielded, so a body that throws between steps leaves exactly the completed
  steps' inverses on the frame.

The single form is the degenerate iterator; a runtime MAY implement one over the
other. `result` is **pass-through**: a runtime MUST return it to the caller and
MUST NOT retain or interpret it.

While a resource's scope is unwinding, a runtime MUST stop an in-flight iterator
body at its next step boundary rather than letting it allocate into a frame that
is going away, MUST allow the generator to run its own `finally`, and MUST leave
what already yielded on the frame for the unwind in progress. This is what bounds
a long `init()` interrupted by a shutdown mid-boot.

## 5. Early disposal

`ctx.effect` MUST return a `dispose()` that runs that effect's inverse
immediately and removes it from its frame. `dispose()` MUST be idempotent, and a
disposed effect MUST be skipped when its frame unwinds.

Disposal is **not** ordered: an effect MAY be disposed while effects registered
after it remain. A frame is a recovery order, not a dependency graph. A runtime
MUST NOT cascade disposal to effects registered later — a `run()` that takes a
hold before it opens a socket must be able to release the hold without closing
the socket, which is the case early disposal exists for. Disposing something a
later effect depends on is the author's error.

A failing inverse during an explicit `dispose()` MUST be raised to the caller:
unlike an unwind, a disposal has one.

## 6. Failure rules

**6.1 A failed `init()` recovers, and the instance is discarded.** When `init()`
throws — or a step of the chain it returned does — a runtime MUST unwind the
resource's frames before the resource is retried, and MUST then discard the
instance so a retry constructs a new one. Inverses restore state OUTSIDE the
instance; a controller's own half-built fields are beyond their reach, so
re-entering the same object would leave the dirty retry this mechanism exists to
remove.

**6.1.1 A DEFERRAL is not a failure.** Where a runtime's initialization loop
signals "this resource's turn has not come" by throwing (Node:
`ERR_LOCAL_REF_PENDING` / `ERR_CROSS_MODULE_REF_PENDING`), the runtime MUST
unwind the frame but MUST NOT discard the instance: re-running construction would
repeat effects that construction, not initialization, performed — re-registering
an import's alias, reloading its module, re-registering a template's children.

**6.2 An inverse that refuses during pre-retry recovery withholds the resource.**
The runtime MUST NOT retry it, and MUST report a failure naming both the `init()`
error and the refusing inverse. Retrying from a state that could not be rolled
back is worse than not retrying.

**6.3 An inverse that refuses at teardown aggregates and unwinding continues.**
A runtime MUST collect such failures and report them together (Node:
`ERR_EFFECT_RECOVERY_FAILED`), and MUST NOT abandon the rest of the cascade — one
refusing inverse must not strand the resources pinned to tear down last.

**6.4 A failed `run()` unwinds its own frame** and MUST leave the `init` frame
intact: the resource is still constructed and initialized, and only the run
failed.

**6.5 A scope that has fully unwound is CLOSED.** Unwinding every frame — at
teardown, or when a failed `init()` discards the instance — is terminal: a
runtime MUST refuse any further effect against that scope, and MUST refuse it
BEFORE running the forward body, so a late allocation cannot happen and then find
nowhere to record its inverse (Node: `ERR_EFFECT_SCOPE_CLOSED`). Accepting one
would record an inverse nothing will ever run, which is the silent leak this
mechanism exists to remove; the shape that produces it is a detached task still
settling after its resource was torn down.

**6.6 No per-effect events.** A runtime MUST NOT emit a lifecycle/debug event per
effect. Recovery failures surface through the resource's logger and the aggregate
error; one event per effect would swamp both the wire and the logging path.

## 7. What is not an effect

A **drain** — waiting under a bound for in-flight detached work and then
abandoning it — is not an inverse: it undoes nothing, and an inverse either
succeeds or refuses, so modelling a drain as one would report an abandoned
background task as a recovery failure. A runtime MUST keep it separate and SHOULD
run it after the resource's frames have unwound.

A **hold** is an effect, but a runtime MUST NOT register it when it is acquired:
which FRAME owns a hold is a fact only the caller has — `run()`'s hold belongs to
the run, a hold taken per operation inside `invoke()` belongs to that operation
and is disposed when it ends. `acquireHold` therefore returns the raw inverse and
the caller places it in a chain. Registering at acquisition would put every hold
on whichever frame happened to be open, and would register it twice wherever a
caller also states it as an effect.

**An inverse pairs with a forward action that HAPPENED.** A runtime MUST NOT
require, and a controller SHOULD NOT register, an inverse for something that may
be created later — a lazily-opened listener, a subscription nobody has asked for.
Such an allocation registers its own effect at the moment it is made (§2's
imperative form), which is what keeps a frame a record of what exists rather than
a set of slots reserved for what might.

## 8. Conformance

A conforming runtime:

0. executes what `init()` / `run()` return, provides no `teardown()`, and keeps
   a chain lazy and non-thenable (§1);
1. opens frames per §2, including the no-invocation-frame rule;
2. unwinds LIFO within a frame and innermost-first across frames (§3);
3. accepts both body forms, treats `inverse` as optional, and registers a
   generator's inverses per completed step (§4);
4. returns an idempotent, order-free `dispose()` (§5);
5. recovers and discards on a failed `init()` — but keeps the instance on a
   deferral — withholds on a refusing inverse, aggregates at teardown, and
   refuses effects against a scope that has unwound (§6);
6. keeps the detached drain outside the mechanism (§7).
