---
"@telorun/kernel": minor
"@telorun/cli": minor
---

`telo upgrade` now upgrades OCI imports and can follow relative imports
recursively.

Version enumeration, ref reconstruction, and integrity hashing during an
upgrade are delegated to the transport that owns each ref's scheme, so every
backend the kernel can resolve is also upgradeable. Previously the command used
a registry-only ref classifier that skipped `oci://host/repo@tag` imports as
"not a registry ref"; they are now bumped in place like registry refs. The
`Transport` interface gains two methods for this — `refVersion(ref)` (the
version segment currently named) and `withVersion(ref, version)` (the ref
rewritten at a new version) — implemented by `RegistryTransport` and
`OciTransport`.

A new `--recursive` / `-r` flag follows relative (local) imports into their
sibling manifests and upgrades those too. It is cycle-safe and upgrades each
file at most once even when a sibling is reached from several manifests. Remote
refs are always upgraded in place; recursion only descends into on-disk
siblings. Without the flag, a relative import is reported skipped with a hint to
use `--recursive`.
