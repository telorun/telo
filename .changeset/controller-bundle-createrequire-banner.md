---
"@telorun/kernel": patch
---

Controller bundles now define `require` via a `createRequire` banner, so a bundled CJS dependency that calls `require()` of a Node builtin (e.g. `tar-stream`'s `require("events")`, `yaml`'s `require("process")`) no longer throws "Dynamic require of X is not supported" when the ESM bundle is imported. The directory-relative safety guard runs against esbuild's raw output, before the banner is prepended, so it is unaffected.
