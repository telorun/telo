---
"@telorun/kernel": patch
---

Fix loading manifests from `http(s)://` URLs as the entry point.

The npm controller loader previously required the entry URL to be a local path or `file://` URL so the per-kernel install root could be anchored at `<entry-dir>/.telo/npm/`. HTTP-sourced manifests were rejected with `ControllerEnvMissingError`, so `pnpm run telo https://…/manifest.yaml` failed before any controller could be installed.

The loader now picks an install root based on the entry URL scheme:

- `file://` URL or bare filesystem path → unchanged (`<entry-dir>/.telo/npm/`)
- `http://` / `https://` URL → user-level cache keyed by `sha256(entryUrl)` at `$TELO_NPM_CACHE_DIR` (override) or `$XDG_CACHE_HOME/telo/remote` or `~/.cache/telo/remote`. Repeat runs of the same URL hit the same cache; distinct URLs get isolated trees so two unrelated remote apps don't share `node_modules`.

Single-realm install semantics are preserved: each kernel process still uses exactly one install root that pins `@telorun/sdk` (and every other realm-collapse name) to the kernel's own resolution via a `file:` dep, so class identity (`Stream`, etc.) is the same across the kernel/controller boundary regardless of where the install root physically lives.
