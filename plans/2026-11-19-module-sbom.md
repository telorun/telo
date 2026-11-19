---
status: draft
priority: high
depends-on: []
packages: [kernel, analyzer, cli, apps/hub, apps/authoring-agent, modules/sqlite, modules/http-server, modules/tesseract, modules/pdf, modules/image, modules/ui-lucide, docs]
refinement: not-started
---

# A bill of materials for every module and application

## Problem

A bundled module inlines its third-party npm code into its artifact's controller or
library layer. It may also ship prebuilt native files staged from upstream through
`sources:`, and Rust controllers built from crates. None of that appears in the
consumer's lockfile.

An application that imports `http-server` runs `@fastify/static` 8.3.0, which carries
a path-traversal advisory. Yet `npm audit`, `osv-scanner` or `trivy` run on that
application's repository report nothing, because the application declares no npm
dependency at all. Nothing records what a published module contains. The hub hands
out the pin of a vulnerable version as readily as a clean one, and the authoring agent
picks versions through it.

## Constraints

None.

## Surface

**Added**

- Layer role `sbom`: a singleton layer with no selector, listed in the pinned `layers:` index of every module artifact published from now on.
- `sbom.cdx.json`: the layer's one file, a CycloneDX 1.6 JSON document; the path is reserved against author files.
- Media type `application/vnd.cyclonedx+json; version=1.6`: the record's format.
- CycloneDX properties `run.telo.layer.role` and `run.telo.layer.selector`: where each component occurs in the artifact.
- `sources.<name>.purl`: the package URL of a staged source, its version written with `{version}`; required unless the source has `build: { cargo }`.
- `sources.<name>.contains`: optional list of literal, versioned package URLs linked into the staged files.
- Diagnostic `SOURCE_PURL_INVALID`: a missing or malformed `purl` or `contains` entry, reported by `telo check` and refused by `telo publish`.
- CLI `telo sbom <manifest>`: writes one CycloneDX document covering an application's whole closure and the telo runtime running it.
- CLI `telo module sbom <ref>`: prints one module's own record, as published for an artifact and derived for a local path.
- Flags `--platform` and `--abi` on both commands, spelled as on `telo install`.
- Hub fields `advisories` and `advisoriesRecorded` on `get_module`, `list_module_versions` and `get_kinds` results and on the matching HTTP routes.

**Changed**

- `telo install` and `telo package` also warm the `sbom` layer of every module they fetch.
- The module-artifact specification v1.0 gains the `sbom` role and the record's derivation, as an additive amendment.

**Removed**

None.

## Solution

**The record lists exactly what the artifact carries, derived from build facts.** The
publisher derives it while building the layers, and any host derives it identically,
without executing anything, for a local module in a source checkout.

- **Inlined npm code.** Every file that contributes bytes to a controller, library or
  browser build output is attributed to the nearest package manifest that declares a
  name and a version. It is listed as `pkg:npm/<name>@<version>` with that package's
  license. Files tree-shaken away are not listed, and the module's own files are the
  module itself.
- **Staged sources.** Each staged source is listed under its `purl`, with its pinned
  SHA-256s as hashes. Every `contains` entry is listed beneath it, for example the
  SQLite inside better-sqlite3's prebuilt binary.
- **Rust controllers.** For a source built from a crate, every crate linked into it
  for that selector's target is listed from the crate's lockfile, as `pkg:cargo/…`.
  Dev, build and proc-macro crates are excluded.
