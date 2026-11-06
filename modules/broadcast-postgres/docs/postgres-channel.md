# The PostgreSQL channel

`BroadcastPostgres.Channel` extends `Broadcast.Channel` and adds one field,
`connection`, a `Postgres.Connection`. The delivery rules are
[the channel contract](../../broadcast/docs/channel-contract.md); this page is what
the PostgreSQL backend does to keep them.

## The notification channel

A channel named `cache_events` is the PostgreSQL notification channel
`telo_broadcast_cache_events` (at most 63 bytes, which the abstract's 48-character
name limit guarantees). Two resources, or two applications on the same database,
naming one channel are one channel. Another client can send on it with
`pg_notify('telo_broadcast_<name>', <payload>)`; a payload that is not a message
of the channel is reported by every subscription as
`ERR_BROADCAST_MESSAGE_INVALID`.

## The payload limit

A notification carries at most 7999 bytes, so `maxBytes` may not exceed 7999. A
larger bound is `BROADCAST_MAX_BYTES_EXCEEDS_BACKEND` from `telo check`, and
`ERR_BROADCAST_MAX_BYTES_EXCEEDS_BACKEND` when the channel is created in an
application that was not checked. A message is a hint about a write, not the data:
send an identifier and let the consumer read the rest.

## Transactions

A publish inside an open `Sql.Transaction` on the channel's connection runs
`pg_notify` in that transaction, so PostgreSQL delivers the message when the
transaction commits and drops it when it rolls back; several publishes in one
transaction arrive in call order. Outside a transaction the message is sent at
once.

PostgreSQL keeps notifications in a server-side queue until commit. When that
queue is full the **commit** fails, and the failure surfaces as the publishing
transaction's own error, with no code of this module. PostgreSQL also serializes
commits that notify, so the channel is a bus for hints about writes, never for a
stream of data.

## The listening connection

Each replica listens on a channel over **one connection of its own** (not one of
the pool), opened by the first subscription and released with the last, however
many subscriptions and topics it serves. The topic travels in the payload and
each subscription matches it against its own patterns, so every replica receives
every message on the channel.

## Gaps

`Postgres.Connection.listen` takes an `onReconnect` option that fires once a
dropped listening connection is re-established and its `LISTEN` replayed.
Notifications sent in between were not delivered, so the channel gives every
subscription a gap, "the database connection was lost and re-established", which
runs the subscription's `onGap`. A consumer that must stay correct re-reads its
source of truth. Messages sent after the reconnect arrive normally.
