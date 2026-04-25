---
"@telorun/test": patch
---

`Test.Suite.discoverTests` now hard-skips any path containing a `node_modules/` segment and dedupes results by realpath. Without this, pnpm's symlinked workspace packages caused the same test yaml to be discovered through multiple paths (e.g. once via `kernel/nodejs/tests/foo.yaml` and again through every `**/node_modules/@telorun/kernel/tests/foo.yaml` symlink), inflating "FAIL" counts with non-existent duplicates.

Hard-skipping `node_modules` is unconditional rather than a default-exclude entry, because vendored test files in dependency packages should never run as workspace tests regardless of the user's `exclude` config.