- **Not listed.** Externals (`@telorun/sdk`, any specifier left external, a browser
  entry's host-supplied `external`) belong to the runtime or to the module supplying
  them.
- **Other modules by reference.** Imported and nested modules appear as module nodes
  identified by their pinned source, with the pin as hash and a dependency edge. A
  nested module carries its own record.
- **Where each component occurs.** Each component is tagged with the role and selector
  of every layer it occurs in, so one record answers for every platform.
- **Reproducible.** The document has no timestamp. Its serial number is derived from
  the module's identity and its other layers' integrity, and its order and
  serialization are canonical. Republishing an unchanged module yields the same digest
  and bumps nothing.

**Where it lives.** The record is a layer of its own, `sbom`, listed in the pinned
`layers:` index and pushed before the manifest layer. The chain from import pin to
`telo.yaml` to layer digest therefore proves it is the artifact's own record. A run
never materializes it. `telo install` and `telo package` warm it, so an offline cache
can answer. Older runtimes skip the unknown role under the specification's
unknown-role rule, so no `requires:` floor and no specification version bump are
needed. The specification is amended normatively, so a Rust publisher writes
identical bytes, and both analyzers' layer readers know the role.

**What consumers run.** Telo writes inventories; existing scanners judge them.

- `telo sbom <manifest>` writes one document to stdout and a summary to stderr. The
  document composes the application's own local modules (derived in place), every
  imported module's record (fetching only its `sbom` layer), child applications, and
  the telo distribution running the command. Each distribution answers its own
  component list: the single-file and Rust binaries carry one built in at release,
  and the npm distribution reads its installed package tree.
- A graph that `telo check` refuses has no record: the errors go to stderr, stdout
  stays empty, and the exit status is 1.
- An artifact with no `sbom` layer, published earlier or a pre-layers artifact,
  becomes a module node marked `incomplete`. A warning names the import and says it
  must be republished. The document is still written, with exit status 0.
- A packaged executable is accepted wherever a manifest is.
- `telo module sbom <ref>` mirrors `telo module manifest`.

**Hub.**

- At ingest, the hub stores each tracked version's components, read through
  `telo module sbom`.
- On a schedule, it queries OSV.dev's batch API once per distinct component and stores
  advisory ids per component.
- A version's advisories are joined when read, from its own components plus those of
  each pinned import's tracked version.
- A version with no record, or with an untracked import, reports
  `advisoriesRecorded: false`, never an empty list.
- Each advisory is served as OSV records it: id, summary, severity, affected
  component and fixed versions.
- A new ingest revision re-ingests tracked versions for their records.
- `telo upgrade` does not consult the hub.

**Adoption in the standard library.** The six modules with a `sources:` block (sqlite,
http-server, tesseract, pdf, image, ui-lucide) gain `purl`, plus `contains` where a
binary links other code. Because this widens what a module's own manifest may say,
`telo release floor` runs in the same change and its measurement is accepted. The
next release then republishes every module with its `sbom` layer.

**Documentation and agent.**

- The native-files guide documents `purl` and `contains`.
- The CLI reference documents both commands.
- The hub docs and MCP tool descriptions describe the advisory fields.
- The authoring-agent primer gains the commands and the `sources:` keys.
- `docs/guides/what-you-get.md` gains an entry under **Telo itself**: scanning what an
  application actually runs, inlined code included, with any standard scanner.
- `cli/rust` owes both commands, recorded beside its `telo publish` debt.

**Verify**

- Publishing `http-server` lists `@fastify/static` with its exact version, tagged with
  the `library` layer's role and selector.
- Removing an import from a bundle's source drops that component.
- Publishing twice from one tree gives identical `sbom` digests.
- `telo module sbom ./modules/sqlite` and the published version list the same
  components, including better-sqlite3 and its `contains`.
- `telo sbom` on an application importing a fixture module that inlines a package with
  a planted advisory, piped to `osv-scanner scan --sbom`, reports that advisory. The
  same application scanned through its own lockfile reports nothing.
  `trivy sbom` and `grype sbom:` read the same document without errors.
- `telo module sbom` downloads exactly one payload blob.
- Swapping the layer's bytes fails integrity.
- The previous released CLI runs an application importing a module republished with
  an `sbom` layer, with no diagnostic.
- A hub version whose component gains an OSV advisory after publish shows it after the
  next scheduled pass, with no re-ingest. A pre-`sbom` version reports
  `advisoriesRecorded: false`.

## Decisions

- **Producer, not scanner.** Advisory matching, severity, suppression, offline
  databases and SARIF are mature in OSV-Scanner, Trivy and Grype. Telo's unique
  knowledge is the closure. A built-in `telo audit` would add a second advisory feed
  and suppression format, and Telo modules have no OSV ecosystem of their own to
  justify one.
- **A pinned layer, not an OCI referrer.** A referrer is unpinned, so a republish can
  swap it while every pin still verifies. A nested module has no OCI manifest to attach
  one to, and referrer support varies by registry. A `common`-layer file would
  download with every controller, and a block in `telo.yaml` would make every manifest
  read pay for an inventory no scanner looks for there.
- **One singleton record, not one per selector.** Occurrence tags let one fetch answer
  for every platform.
- **CycloneDX 1.6 over SPDX.** It is read by Dependency-Track, Trivy, Grype and
  OSV-Scanner. It is also the only format that can mark one subtree `incomplete`,
  which an unrecorded import needs. SPDX 2.3 is compliance-oriented, and today's
  scanners barely read SPDX 3.0.
- **Derived from the bundle's inputs, not the lockfile or the bytes.** A lockfile lists
  more than ships, and inlined bytes no longer carry package identity. Only the build
  knows what it inlined.
- **`purl` on `sources:`, not `cargo-auditable`.** A third-party prebuilt binary never
  opted in to embedding its dependency list, so its identity must be declared.
- **Imported modules by reference only.** Copying a dependency's content into each
  parent stores one fact in many places, and the copies go stale.
- **Hub flags, `telo upgrade` does not.** A discovery service stays out of the path of a
  registry operation. The consumer's check is `telo sbom` plus a scanner.
