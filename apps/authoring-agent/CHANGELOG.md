# Changelog
## 0.3.0 - 2026-07-20
### Added
* Upgraded module dependencies## 0.2.0 - 2026-07-14
### Added
* Primer covers general kind inheritance: extends any kind, the base: construction mapping, inherited-and-immutable capability, and when to use inheritance vs. templated composition.## 0.1.0 - 2026-07-09
### Added
* Publish the `telorun/authoring-agent` Docker image on every agent release — an immutable `<version>-slim` plus the mutable `latest-slim`, built on the newest published telo runtime
* Agent tools: `delete_file` (workspace-rooted Fs.FileRemoval) and on-demand `telo_check` (same keyless fixed-argv subprocess as the auto-check after write/edit)
* History seeding: `POST /conversations/{id}/messages` bulk-imports the rows a previous session persisted (idempotent `INSERT OR IGNORE` by uuidv7 id), so a client can ferry the conversation into a fresh per-session instance — the model then sees the same history the client shows## 0.0.0
