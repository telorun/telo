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
- `markdown.json` — a `plan` (its `units` in `plans.json`'s `expected.plan` form, leaving out `name` and `changed`, which the document shows neither of, and each entry's `fragment`) rendered as the `-o markdown` document under `maxLength` (`null` for no limit): `expected.document`, or `{ error }` when no stage fits.
- `commands.json` — a tree of `files` committed to a fresh git repository, then `steps`: each runs one command line (`args`) of `telo-release` over the shipped ecosystems there and commits the tree. `expected` per step is its exit status and the last envelope it emitted (`null` for none); a step marked `"stdout": true` also records `stdout`, the document it wrote under `-o markdown` (`""` for none).
- `pypi-markers.json`, `pypi-plans.json`, `pypi-commands.json` — rows of the `pypi` ecosystem in the formats of `markers.json`, `plans.json` and `commands.json`. No row builds an sdist or reaches an index, so every one answers offline.
- `pypi.json` — the `pypi` adapter's pure half, by section, each row answered or `{ error }`:
  - `toml`: a `text` read as a TOML document, `expected.value` its values — a string, a boolean, an array and a table as JSON, an integer `{ integer: "<decimal>" }`, a float `{ float: "<text>" }`, a date or time `{ datetime: "<text>" }` — the document named `pyproject.toml` in every message.
  - `names`, `versions`: a name PEP 503 normalized; a version PEP 440 normalized (`null` when PEP 440 cannot spell it) and the reason no release can be planned from it (`null` when one can).
  - `buildSystems`: a `pyproject.toml` `text`'s `[build-system]`, `null` when it has none.
  - `members`: the sdist member `paths` a layer keeps.
  - `projects`: the workspace's pypi anchors (`{ unit, dir, text }`) and, per `dir`, its `links` (`{ requirement, at, target }`) and `problems`.
  - `requirements`: the anchor at `dir` among `projects` with its requirements linked to `target` moved to `version`.
  - `lockfiles`: a lockfile `text` at the workspace-relative `file` with the entries locked from `target` (`{ name, dir }`) moved to `version`, `null` when it records none.
  - `contentHashes`: a `poetry.lock` / `pdm.lock` `text` whose content hash follows its project from `before` to `after`, SHA-256 written as lowercase hex, `null` when it records none.
  - `indexes`: a simple-index project page `body` (JSON when `json`, else HTML) named `index` in every message; `expected.sdist` the file listed for `project` at `version` (`null` for none) and `expected.versions` every version it lists.

## Runners

- `release/nodejs/tests/conformance.test.ts`
- `release/rust/tests/conformance.rs`, which also pins each file's row count.
