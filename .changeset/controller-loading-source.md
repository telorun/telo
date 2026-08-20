---
"@telorun/kernel": minor
"@telorun/cli": patch
---

Controller progress now reports the wait itself instead of guessing around it.

A new `ControllerWorkStarted` event is emitted by the sub-loader that is about to install, compile or fetch — past every cache check and re-check, at the point the package manager, `cargo`, esbuild or a layer transfer actually runs. It is the only in-progress signal, and a warm start enters no such branch, so nothing is emitted and nothing has to be taken back. `ControllerLoading` now carries the resolve `source`, and `ControllerLoaded`'s `durationMs` measures from the first work branch entered (falling back to the import call), so a 40-second install is no longer reported as `(npm-install, 12ms)`. `ControllerLoader.resolve()` emits work and candidate-fallthrough events; `load()` is now that resolve plus the import half.

The CLI's `⬇` line is opened by the work event and closed in place by `Loaded`/`Failed`, so it is on screen for the whole of a real wait and never printed at all for a `cache`/`local` hit — replacing the speculative line that was printed and then erased.
