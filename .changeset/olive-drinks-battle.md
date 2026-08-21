---
"@telorun/kernel": minor
"@telorun/cli": minor
---

Anchor the `.telo` cache at `telo-workspace.yaml`, so one repo has one cache.

Every entry manifest used to get its own `.telo` beside it — 123 directories and
1.6 GB in this repo, overwhelmingly duplicated npm install trees, plus a
controller-bundle rebuild once per test because the test runner loads each test as
a child kernel that resolved its own root. Precedence is now `TELO_CACHE_DIR` >
the directory holding the marker > `<entry-dir>/.telo`, and only the marker's
LOCATION is read, never its `modules:` list. With no marker anywhere above an
entry the behaviour is exactly what it was, so the file enables the shared cache
rather than gating one.

The layout gains `analysis/` and `validators/` beside `manifests/` rather than
inside it — neither is a cached manifest — and the analysis stamp becomes one file
per entry. A single stamp file was per-app only because each app had its own
cache; shared, every app would overwrite the last, which is a permanent 100% miss
that reports nothing and only makes boots slower.

**Upgrading:** a warm cache goes cold. That costs only CPU for validators, bundles
and the npm tree, but manifests cost network, so both halves of a module are read
from the old `<entry-dir>/.telo/` on a miss — the manifest itself and the layers
that extract beside it — and a module already installed there boots offline
without a fetch. The npm tree cannot be covered that way, since a `node_modules`
tree is used whole or not at all: an offline upgrade of a module delivered through
npm needs one `telo install` against the new root. Baked images are unaffected —
`TELO_CACHE_DIR` still outranks the marker.

Both cargo loaders now build controller crates under `<cache>/cargo/<backend>/`,
keyed by SDK backend, so alternating between the Node kernel, `telo-rs` and a
plain `cargo build --workspace` no longer rebuilds the crate and its dependency
tree each time.
