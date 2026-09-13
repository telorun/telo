---
"@telorun/analyzer": minor
---

`telo check` reports `CONTROLLER_DYLIB_ABI_MISSING` at a `pkg:telo/local/dylib` controller candidate that states no `abi`, or an `abi` outside the `telo` family, and `SOURCE_LINK_TARGET_UNRESOLVED` at a `sources:` link whose target ships in a different layer than the link (another `native:` or platform-qualified candidate selector, or `common` for a notice).
