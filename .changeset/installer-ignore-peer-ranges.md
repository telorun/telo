---
"@telorun/kernel": patch
---

Make the controller installer ignore declared `peerDependencies` ranges

The npm controller loader now passes `--legacy-peer-deps` (npm) /
`--no-strict-peer-dependencies` (pnpm) to its `install` invocations. A pinned
controller tarball is immutable and carries whatever `@telorun/sdk` peer range
was current when it was published; the install root provides the kernel's own
(newer) sdk as a `file:` dep for realm-collapse, so npm 7+'s strict peer
resolver `ERESOLVE`-aborted when that version fell outside the old range — even
though the sdk surface is backward compatible and the controller runs fine.
Disregarding declared peers restores npm ≤6 behavior: the provided sdk is used
and old version pins install regardless of how far the kernel/sdk have moved.
