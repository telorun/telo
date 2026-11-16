---
status: draft
priority: medium
depends-on: []
packages: [analyzer, kernel, cli, modules, docs, apps/authoring-agent]
refinement: not-started
---

# Ejectable modules

## Problem

A published module cannot be taken home. Its artifact carries only the built controller bundle; the TypeScript or Rust it was built from is never published, so a user who wants to change a standard-library controller has nothing to start from. The published `telo.yaml` still names the source (`local_path=./nodejs/src/index.ts`), but no layer holds it. And no command materializes a module into a directory: `telo install` fills the cache and `telo module manifest` prints one file.

The kernel already runs a module from source when it sits on disk with no artifact behind it, so the missing pieces are only (a) publishing the source and (b) a command that writes a verified copy into a directory.

## Constraints

- Ejecting should have an option to rewrite the module import to point to the local directory containing the ejected source.

## Surface

**Added**
- Layer role `source` in the `layers:` index — singleton, no selector, holds a module's own code packages in normalized source form.
- `telo module eject <ref> <dir>` — writes the verified module into `<dir>` as an editable working copy; under `-o json` reports `{ module, version, pin, directory, written, omitted, packageRoots }`.
- `metadata.ejectedFrom` — the pinned ref a copy was ejected from; descriptive, kept by publish.
- Publish failure codes `source_dependency_unpublished`, `source_input_outside_module`, `source_pointer_missing`.
- Eject failure code `source_unpublished` — the module declares a source pointer but that version has no `source` layer.
- `EJECTED_MODULE_BYPASSED` — analyzer warning at an `imports:` entry that still reaches the original of an ejected copy.
- `CONTROLLER_DEPENDENCIES_NOT_INSTALLED` — `telo check` warning for a working-copy package that declares dependencies with no installed tree.

**Changed**
- Published module artifacts gain the `source` layer; every module republishes once (its `layers:` index changes its pin).
- `ERR_CONTROLLER_BUILD_FAILED` for an unresolved bare specifier names the package root and says its dependencies are not installed.
- `kernel/specs/module-artifact.md` gains the `source` role and a Source layer section.
- Standard-library module `package.json` scripts that reach outside the module directory (`prepack` / `postpack` copying the root `LICENSE`) are removed.

**Removed**
- None.

## Solution

**Publishing the source.** Publish writes one `source` layer whenever the published manifest keeps a source pointer: a controller candidate's `local_path`, an `exports.code` entry's `source`, an `exports.browser` entry's `source`. The publisher keeps all three in the published manifest. A module with no pointer (manifest-only, or prebuilt native controllers whose crate is named only by the stripped `sources:` block) publishes none, so binary-only delivery stays possible without a flag. There is no opt-in or opt-out.

The layer holds, for each code package (the directory of the nearest `package.json` or `Cargo.toml` above a pointer, inside the module directory): every file under it that the version-control ignore rules in force there do not exclude, minus the ecosystem's dependency and build directories (`node_modules/`, `target/`); plus every build input inside the module directory; minus every file another layer already carries (the built bundles, browser entries and their `.siblings.json`, `common`, `assets`, `native`). Tests and type-only files ship, so the copy type-checks and its tests run. Selection executes no module code and gives the same bytes under both staging modes.

Package manifests are normalized by the publisher: a `workspace:` / `catalog:` / `file:` / `link:` specifier becomes the exact version of the package installed for it; a dependency on a sibling module's code package is removed (the import graph supplies it); a `tsconfig` `extends` leaving the package root is flattened; `Cargo.toml` workspace inheritance is resolved and path dependencies become their published version. No lockfile ships. Third-party and other workspace code is referenced by version, never vendored.

Publish refuses with `source_dependency_unpublished` (a dependency no registry can serve: private, not installed, or a Cargo path dependency with no published version), `source_input_outside_module` (a build input outside the module directory that no declared dependency owns) or `source_pointer_missing`. The standard-library work this forces: every private workspace package a bundle inlines is either published (with its `source`-condition target in the tarball, so a rebuild inlines the same files) or moved into the module that inlines it.

**Never fetched by a runtime.** No controller, library, native, browser or module-file resolution, no cache warm (`telo install`, `--platform`) and no `telo package` touches the `source` layer; only eject does. Older runtimes skip the unknown role. Both analyzers and both kernels' layer-index readers recognize `source` as a singleton; a selector on it is a malformed index.

**Ejecting.** `telo module eject <ref> <dir>` refuses a non-empty `<dir>` before fetching, verifies every layer it will write against `blob` and `integrity` before extracting any, and is all-or-nothing under the artifact spec's path and link rules. It writes:
- every manifest of the manifest layer (nested ones included) with `layers:` removed and `metadata.ejectedFrom` added to the root; the `#sha256-…` pin of a relative import of a nested module is dropped, remote pins stay verbatim; edits are byte splices;
- the `source`, `common` and `assets` layers;
- every `native` layer and every non-JS controller / library layer, for every platform — the copy runs on other machines and nothing in it can rebuild them;
- no JS controller / library file and no browser entry whose source the `source` layer satisfies, so the kernel builds from source and a stale bundle cannot shadow an edit.

