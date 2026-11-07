# Broadcast

`broadcast` — tell every running instance of an application that something
happened. An application publishes a small typed message, optionally under a
topic such as `rooms.42`, and every live subscription whose topic patterns match
invokes its `invoke` with its `inputs:` evaluated over `topic` and `message`.
Which transport carries the message is a separate resource the kinds name by
reference; `Broadcast.MemoryChannel` carries it within one running application.

```yaml
imports:
  Broadcast: oci://ghcr.io/telorun/broadcast@<version>
```

## Why use this

- **Reaches every replica.** A queue delivers each message to one worker; a
  broadcast reaches every subscription live when it is sent.
- **Topics without a resource each.** One channel carries any number of topics —
  a room, a record, a user — and a subscription lists patterns (`rooms.*`,
  `tasks.>`).
- **Typed.** A message is checked against the channel's `messageType` where it
  is published — statically for a literal, by the contract for a computed one —
  and again when it is received.
- **Failures stay contained.** A handler failing on one message is logged with
  its code, passed to `onError`, and the next message is handled.
- **Honest about loss.** A subscription is told when messages may have been
  missed (`onGap`), so it can re-read its source of truth.

## Kinds

| Kind | Capability | What it is |
|---|---|---|
| `Broadcast.Channel` | abstract | One named conduit messages are sent on |
| `Broadcast.MemoryChannel` | Provider | A channel within one running application |
| `Broadcast.Publish` | Invocable | Send a message, optionally under a topic |
| `Broadcast.Subscription` | Service | Run a handler for each matching message |

## Documentation

- [The channel contract](docs/channel-contract.md) — delivery rules and what a
  backend implements (normative)
- [Topics and patterns](docs/topics-and-patterns.md)
- [The subscription](docs/subscription.md)
- [Publishing in a transaction](docs/publishing-in-a-transaction.md)
- Backends: [`broadcast-postgres`](https://hub.telo.run/module/oci/ghcr.io/telorun/broadcast-postgres/) carries a channel
  across instances on one PostgreSQL database.
