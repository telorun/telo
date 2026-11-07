---
"@telorun/cli": patch
---

`telo release check` no longer asks for a changelog entry for files a `v*`, `modules-*` or `packages-*` release tag already carries, so a release branch's merge-back passes. Floor verification names the newest published final release when a declared bound is not published yet, never a release candidate.
