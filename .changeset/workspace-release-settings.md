---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
"@telorun/glob": minor
"@telorun/runner-core": minor
---

`telo-workspace.yaml` gains per-subtree release settings and an `env:` block, and every field now lives in a block scoped to what it governs.

**`modules:` moves under `release:`.** This is a breaking edit to every existing marker: indent the list one level. Top-level `modules:` is a recognized-and-moved key whose message names the move rather than a generic unknown-field rejection, and no second spelling is kept. It is a release inventory, not an inventory of manifests, and leaving it at the top level made it read as a fact about the tree — which is why a runner had to seed `modules: ["*"]` into every session workspace to satisfy a reader that never runs there. A marker whose whole content is comments is now valid, so it seeds one.

`release:` carries `registry:` (the publish base), `ignore:` (module-relative gitignore-style paths whose changes ask for no changelog fragment — the built-in default is now `**/`-prefixed, so a nested `nodejs/tests/` suite stops being reported as a semantic change) and `modules:`. An entry is a bare pattern or `{path, registry?, ignore?}` overriding the block's keys key-wise, evaluated last-match-wins.

`env:` carries `roots:` (how far up `telo run` walks collecting env files) and `files:` (which filenames, later winning within one directory). Both default to today's behaviour exactly.

Also:

- **Destinations are checked before any payload is built.** `DESTINATION_COLLISION` when two modules resolve to one ref; `IMPORT_DESTINATION_CONFLICT` when a relative import does not agree about where its target publishes.
- **The registry cascade is entry → block → `--registry` → `TELO_OCI_REGISTRY` → the ledger.** The ledger is last, where it used to win; a disagreement is now a per-module `LEDGER_REGISTRY_MISMATCH` inside a plan that is still produced, rather than an abort.
- **The ledger records a base per entry**, unconditionally. A top-level `registry:` is read as every entry's and never written again.
- **`telo release order` emits `{key, destination}`**, so a publisher no longer derives a destination of its own.
- **`telo run` reads the marker's `env:` block** and nothing else in it: a problem elsewhere is printed and the run proceeds; one inside `env:` fails the run rather than widening the walk.
- **The marker gets diagnostics and completion**, in the editor and in `telo release` alike, including three checks that need to see the repo — an entry matching nothing, an entry a later one shadows, and a marker nested under another.
- **`@telorun/glob` gains `lastMatchIndex`**, which reports *which* pattern decided a path rather than reducing the walk to a boolean. That is what makes a module's settings attributable to the entry that claimed it, and what the shadowed-entry check reads.
- **`@telorun/runner-core` seeds a marker with no blocks at all.** It used to write `modules: ["*"]` — release scope a session never reads — purely because an empty list was a parse error, so every session workspace carried a release claim the runner did not mean.
