# Broadcast — PostgreSQL

`broadcast-postgres` carries [`broadcast`](https://hub.telo.run/module/oci/ghcr.io/telorun/broadcast/) channels over
PostgreSQL notifications, so a message published on one application instance
reaches the live subscriptions of every instance on the same database. It is the
PostgreSQL backend of the `Broadcast.Channel` abstract; the operations
(`Broadcast.Publish`, `Broadcast.Subscription`) and the delivery contract are the
`broadcast` module's.

```yaml
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  Broadcast: oci://ghcr.io/telorun/broadcast@<version>
  BroadcastPostgres: oci://ghcr.io/telorun/broadcast-postgres@<version>
---
kind: BroadcastPostgres.Channel
metadata: { name: cacheEvents }
connection: !ref db
name: cache_events
maxBytes: 1024
messageType: !ref CacheEvent
```

## Why use this

- **Reaches every replica** without a message broker: the database the
  application already has is the transport.
- **Delivered at commit.** A message published inside a `Sql.Transaction` on the
  channel's connection is delivered when the transaction commits and never when
  it rolls back, so a hint never announces a write that did not happen.
- **One listening connection per replica**, however many subscriptions and topics
  it serves.
- **Honest about loss.** When a replica's listening connection drops and comes
  back, every subscription on it receives a gap.

## Kinds

| Kind | Capability | What it is |
|---|---|---|
| `BroadcastPostgres.Channel` | Provider | A broadcast channel on a `Postgres.Connection`: `connection`, plus the abstract's `name`, `messageType` and `maxBytes` (at most 7999) |

## Documentation

- [The PostgreSQL channel](docs/postgres-channel.md) — the notification channel,
  the payload limit, transactional delivery, the listening connection and gaps
