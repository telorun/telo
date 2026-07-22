---
"@telorun/cli": patch
---

Fix `telo publish` for OCI imports and directory arguments.

- The pre-flight analysis loader now uses the kernel's transport sources (same
  chain as `telo check`), so a manifest whose `imports:` reference an `oci://`
  dependency — pinned (`#sha256-…`) or not — resolves for analysis instead of
  failing with `No source found for: oci://…`. Previously it used the analyzer's
  `defaultSources()` (HTTP + registry only), which owns no `oci://` scheme.
- A directory argument now resolves to its `telo.yaml` (standard Telo path
  resolution, matching `run` / `check`), instead of failing with
  `Cannot read file: <dir>`.
