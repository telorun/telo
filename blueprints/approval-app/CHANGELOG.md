# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-22
### Added
* ApprovalApp blueprint: one `ApprovalApp.App` declaration gives HTTP endpoints to submit, approve, reject and track requests, a rule that approves small ones automatically, and a durable wait that survives restarts and rejects a request left undecided past its deadline.
* Breaking: App `journal` is a required Telo.HostPath with no default: pass it from the application's own variable declared x-telo-type: Telo.HostPath (for example default `.telo/approvals`), which resolves it against the working directory.
