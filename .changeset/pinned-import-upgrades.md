---
"@telorun/ide-support": minor
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Upgrading an import from an editor now writes the new version's integrity pin
instead of dropping it.

`telo module manifest --json` emits an `integrity` field — the owning
transport's `manifestHash`, never a hash re-derived from the manifest text,
since only the transport knows what its own reads verify against. The hub stores
it per version and serves it from `/module/versions`, so an editor gets the pin
in the request it already makes and no browser has to speak OCI to produce one.

In `@telorun/ide-support`, `ModuleVersionLookup` now returns
`{version, integrity?}` entries, and `buildImportUpgrades` reports two
categories: imports that are behind (bumped and re-pinned in one edit) and
imports at the newest version carrying no pin (pinned in place, matching
`telo upgrade`'s `ensurePinned`). Pins are written in the shape the author
wrote — a scalar shorthand takes a `#sha256-…` fragment, an object-form
`integrity:` has its value replaced — which also lets a flow-style
`{source: …, integrity: …}` entry be re-pointed instead of skipped. With no pin
available for the target version the previous behaviour is unchanged: the
version is bumped, the stale pin removed, and the host told to say so.

A pin arriving over the network is spliced into the author's YAML, so it is
validated before it is written: `@telorun/analyzer` exports
`isCanonicalIntegrity`, and a value that is not `sha256-<43 base64url chars>`
is treated as no pin rather than written through — a malformed one would
corrupt the manifest, which is the one failure install-time verification cannot
catch. `parseModuleVersions` (also new, in `@telorun/ide-support`) is the single
reader for the route's body, so a host no longer hand-rolls the parse.
