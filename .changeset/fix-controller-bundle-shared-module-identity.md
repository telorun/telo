---
"@telorun/kernel": patch
---

Fix controller bundling duplicating a package's own shared modules. `telo install`
bundles each controller entry separately, and the bundler inlined the package's
relative imports — so a module shared across a package's controllers (e.g.
`record-stream`'s `journal-store`, holding the `JournalStore` class and its
process-local buffers) got a **separate copy per controller bundle**. `instanceof`
across the package's controllers then failed and shared state split, surfacing at
runtime as `RecordStream: invalid journal reference` when a `JournalSource` rejected
a store created by the `Journal` provider.

The bundler now externalizes the controller **package's own** relative modules —
resolved to their real, runtime-loadable `.js` file and left loose beside the
bundle — so Node loads one shared copy across every controller of the package (the
intra-package analogue of the existing `@telorun/*` realm externalization). A
dependency's own internal relative imports stay inlined (bundled), and any relative
import that doesn't resolve to a loadable JS file is left to inline, so bundles
never emit an unresolvable import. `node_modules` deps are still bundled (the
cold-start target).
