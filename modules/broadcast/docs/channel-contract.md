# The channel contract

Normative for every `Broadcast.Channel`. The contract is the message, the
delivery rules and the wire behaviour — not the JavaScript interface, so a
controller in another language implements the same channel.

## Delivery

- **At most once, to subscriptions live when it is sent** whose `topics` match.
  Nothing is stored; a subscription that was not connected never receives it.
- **Topics are matched by the subscriber.** Every replica receives every message
  on the channel and drops what none of its subscriptions match, so a topic is a
  filter, not a security boundary: any replica may read any topic on a channel it
  subscribes to.
- **Order is commit order.** Several publishes in one transaction arrive in call
  order. Nothing more is promised across publishers.
- **Gaps are reported.** A subscription whose backend connection dropped, or
  whose buffer overflowed, receives a gap meaning "messages may have been
  missed". A consumer that must stay correct re-reads its source of truth. The
  memory channel has no connection and never reports one; a subscription's own
  buffer overflow still does.
- **Transactions are a backend property.** A backend whose storage has
  transactions delivers a message published inside one when it commits and never
  when it rolls back; one without sends at once.
- **A backend names its reach.** The memory backend's is the running application:
  two memory channels naming one channel in one application are one channel, and
  an application sharing a process with another (`App.Instance`, `ctx.runtime`)
  never shares one with it. It needs a host that provides `ctx.kernelInstanceId`
  and refuses with `ERR_CONTROLLER_HOST_INCOMPATIBLE` otherwise.
- **A message is a hint, not data to trust.** It says that something happened;
  the consumer reads what changed from where it lives, under that reader's own
  authorization.
- **It is a low-rate bus.** A backend may serialize notifying commits, so a
  channel carries hints about writes, never a stream of data.

## The message

A channel carries messages of its `messageType`, stored as plain JSON (a live
value such as a stream is refused anywhere in the type). A message may carry a
`topic` ([grammar](topics-and-patterns.md)). On the wire a message is one JSON
object `{ "message": <plain JSON>, "topic": <string, absent when none> }` with
object keys sorted at every depth; its UTF-8 size is what `maxBytes` bounds, so
the topic counts. A receiver holds the message to `messageType` again — a
publisher on another version may have sent another shape — and reports a
payload that fails as `ERR_BROADCAST_MESSAGE_INVALID`.

## The channel's configuration

- `name` — the durable identity, `^[a-z][a-z0-9_]{0,47}$`. Two resources naming
  one channel on one backend are one channel, and two applications share a
  channel by naming it, which is a trust decision: either can then publish to the
  other's subscribers.
- `messageType` — the `Telo.Type` every message satisfies.
- `maxBytes` — the bound on a message's encoded size, topic included; default
  4096. A backend may refuse a larger bound.

## Codes

Raised by the operations, never by a backend:

- `ERR_BROADCAST_MESSAGE_TOO_LARGE` — the encoded message is over `maxBytes`;
  `data` carries `bytes` and `maxBytes`. Nothing was sent.
- `ERR_BROADCAST_UNAVAILABLE` — the backend could not send. The message may or
  may not have reached subscribers.
- `ERR_BROADCAST_MESSAGE_INVALID` — a received payload is not a message of the
  channel. Logged and reported to `onError`; never stops the subscription.

## What a backend implements

A backend is a kind extending `Broadcast.Channel` whose instance has three
methods, recognised by those methods alone (never by class, and it need not
import this module's code):

- `settings()` — `{ name, messageType, maxBytes }`. `broadcastSettingsOf` builds
  it from the abstract's fields.
- `publish(payload, ctx)` — send the payload text to every listener live at the
  moment it is sent. `ctx` is the calling invocation's context, from which a
  backend with transactions finds the caller's open transaction and delivers on
  commit. A transport failure is thrown as it arrives; the operation raises
  `ERR_BROADCAST_UNAVAILABLE`.
- `subscribe(listener)` — start receiving; resolves with a handle whose `close`
  ends it. The listener's `receive(payload)` is called for every payload sent on
  the channel (topic matching is the subscriber's), in the order the channel
  delivers them; `gap(reason)` says messages may have been missed.

`@telorun/broadcast` (the module's `exports.code`) exports these types,
`isBroadcastChannel`, `broadcastSettingsOf`, the payload codec and the topic
grammar for a backend that wants them. Another module's controller subscribes
directly by calling `subscribe` on a resolved channel.
