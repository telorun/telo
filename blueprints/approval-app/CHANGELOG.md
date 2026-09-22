# Changelog

## 0.2.0 - 2026-09-22
### Added
* ApprovalApp blueprint: one `ApprovalApp.App` declaration gives HTTP endpoints to submit, approve, reject and track requests, a rule that approves small ones automatically, and a durable wait that survives restarts and rejects a request left undecided past its deadline.
* Breaking: App `journal` is a required Telo.HostPath with no default: pass it from the application's own variable declared x-telo-type: Telo.HostPath (for example default `.telo/approvals`), which resolves it against the working directory.
