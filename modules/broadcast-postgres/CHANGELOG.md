# Changelog

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module. BroadcastPostgres.Channel carries a Broadcast.Channel over a Postgres.Connection's LISTEN / NOTIFY, so a message published on one instance reaches the live subscriptions of every instance on the same database. Each channel is the notification channel telo_broadcast_<name>, listened on over one connection per instance however many subscriptions it serves. maxBytes may not exceed the 7999-byte notification limit (BROADCAST_MAX_BYTES_EXCEEDS_BACKEND, ERR_BROADCAST_MAX_BYTES_EXCEEDS_BACKEND at creation). A publish inside a Sql.Transaction on the connection is delivered when it commits and never when it rolls back, and a subscription receives a gap when its listening connection dropped and was re-established.
