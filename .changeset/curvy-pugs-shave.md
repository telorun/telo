---
"@telorun/ide-support": minor
"@telorun/cli": minor
---

Present OCI as the primary module ref form in CLI help and docs. `telo module`'s
`<ref>` help text now leads with `oci://host/repo@1.2.0` instead of a `std/`
registry ref; the bare `<namespace>/<name>@<version>` form still resolves and is
still listed. No behavioural change — help and comment text only.
