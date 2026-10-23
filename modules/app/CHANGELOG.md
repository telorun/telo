# Changelog

## 0.4.0 - 2026-10-23
### Added
* The `App.Instance` docs state that a child application does not inherit its parent's host values (`TELO_HOST_STATE_DIR` and the public URL templates), so a child's `Telo.DurableDirectory` need is supplied through its own variable.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-19
### Added
* App.Instance is a Channel.Text, so a running child can be read from and written to as text. BREAKING: the stdin: field is removed. A fixed script handed over at start-up cannot answer a question that only appears once the previous one is answered; sending is a step now, and a boot-time script is the first steps of a sequence.
* App.Instance runs another Telo application as a resource: supply its declared variables, secrets and ports by name, read its exit code as observed state, and have it shut down cleanly when the scope that declared it ends. An application cannot be imported, so this is how a manifest supervises several applications at once, and how a test reaches the file a user actually copies.
