---
"@telorun/cli": patch
---

fix(cli): restore `telo run --watch`

Watch mode was inert — its file watching and reload were stubbed out against
two kernel methods (`getSourceFiles`, `reloadSource`) that no longer exist.
Reimplement it as a full-restart loop: load → derive the graph's local files
(entry, `include:` partials, imported libraries) → start (held alive so
one-shot apps don't exit) → reload on any change by cancelling and tearing the
kernel down, then rebuilding. Load/boot failures are reported as diagnostics
and watch keeps running so the next edit retries. The watcher set is persistent
across reloads (one long-lived `fs.watch` per file) rather than torn down and
recreated each cycle — under bun, re-`fs.watch`-ing a just-closed path never
fires again, which limited reloads to exactly one.