An unpinned ref is accepted; the pin of the fetched bytes is what `ejectedFrom` records. Eject never installs dependencies (lifecycle scripts would run module-supplied code at pull time); it names each package root that needs an install. A module declaring a source pointer whose version has no `source` layer (a pre-source version, a pre-layers artifact, a transport serving no layers) is refused with `source_unpublished`, naming the module, version and `telo module versions`. A module with no pointer ejects with its built files kept. If a released analyzer refuses `ejectedFrom`, eject raises the copy's `requires.telo` to the release introducing it.

**Using the copy.** The user changes the importer's `imports:` entry to the copy's relative path, unpinned. The copy keeps `metadata.name` (so every `kind:` keeps resolving) and `metadata.version` (the pin gate already refuses publishing changed bytes at that version and destination). The analyzer warns `EJECTED_MODULE_BYPASSED`, from the one load analysis so `telo check` and the kernel report it alike, when the same load still reaches the original's repository (matched by `ejectedFrom` without version and pin, never by name) through another import — typically a pinned library importing the original, which for a `shared` library would run a second instance. It is anchored at the entry module's `imports:` entry leading there and names the remedy: eject that importer too and point its import at the copy. `telo check` also warns `CONTROLLER_DEPENDENCIES_NOT_INSTALLED` for a working-copy package with declared dependencies and no install (a CLI probe; the analyzer stays browser-safe).

**Bookkeeping.** Fragments for `analyzer`, `kernel` and `cli`; `telo release floor` after `ejectedFrom` lands; a guide section on ejecting; a benefits-ledger entry under For module authors / Standard library; the authoring-agent primer and the nested guides of the changed packages. `cli/rust` owes `telo module eject` (listed as polyglot debt like `telo publish`).

## Decisions

- **A layer role, not a separate artifact or `common`.** A role keeps the source inside the pin chain (import pin → `telo.yaml` → layer digest) and matches the rule that a role keys when a layer is materialized. A referrer artifact is reached through mutable registry metadata outside the pin; `common` would download source on every run.
- **One singleton layer, no selector.** Eject always takes all of it; no runtime selects part.
- **Always published, derived from source pointers.** An opt-in leaves the standard library unejectable; a publish flag would make one commit publish two artifacts.
- **The publisher normalizes, eject only extracts.** Only the publisher has the workspace that resolves `workspace:` / `catalog:`; eject stays a pure verified extraction any CLI can implement.
- **References, never vendoring.** Vendoring copies every shared library into every dependent and redistributes third-party source under the module's license.
- **Omit built JS and browser files from the copy.** The loader falls back to a present bundle when esbuild is unavailable, which would silently run old code after an edit.
- **No dependency install.** Lifecycle scripts execute module-supplied code at pull time.
- **No override mechanism.** Telo imports are independently pinned edges, not one version per name; an override would rewrite edges inside pinned manifests. A relative import plus provenance and a warning covers it.
- **`ejectedFrom` over name matching.** Two publishers may share a module name.

## Complete example after the change

An application imports `oci://ghcr.io/telorun/sql@0.31.4#sha256-…` as `Sql` and its `Sql.Query` controller must change.

1. `telo module eject oci://ghcr.io/telorun/sql@0.31.4 ./vendor/sql` — verifies every layer, writes `./vendor/sql` (manifest with `metadata.ejectedFrom: oci://ghcr.io/telorun/sql@0.31.4#sha256-…`, `nodejs/src/**`, `nodejs/package.json`, docs, `LICENSE`), prints `./vendor/sql/nodejs` as the package root to install.
2. The user installs dependencies there and edits `nodejs/src/`.
3. The application's import becomes `Sql: ./vendor/sql`. `telo run` builds the controller from source; the next edit takes effect on the next run. Kinds stay `Sql.Query`.
4. If a pinned library the application also imports itself imports `sql`, `telo check` warns `EJECTED_MODULE_BYPASSED` at that `imports:` entry until the library is ejected too and pointed at `./vendor/sql`.

## Verify

- A published stdlib module's `layers:` holds exactly one selector-less `source` entry; `telo run` from a cold cache and `telo install --platform …` fetch no `source` blob.
- Extracting `source`, `common`, `assets` and `native` into an empty directory, installing with any package manager and building each entry yields JS bundles byte-identical to the published layer files; `tsc` passes in each package root.
- A fixture importing `../../shared/x.ts` is refused `source_input_outside_module`; one with a `workspace:*` dependency on a private package `source_dependency_unpublished`.
- A tampered layer blob makes eject write nothing; a pre-source version exits non-zero with `source_unpublished`; before install, running an ejected module fails naming the package root.
- Publishing the ejected copy back to the original destination at the unchanged version is refused by the pin gate.
- A pre-source runtime loads a republished module unchanged.
