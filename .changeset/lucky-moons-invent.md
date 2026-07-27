---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Add `parseVersionedRef` / `withRefVersion` — the browser-safe, transport-neutral half of an import upgrade (split a ref into `{ baseRef, version, integrity }`, re-point it at a new version). The OCI and registry transports' `refVersion` / `withVersion` now delegate to it, so the ref grammar has one implementation shared by `telo upgrade` and hosts that have no transport at all (the telo editor, which reads versions from the hub instead). `withRefVersion` throws for a ref whose grammar carries no version segment (a relative path, a bare `https://` URL) rather than fabricating one, matching the transport-specific parsers it replaces.

Export the SemVer ordering that version reconciliation already used — `parseModuleVersion`, `compareModuleVersions`, `isNewerModuleVersion`, `isSameModuleVersion` — from `module-version-order.ts`. Still pure and dependency-free, so it stays browser-safe; it is now the one version-precedence rule available to every host rather than being private to `reconcile-module-versions.ts`.
