---
"@telorun/glob": minor
"@telorun/kernel": patch
"@telorun/cli": patch
"@telorun/test": patch
---

Unify glob matching across the monorepo onto a single dependency-free engine in a new `@telorun/glob` package. It exports `selectByPatterns` (plus `HARD_IGNORE` / `DEFAULT_IGNORE` / `GLOB_PRUNE_DIRS`) as the one matcher used everywhere a `.gitignore`-style pattern set is resolved: `files:` bundling (`telo publish` + the editor run bundle), `include:` expansion (kernel `LocalFileSource` + the editor adapters), and test discovery (`@telorun/test`).

This removes four divergent implementations — the kernel's `minimatch`, the editor's hand-rolled glob→regex, the test runner's own `globToRegex`, and an `ignore`-based pass — in favor of a small matcher implementing a documented **Telo glob** subset of gitignore. The subset and its exact behavior are pinned by a language-neutral conformance suite (`packages/glob/conformance/glob.json` + `README.md`) so any runtime (Node today; Rust / Go later) can reimplement it identically rather than chasing one library's quirks. The kernel drops `minimatch` and the CLI drops its direct `ignore` dependency; the matcher lives in its own package rather than the static analyzer, so consumers depend on it directly instead of reaching into `@telorun/analyzer` for a non-analysis primitive.

The deny set is split into a non-overridable **hard** tier (`node_modules`/`.git`/`.telo`) and a soft, opt-out-able tier (`.telobundle.*`). `applyDefaultIgnore: false` (used by `include:` resolution to reach co-located partials) now only skips the soft tier — a broad `**` `include:` can no longer recurse into the manifest cache, and resolves identically in the kernel and the editor.
