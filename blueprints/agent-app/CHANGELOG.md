# Changelog

## 0.2.0 - 2026-09-22
### Added
* AgentApp blueprint: one `AgentApp.App` declaration — a model, a system prompt and the tools it may call — gives an HTTP chat API that keeps each conversation's history in SQLite and runs the tool-use loop.
* Breaking: App `history` is a required Telo.HostPath with no default: pass it from the application's own variable declared x-telo-type: Telo.HostPath (for example default `.telo/conversations.sqlite`), which resolves it against the working directory.
