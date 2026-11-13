# Release conformance vectors

What the release planner answers, frozen as data: `@telorun/release` and its Rust twin `telorun-release` read these rows and answer each identically, word for word. The values are Node's answers, recorded once by running the Node package over each row's inputs; no generator is committed, and a value changes only when the answer does.

## Files

Every row is `{ name, …inputs, expected }`.

- `markers.json` — a tree of `files` (the marker at `telo-workspace.yaml`, and optional `ecosystemHosts`), read with the shipped adapters and resolved against a tree whose directories are every parent of a listed file. `expected.diagnostics` is each `{ code, severity, message, path }` the marker read and then the unit resolution reported, in that order; `expected.units` each resolved unit (`null` when the marker yields no release block).
- `plans.json` — `units` of evidence, a `ledger` text (`null` for none), `fragments` (`{ source, text }`), `groups` and an optional `candidate`. `expected.plan` is the plan as the planner returns it, each reason in its object form; `expected.recorded` the ledger text after recording the plan with each unit's own layers. A plan the planner refuses is `{ error }`.
- `digests.json` — file sets (`text`, `base64` or `link`, optionally `executable`) and their file-set digest, or `{ error }`.
- `yaml.json` — `fragments` (units and a body, and the fragment text written), `ledgers` (a ledger text read and written again, or `{ error }`) and `fragmentTexts` (a fragment read, or `{ error }`).
- `version-files.json` — `versionFiles` (a file, an optional pointer, its text: the version read and the text written with `version`, each or `{ error }`) and `lockfiles` (a `Cargo.lock` with one crate's entry moved).
- `cargo-closures.json` — what a crate linking an artifact holds at `Cargo.lock` in its layer. `metadata`: a `cargo metadata` answer and a `root` package id, `expected.entry` the closure text, `null` when the root has no `bin`, `cdylib`, `staticlib` or `dylib` target. `locks`: a published `.crate`'s `lock` and packaged `manifest`, the `root` name and version and the workspace's `members`, `expected.entry` the closure text, each answer or `{ error }`; the lockfile is named `fx-app-2.0.0.crate/Cargo.lock` in every message.
- `changelogs.json` — a release block rendered and prepended to an existing changelog.
- `commands.json` — a tree of `files` committed to a fresh git repository, then `steps`: each runs one command line (`args`) of `telo-release` over the shipped ecosystems there and commits the tree. `expected` per step is its exit status and the last envelope it emitted (`null` for none).

## Runners

- `release/nodejs/tests/conformance.test.ts`
- `release/rust/tests/conformance.rs`, which also pins each file's row count.
