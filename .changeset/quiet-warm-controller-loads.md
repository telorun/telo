---
"@telorun/kernel": patch
---

A controller that was already on disk no longer reports itself as work.

The bundle loader reported `source: "bundle"` for every resolve, whether it had just pulled the module's controller layer down or found it extracted from a previous run. The CLI's progress trail silences the sources that mean "nothing happened" (`cache`, `local`) and prints the rest, so an app with a dozen bundled controllers printed a dozen `✓ … (bundle, 0ms)` lines on every warm start — a download report for a transfer nobody waited for.

`materializeController` now returns `{ layer, transferred }`, with `transferred` set by the branch that actually did the transfer: the on-disk marker fast path and the in-lock re-check report `false`, and a caller that joined a transfer already in flight reports `false` too, so several controller candidates sharing one layer produce one line rather than one each. It is out of band rather than a field on `MaterializedLayer` because it describes the call, not the layer — the layer value is memoized and shared, so the flag would be meaningless to every other caller. The bundle loader maps it to a source — `local` for a module sitting beside its manifest, `cache` for an extracted layer, `bundle` only for a fetch — and `materializeController` folds in the `common` layer it pulls along, since either half fetching is a wait.

The npm loader had the same mislabel in a narrower spot: when the re-check inside the install lock found a peer had already installed the package, it still reported `npm-install`. It now reports `cache`, because nothing was installed.
