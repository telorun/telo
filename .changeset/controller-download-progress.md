---
"@telorun/kernel": patch
"@telorun/cli": patch
---

Surface controller-download progress as kernel events and render them in the CLI.

`ControllerLoading` / `ControllerLoaded` / `ControllerLoadFailed` /
`ControllerLoadSkipped` are now emitted from `ControllerLoader` itself, one
cycle per attempted PURL candidate so env-missing fallback chains are visible.
Payloads carry the single attempted `purl` instead of the full candidate
array, plus `source` (`local` | `node_modules` | `cache` | `npm-install` |
`cargo-build`) and `durationMs` on `Loaded` so consumers can distinguish real
work from cache hits. `pkg:cargo` resolutions through `local_path` (the only
cargo mode currently wired up) report `source: "local"` — cargo's incremental
cache makes every run after the first effectively a no-op build, the same
mental model as the npm `local_path` branch. `cargo-build` is reserved for a
future distribution mode (fetch from a registry + compile). `Skipped` is
emitted for recoverable env-missing fallbacks (e.g. `pkg:cargo` with no
`rustc` on PATH) so consumers can close out per-attempt UI state without
conflating it with a hard failure.

The CLI renders a `⬇ <purl>` line at `Loading` and rewrites it in place to
`✓ <purl> (<source>, <ms>)` (or `✗ …`) at `Loaded` / `Failed`. By default the
renderer activates only when stdout is a TTY, so CI logs and the dockerised
`telorun/telo` service stay silent. `--verbose` forces rendering on regardless
of TTY (so captured/piped logs get the lines too).

By default, resolutions reporting `source: cache` or `local` have their line
erased once `Loaded` arrives — they're sub-millisecond and don't represent
work worth surfacing. `--verbose` bypasses this filter and prints every
resolution, including cache/local, which is useful for debugging which branch
the loader took. Other sources (`node_modules`, `npm-install`, `cargo-build`)
always render their `✓` line.

The cargo / napi loader now also accepts an optional PURL fragment. When
present, `pkg:cargo/foo?local_path=...#bar` projects to `module.bar` after
loading the dylib (each sub-export must itself have `create` or `register`);
without a fragment the whole module is the controller, as before. This
mirrors the npm `#entry` semantics for crates that want one source file per
controller. The raw module is cached per crate, so two PURLs differing only
by fragment share one cargo build.
