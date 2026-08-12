# Changelog
## 0.4.1 - 2026-08-12
### Fixed
* The system prompt no longer describes the standard library as living under an `std` namespace. That framing survived the move to hub-based discovery and taught the deprecated bare `namespace/name@VERSION` registry form; the prompt now names `oci://ghcr.io/telorun/<name>` as where the standard library is published, states that `oci://` refs and relative paths are the only sources that may be written, and calls the bare form out as deprecated. Refs are copied verbatim from the hub tools — including an integrity pin when one is returned — rather than composed from a module name. The check loop that runs after every write and edit now passes `-o json`, so the agent reads diagnostics by `code`, `file`, `line` and `column` from a parseable document instead of pattern-matching prose; stdout and stderr are surfaced as separate tool-result fields so the document stays parseable and no message is lost.## 0.4.0 - 2026-08-03
### Added
* System prompt covers the module metadata surface. The primer now documents the descriptive `metadata` fields (`version`, `description`, `repository`, `homepage`, `documentation`, `license`), structured deprecation (`metadata.deprecated: { reason, replacedBy? }`, with the replacement written as an alias-qualified kind on a kind doc and a module ref on a module doc), and that there is no `authors` field because the hub derives a publisher from the ref. It also tells the agent that runtime and language are DERIVED from a kind's controllers rather than declared, and that `search_resources` takes an optional `runtime` argument to avoid being offered kinds the target kernel cannot load.## 0.3.0 - 2026-07-20
### Added
* Upgraded module dependencies## 0.2.0 - 2026-07-14
### Added
* Primer covers general kind inheritance: extends any kind, the base: construction mapping, inherited-and-immutable capability, and when to use inheritance vs. templated composition.## 0.1.0 - 2026-07-09
### Added
* Publish the `telorun/authoring-agent` Docker image on every agent release — an immutable `<version>-slim` plus the mutable `latest-slim`, built on the newest published telo runtime
* Agent tools: `delete_file` (workspace-rooted Fs.FileRemoval) and on-demand `telo_check` (same keyless fixed-argv subprocess as the auto-check after write/edit)
* History seeding: `POST /conversations/{id}/messages` bulk-imports the rows a previous session persisted (idempotent `INSERT OR IGNORE` by uuidv7 id), so a client can ferry the conversation into a fresh per-session instance — the model then sees the same history the client shows## 0.0.0
