# Migrate telo module versioning to changie

## Problem

Telo is polyglot: a module's controllers may be Node (`pkg:npm`), Rust (`pkg:cargo`), or absent (manifest-only templates). Yet today **every** module's published version is driven by changesets, which is npm-only and keys off `modules/<name>/nodejs/package.json`. Manifest-only modules (`sql-repository`, `orm`, `workflow`) and Rust-only modules therefore cannot be versioned or published at all — `nodejs/package.json` is load-bearing for all module versioning. The telo registry needs a language-agnostic version source. `starlark` (Node + Rust) already proves the gap: its cargo controller is unversioned because nothing but changesets versions modules.

## Solution

Split ownership by artifact:

- **changesets keeps the npm packages** — the 34 published `@telorun/*` controller and core packages: versions, CHANGELOGs, and `npm publish`. Unchanged.
- **changie owns telo module manifests** — `metadata.version` in each `modules/<name>/telo.yaml` plus per-module `CHANGELOG.md`. A manifest is the unit, so Node, Rust, and manifest-only modules version identically.

The telo-registry push is already gated on `metadata.version` movement in `scripts/publish-packages.mjs` — that is the single, language-agnostic publish trigger for all modules.

One Version PR for the common case: `changie batch` + `merge` run **inside the changesets version step** (`scripts/version-packages.mjs`), committing module bumps to the same `changeset-release/main` branch as the npm bumps. When a controller's npm version bumps, `version-packages.mjs` auto-generates that module's changie fragment, so a controller change is a single PR carrying the npm bump *and* the manifest bump. A release that touches zero npm packages (pure manifest-only / Rust-only) has no changesets PR to ride; a fallback CI job in `.github/workflows/publish.yml` batches those fragments into a dedicated Module Release PR.

Per-module changie "projects" are declared in a generated `.changie.yaml` (`scripts/gen-changie-config.mjs`, drift-checked in CI). `.changes/` is the committed version ledger, bootstrapped from current `metadata.version`; a per-project `replacements` rule writes the new version back into each `telo.yaml`.

## Decisions

- **changie owns manifests, changesets owns npm packages** — split by artifact, because changie cannot publish to npm and changesets cannot version a non-npm artifact. Each tool does only what it is built for.
- **Module bumps ride in the changesets Version PR** (changie nested in the version step) — one PR for every npm-touching change. Rejected a permanently separate module-release PR (two PRs per controller change) and rejected replacing `changesets/action` wholesale (reimplementing its PR/tag/release machinery — more glue to own). A pure-module-only release is the lone exception and gets its own fallback PR.
- **A controller npm bump auto-generates the module's changie fragment** (matching the npm bump level) — one developer action (the changeset) still drives both, while changie stays the single module-version engine.
- **`version-packages.mjs` drops the npm→`metadata.version` derivation** (changie owns the version) but keeps the `pkg:npm` PURL rewrite — the manifest must still reference the published controller version.
- **One changie project per module; `.changes/` is the ledger, `telo.yaml` the synced output** via a `replacements` rule keyed on the 2-space-indented `version:` line. The rule is a file-global ReplaceAll, so `gen-changie-config.mjs` asserts each manifest has exactly one such line (CI drift-check enforces it) — a stray `version:` field is a build error, not silent corruption. Replacements run on `merge`, batching on `batch` — both wired into the release scripts.
- **Module bumps are capped below 1.0.0**, matching the existing changeset major-bump guard: `scripts/check-no-major-module-bump.mjs` rejects fragments whose kind auto-bumps to a major. Pre-1.0 modules use `Added`/`Fixed`.
- **Modules without a `metadata.version` (`dev`, `manifest`, `orm`) are excluded** until they declare one — they are not registry-publishable without a version.

## Example after the change

A contributor changes the `sql-repository` template and records the bump the same way for any language:

```
changie new --project sql-repository   # writes .changes/unreleased/<id>.yaml (kind: Added, body: ...)
```

On the next release the version step (or the module-only fallback job) runs `changie batch auto` + `merge`: `modules/sql-repository/telo.yaml` `metadata.version` goes `0.1.0 → 0.2.0`, `modules/sql-repository/CHANGELOG.md` gains the entry, and the merged PR publishes `std/sql-repository@0.2.0` to the registry via the existing `metadata.version` gate — no `package.json` anywhere.
