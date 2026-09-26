---
"telo-vscode": minor
---

Changed: the extension is an LSP client over `@telorun/language-host`. Every diagnostic and language feature comes from the engine of the telo version the active module is edited against, running in a worker; the bundled engine ships in the `.vsix`. New `telo.version` setting (`auto` or an exact engine identity, `0.102.0` or a development build's `0.102.0+unreleased`), a "Telo X" status item and the `Telo: Select Telo Version` command. An engine that crashes or never starts is shown as an error with **Retry**, and never holds activation up. `telo.manifestCacheUrl` is removed: upgrade candidates are read through the same transports as imports. Requires VS Code 1.91 or newer.
