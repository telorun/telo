# Workspace-anchored `.telo` cache

Every entry manifest gets its own `.telo` beside it — 123 directories, 1.6 GB,
dominated by `.telo/npm` at ~78 MB per app and a 246 MB Rust target dir.

Anchor at `telo-workspace.yaml` instead, so a monorepo has one. Nearly everything
inside is content-addressed, so merging is free. The release path already anchors
there.

Tasks 2 and 4 cover the parts that are *not* content-addressed.

---

## 1. Anchor the cache root at the workspace marker

**Before:** `TELO_CACHE_DIR`, else `<entry-dir>/.telo`.
**After:** `TELO_CACHE_DIR`, else `<workspace>/.telo`, else `<entry-dir>/.telo`.
No marker anywhere above means unchanged behaviour.

Reuse the walk-up that already exists for `.env` collection rather than writing a
second one. Everything downstream already takes the root as a parameter.

Both kernels must agree on what a marker is: it has to be a FILE (a directory of
that name anchoring one runtime and not the other splits the cache in half), and
a relative `TELO_CACHE_DIR` is absolutized — on the Rust side that value becomes
the cargo target dir for a build whose working directory is the crate, so leaving
it relative scatters builds per crate instead of relocating them.

**Verify:** two apps share one `.telo`; a manifest with no marker above it still
caches beside itself.

---

## 2. Key the analysis stamp per entry — **blocker, lands with task 1**

**Before:** `<cache>/manifests/.validated.json` — one file, one signature,
recording that a manifest set passed analysis. Per-app only because each app has
its own `.telo`. Shared, every app overwrites it: A stamps, B misses and
overwrites, forever. A permanent 100% miss with no error, worst in the test
suite, which is where the win should be.

**After:** `<cache>/analysis/<hash-of-entry>.json` — one stamp per entry. A
directory rather than records in one file, or concurrent kernels lose each
other's entry.

Out of `manifests/` because it never was one — that directory holds cached module
manifests keyed by transport. `__validators/` is misfiled for the same reason and
moves to `<cache>/validators/` in the same task; both are invalidated by this
change anyway, so it costs nothing now and is churn later.

**Verify:** load A, then B, then A again — A's second load hits its stamp.

---

## 3. Inherit the cache root through the runtime seam

**Before:** a child kernel resolves its own root beside the child manifest. The
test runner runs every test as a child manifest, hence a `.telo` in every
`modules/*/tests/` and a bundle rebuild per test. Fixing only the CLI leaves the
suite unimproved.

**After:** the child inherits the parent's root. Both halves already exist; they
are not wired together.

"No root given" and "explicitly no cache" are different answers — a parent with
no anchor must leave the child resolving its own.

**Verify:** the suite creates no `.telo` under any tests directory, and a second
run does no source build.

---

## 4. Rust: one cache root, backend-keyed target dirs

**Before:** `<crate>/.telo/target`, kept away from the shared workspace target
because the Rust kernel may already hold that lock.

**After:** `<workspace>/.telo/cargo/<sdk-backend>/target` — still not the
workspace target, so the anti-lock property holds.

- **Keyed by backend** because the Node kernel builds these same crates with a
  different SDK feature, into the workspace target. They are kept apart today
  only by that accident of location; one directory would rebuild the whole
  dependency tree on every alternation.
- **Rust has no cache-root concept at all** — no `telo-workspace.yaml` reader, no
  root resolution. Genuinely new surface, and the largest piece of this change.

The Node side stays put; it holds no cargo lock.

**Verify:** builds land in `<workspace>/.telo/cargo/<backend>/target`, no
`<crate>/.telo` appears, alternating kernels triggers no full rebuild.

---

## 5. Backwards compatibility with an existing `.telo`

**Nothing is misread** in either direction, including an old global CLI and a repo
one on the same app. Even the stamp is safe: the old `.validated.json` sits in a
directory the new layout no longer writes to.

**What regresses is warmth, and once that is a break.** Cold `validators/`,
`controller-src/` and `npm/` cost CPU; a cold `manifests/` costs network — so a
hermetic setup, where `telo install` ran so boot does no network I/O, stops
booting.

**So write new, fall back to old on read.** On a miss at
`<workspace>/.telo/manifests`, consult `<entry-dir>/.telo/manifests` before the
network. Extending that to `validators/`, `controller-src/` and `analysis/` is
optional; those misses only cost CPU.

**`.telo/npm` can't be covered** — a `node_modules` tree is used whole or not at
all. An offline upgrade needs one `telo install` against the new root; release
note, not a failed boot.

**Baked images are unaffected** — `TELO_CACHE_DIR` still wins and both image paths
set it. Worth asserting, since the precedence rests on it.

**Retire the fallback** once its release is no longer upgraded from; the old
`.telo` directories go with it.
