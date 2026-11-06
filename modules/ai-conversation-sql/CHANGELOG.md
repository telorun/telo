# Changelog

## 0.2.0 - 2026-11-06
### Added
* A create naming an id that already exists answers that conversation's header unchanged instead of failing.
* A file registered with a binding is inserted already bound, in one transaction with the turn fence an append takes, so a superseded turn registers nothing; registering an id that already exists answers the stored row only when it is unreleased and pending (no binding) or bound to the binding's conversation, and is ERR_CONVERSATION_ATTACHMENT_NOT_FOUND otherwise, so an id never answers another conversation's file.
* Keeps the files each conversation holds in an attachments table, added by schema version 3, which a version-2 database upgrades to in place; files stored before it read as not found. Binding a file to a conversation and releasing it are each one conditional write on its row, so of an admission and an expiry pass racing for one file exactly one takes effect.
* New module: a SQL backend for the conversation store over any Sql.Connection (PostgreSQL, SQLite). It owns five tables under a configurable tablePrefix, indexed for the default newest-first listing as well as the archived-filtered one, records its schema version, upgrades an older layout in place at start and refuses a newer one.
