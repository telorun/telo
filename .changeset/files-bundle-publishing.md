---
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Add `files:` for bundling static assets into a published module. A `Telo.Application` or `Telo.Library` may declare a `files:` list of ordered, `.gitignore`-style patterns (matched with the `ignore` engine: positive patterns opt in, `!` patterns carve out, last-match-wins). When present, `telo publish` packs `telo.yaml` plus the selected files into a `module.tar.gz` and PUTs it to the registry; `telo install` / `telo run` extract that archive into the local cache next to the cached `telo.yaml`, so a relative `Http.Static` `root:` (e.g. a built SPA in `./public`) resolves on the consumer exactly as it does in development. An always-on ignore set (`node_modules/`, `.git/`, `.telo/`, `.telobundle.*`) is never shipped. The CLI's `include:` resolver moves from `minimatch` to the same `ignore` engine.
