---
status: done
priority: high
depends-on: []
packages: [kernel, analyzer, sdk, cli, apps/hub, apps/authoring-agent, modules/sqlite, modules/http-server, modules/tesseract, modules/tesseract-lang, modules/pdf, modules/image, modules/ui-lucide, packages/osv, modules/osv, docs]
refinement: not-ready
---

# A bill of materials for every module and application

## Problem

A bundled module inlines its third-party npm code into its artifact's controller or
library layer. It may also ship prebuilt native files staged from upstream through
`sources:`. None of that appears in the consumer's lockfile.

An application pinned to an `http-server` release built with `@fastify/static` 8.3.0
runs code with a published path-traversal advisory (GHSA-pr96-94w5-mx2h). Yet
`npm audit`, `osv-scanner` or `trivy` run on that application's repository report
nothing, because the application declares no npm dependency at all. Nothing records
what a published module contains. The hub hands out the pin of a vulnerable version as
readily as a clean one, and the authoring agent picks versions through it.

The established answer is a software bill of materials (SBOM): a machine-readable list
of every third-party component a piece of software ships, each with its exact version
and a package URL (purl), which vulnerability scanners match against advisory
databases. This plan gives every published module one, lets `telo sbom` write one for
a whole application, and lets `telo audit` check that application against known
advisories itself.

## Constraints

None.

## Surface

**Added**

- Layer role `sbom`: a singleton layer with no selector, listed in the pinned `layers:` index of every artifact with a `layers:` index published from now on.
- `sbom.cdx.json`: the layer's one file, a CycloneDX 1.6 JSON document at the root of the `sbom` layer, materialized into `<cache root>/layers/sha256-<hex>/`, never into a module directory.
- CycloneDX property `telo:layer`: one per layer a component occurs in, valued `role=<role>`, then `;` and the layer's canonical selector key when it has a selector (`role=native;abi=node-141;arch=arm64;format=node;os=darwin`, `role=assets`).
- CycloneDX property `telo:incomplete`: on a stored record's subject, one per layer holding code no producer reported, in the same grammar.
- `sources.<name>.purl`: the versionless package URL of the package advisories are filed against; its version is `sources.<name>.version`. Required on a fetched source, optional beside `build: { cargo }`.
- `sources.<name>.contains`: optional list of `{ purl, version, cpe?, vcs? }`, the code linked or bundled into the staged files.
- `sources.<name>.cpe`: optional CPE 2.3 name of the source's own package.
- `sources.<name>.vcs` and `sources.<name>.contains[].vcs`: optional `{ url, revision }`, both required, closed — the git repository and the full commit the component is built from.
- Telo format `vcs-url`: `git+https://<host>[:<port>]/<path>`, no user name, `@`, query or fragment; the format of `vcs.url`.
- Telo format `vcs-revision`: exactly 40 or 64 lower-case hexadecimal digits; the format of `vcs.revision`.
- Purl qualifier `vcs_url` in the record: a component declared with `vcs` carries it in its `purl` and `bom-ref`, valued `<url>@<revision>`, qualifiers in canonical form (keys lower-case and sorted, every octet outside `A–Z a–z 0–9 - . _ ~` percent-encoded).
- Diagnostic `SOURCE_REVISION_UNREACHABLE`: an error from `telo publish`, `telo release stage` and `telo audit`, at a `vcs.revision` no branch or tag of its repository reaches.
- Diagnostic `SOURCE_REPOSITORY_UNREADABLE`: an error from the same commands, at a `vcs.revision` whose host gave no history after retries or refused the protocol.
- `Osv.Query` input `components[].vcs` `{ url, revision }`, echoed on each output component.
- Telo format `package-url`: a well-formed Package URL carrying no version; the format of `purl` and `contains[].purl`.
- Telo format `cpe`: a CPE 2.3 formatted string; the format of `contains[].cpe`.
- Diagnostic `SBOM_INCOMPLETE`: a module in the closure has no complete record; an error from `telo sbom` and `telo audit`, a warning under `--allow-incomplete`.
- Diagnostic `COMPONENT_VULNERABLE`: an error from `telo audit`, a component in the closure with a known advisory that no `audit.ignore` entry accepts.
- Diagnostic `COMPONENT_UNCHECKED`: a warning from `telo audit`, a component OSV did not judge — matched neither by package type nor by a revision of a repository OSV records.
- Diagnostic `ADVISORY_LOOKUP_FAILED`: an error from `telo audit`, the advisory database gave no answer after retries.
- CLI `telo sbom <manifest>`: writes one CycloneDX document covering an application's whole module closure.
- CLI `telo module sbom <ref>`: prints one module's record, as published for an artifact and derived for a local path.
- CLI `telo audit <manifest>`: checks the closure `telo sbom` builds against OSV and reports each advisory at the import carrying it, with the upgrade that would remove it.
- `telo audit -o json`: the `telo check` envelope, each `COMPONENT_VULNERABLE` carrying `advisory` (`id`, `aliases`, `summary`, `severity`, `component`, `fixed`), `chain` (`{ alias, source }` per import from the application's to the carrying module) and `upgrade` (`{ alias, version, resolves }`, `resolves` `true`, `false` or `null`; `null` for a local module), plus a top-level `ignored` list of `{ id, reason, expires, component, chain }`.
- Flag `--osv-url <url>` on `telo audit` and env var `TELO_OSV_URL`: the OSV endpoint, flag over variable over `https://api.osv.dev`.
- `telo-workspace.yaml` block `audit:`, read by `telo audit` alone, with `ignore:`: a list of `{ id, reason, expires }`, each accepting one advisory (matched by id or alias) until its date.
- Package `@telorun/osv` (MIT): the OSV lookup — the package types OSV matches, the version control tools it matches commits of, the batch query, retries and each component's `checked` answer.
- Module `osv`, kind `Osv.Query`: the same lookup for a manifest — `baseUrl`, `components` of `{ purl, version, vcs? }` in, each component's `checked` and `advisories` out.
- Flags `--platform` and `--abi` on `telo sbom`, `telo module sbom` and `telo audit`, spelled as on `telo install`, narrowing the closure to the layers a target loads.
- Flag `--allow-incomplete` on `telo sbom` and `telo audit`: goes on past each unrecorded module, marking it `incomplete` in the document or judging the rest of the closure.
- Hub fields `advisories` and `advisoriesComplete` on `get_module` (full advisory items) and `list_module_versions` (items holding only `id`), and on the matching HTTP routes.
- A `# Advisories:` line after each module's import line in the text `get_kinds` returns.

**Changed**

- `telo install` and `telo package` also warm the `sbom` layer of every module they fetch.
- The module-artifact specification v1.0 gains the `sbom` role, what the record holds and how it is derived, what a reader adds, and the list of authoring-input blocks removed at publish, as an additive amendment.
- The specification's reserved-name rule (today `<path>.siblings.json`) also covers `sbom.cdx.json`: `telo publish` and `telo package` refuse an author file at that path.
- `telo release floor`, `telo release check` and the `telo publish` preflight measure a module as published: the authoring-input blocks (today `sources:`) are dropped before measuring.
- The release payload digest also covers the `sbom` layer, under the ledger key `sbom`.
- Hub `INGEST_REV` defaults to 12, so the deploy re-ingests every tracked version once for its record.
- The workspace marker's known blocks gain `audit`: `audti:` is a near-miss error, and an older telo warns about an unknown block.
- The tesseract module's `sources.tessdata` becomes `sources.tessdata-eng` and `sources.tessdata-osd`, one package each.
- `telo-app.json` `modules[].layers`, on `delivery: local` entries: the module's layer entries in module-artifact §3's shape, today one `{ role: sbom, blob, integrity }`; `delivery: artifact` entries carry none and the index `format` stays `1`.
- `cache/layers/sha256-<hex>/sbom.cdx.json`, written per local module by `telo package` into the payload's sealed layer store.
- A local `modules[].source` in `telo-app.json` is the manifest path relative to `app/`, a `telo.yaml` named by its directory (`.` for the root) and any other manifest by its file.

**Removed**

None.

## Solution

### The record

**It lists exactly what the artifact carries, as each producer reports it.** Every
producer of a payload reports the components it put into the bytes it produced, and
the record is the union of the reports. Publishing and local derivation run the same
producers. Deriving locally runs the builders `telo publish` runs and reuses their
cache; it executes no code the module supplies. The specification defines the record,
each producer's rule and the canonical serialization normatively, so a Rust publisher
writes identical bytes and a new controller format adds one producer.

- **Bundles** (controller, library and browser builds). Every input contributing bytes
  to an output is attributed by three ordered rules: an input inside the artifact root
  and beneath no `node_modules` is the module's own code and is not listed; otherwise
  the nearest `package.json` declaring a `name`, walking up from the input's real path
  and never above the innermost `node_modules/<package>`, lists it as
  `pkg:npm/<name>@<version>` with that package's license when it declares a `version`;
  anything else is unattributed and makes its layer incomplete, and `telo publish`
  names it. Inputs tree-shaken away are not listed. Node's bundle builder applies the
  rules to the inputs the metafile of the build it ran reports, kept in the build cache
  beside the bundle so a warm tree rebuilds nothing.
- **Staging** reports each third-party source under its `purl` at the source's
  `version`, and every `contains` entry as a component beneath it (`purl@version`,
  with its `cpe` when given). A source or `contains` entry declaring `vcs` carries it
  in its purl as the `vcs_url` qualifier, `<url>@<revision>`, so two revisions of one
  version are two components. A platform-split source names the parent package
  advisories are filed against (`pkg:npm/%40napi-rs/canvas`, not
  `canvas-linux-x64-gnu`); the occurrence properties say which platforms carry it.
  `contains` is the author's declaration of what a staged file links or bundles, and a
  `version` bump is when to revisit it — its `vcs` revision with it. A file upstream pre-bundled (http-server's
  staged `@scalar/fastify-api-reference` UI) is listed under its own identity, as a
  lockfile would list it.
- **Incomplete.** A payload file is recorded when a producer reported it, and the
  module's own authored files (`assets:` / `files:` / `common` content, notices,
  embedded files, the manifest) are the module itself. Compiled code the manifest
  declares that no producer reported — a `native:` file or platform-qualified
  controller `path=` no source with a `purl` stages, a `build:` source without a
  `purl`, a controller in a format no producer covers, a bundle input no package
  claims — makes the record incomplete:
  the stored subject carries one `telo:incomplete` property per such layer, and
  `telo sbom` treats the module as unrecorded whatever the flags. A new controller
  format therefore fails closed until its producer exists. Third-party content an
  author ships as a plain file is listed only when a `sources:` entry stages it.
- **Not listed.** Externals (`@telorun/sdk`, any specifier left external, a browser
  entry's host-supplied `external`) belong to the runtime or to the module supplying
  them. The telo running a command is never listed: it is scanned as its own release.
- **Where each component occurs.** Each component carries one `telo:layer` property
  per layer it occurs in, so one record answers for every platform.
- **Components carry no hashes.** A staged file's pin is per file and per platform,
  and advisory matching needs only the purl and the version.

**The stored record holds no fact that depends on where the artifact lives.** The pin
hashes `telo.yaml`, which lists the record's integrity, and a nested module's location
is its parent's digest, so neither can be written into the record. It holds the
module's name, version and license, the components with their occurrences, and the
edges from a package to what it contains — no subject `bom-ref`, no hashes, no module
nodes, no serial number. `telo sbom` and `telo module sbom` add, when they read it:

- the subject's and each module node's `bom-ref`: its integrity pin as `imports:`
  writes it (`sha256-<base64url>`); a local module never published uses its path
  relative to the entry's directory (`./`, `./modules/billing`), with `#` and `%`
  percent-encoded. Module nodes carry no `hashes`: the pin covers `telo.yaml`, not the
  artifact's content;
- one module node per pinned import and per nested module, with its dependency edge,
  read from the published `telo.yaml`, which already records them; one pin yields one
  node however many imports reach it;
- each module's components, never merged across modules: a component's `bom-ref` is
  qualified by its module's (`<module bom-ref>#<component bom-ref>`), each module node
  `dependsOn` the components of its own record that no other of them contains, and
  the record's contains edges are re-keyed to the qualified refs;
- a `serialNumber`, a name-based UUID (v5) over the canonical serialization of the
  emitted document with the serial left out.

The document has no timestamp, and its order and serialization are canonical, so
republishing an unchanged module yields the same digest and bumps nothing: every
array in UTF-16 code-unit order (`components` by `bom-ref`, `properties` by `name`
then `value`, `dependencies` by `ref`, `dependsOn` and `compositions[].assemblies` by
value, any other by each element's canonical serialization), every empty array member
omitted, then RFC 8785 and one line feed — the stored record, every document a reader
composes, and the input of its serial number alike. The JSON documents below are
formatted views of those canonical bytes.

**Published through the release payload.** The record is built by the one payload
builder `telo publish` and `telo release` share, as a layer among the others, so its
integrity is part of the module's payload digest under the ledger key `sbom`. The first
release after this change therefore moves every module once, and a change to a
`purl` or `contains` — authoring input, removed from the published `telo.yaml` —
republishes the module with the corrected record.

**Where it lives.** The record is a payload layer of its own, role `sbom`, carrying the
module layer media type with integrity over its one file `sbom.cdx.json`
(`application/vnd.cyclonedx+json; version=1.6`) at the layer's root. It is listed in
the pinned `layers:` index and pushed before the manifest layer, so the chain from
import pin to `telo.yaml` to layer digest proves it is the artifact's own record. The
role describes the artifact and holds no module file: the layer is never extracted
into a module directory (an owner and a nested file manifest share one, and each has a
record), but into `<cache root>/layers/sha256-<blob hex>/`, written under a temporary
name and renamed into place, its integrity re-derived from that directory on every
read. A run never materializes it. `telo install` and `telo package` warm it, so an
offline cache — a packaged payload's `cache/layers/` included — can answer; a reader
reads it from there and otherwise fetches that layer alone. A `Telo.Builtins` archive
carries one too: subject `type: data`, its name, version and `MIT`, no components. Older runtimes skip the unknown role under the specification's unknown-role
rule, so neither the role nor the record needs a `requires:` floor or a specification
version bump. Both analyzers' layer readers know the role.

### Declaring a staged source

Before, a source names where its files come from but not what they are:

```yaml
kind: Telo.Library
metadata:
  name: Vault
  version: 0.3.0
  license: MIT
  description: >-
    Embedded storage for an application: a SQLite file on disk, with rendered
    thumbnails of stored images.
exports: { kinds: [Store] }
native:
  - { name: better-sqlite3, format: node, os: linux, arch: amd64, libc: gnu, abi: node-141, path: ./native/linux-amd64-gnu-node-141/better_sqlite3.node }
  - { name: better-sqlite3, format: node, os: darwin, arch: arm64, abi: node-141, path: ./native/darwin-arm64-node-141/better_sqlite3.node }
  - { name: canvas, format: napi, os: linux, arch: amd64, libc: gnu, path: ./native/linux-amd64-gnu/skia.node }
  - { name: canvas, format: napi, os: darwin, arch: arm64, path: ./native/darwin-arm64/skia.node }
sources:
  better-sqlite3:
    version: 12.8.0
    url: https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-{upstream}.tar.gz
    archive: tar.gz
    notices: [./notices/better-sqlite3.LICENSE]
    entries:
      ./native/linux-amd64-gnu-node-141/better_sqlite3.node:
        { upstream: node-v141-linux-x64, member: build/Release/better_sqlite3.node, sha256: 0c1f6a7e2b9d4c3a8e5f7b1d2a6c9e4f3b8d1a7c5e2f9b4d6a3c8e1f7b2d5a9c, executable: true }
      ./native/darwin-arm64-node-141/better_sqlite3.node:
        { upstream: node-v141-darwin-arm64, member: build/Release/better_sqlite3.node, sha256: 7a2d9c4e1b8f3a6d5c2e9b7f4a1d8c3e6b9f2a5d7c4e1b8a3f6d9c2e5b7a4f1d, executable: true }
  canvas:
    version: 1.0.10
    url: https://registry.npmjs.org/@napi-rs/{upstream}/-/{upstream}-{version}.tgz
    archive: tar.gz
    notices: [./notices/napi-rs-canvas.LICENSE]
    entries:
      ./notices/napi-rs-canvas.LICENSE:
        { upstream: canvas, member: package/LICENSE, sha256: 8802fecf9da4367bc23bcf20b21cc143785fc6c92b152f3fa7fbe6ce08d344d6, executable: false }
      ./native/linux-amd64-gnu/skia.node:
        { upstream: canvas-linux-x64-gnu, member: package/skia.linux-x64-gnu.node, sha256: eff464d8c283ad1e73e36c636d9ec9a6469ae34c3c04b298794735c89f9c863a, executable: false }
      ./native/darwin-arm64/skia.node:
        { upstream: canvas-darwin-arm64, member: package/skia.darwin-arm64.node, sha256: 207921c48ce2f93b85548ffc1a1226d50d3e1c2cece96a711844828a62fdbabe, executable: false }
---
kind: Telo.Definition
metadata:
  name: Store
  description: >-
    Opens a SQLite file of stored images on start-up and renders their thumbnails on
    request.
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nodejs/vault.mjs&local_path=./nodejs/src/index.ts#Store
schema:
  type: object
  additionalProperties: false
  required: [file]
  properties:
    file: { type: string, x-telo-type: { name: Telo.HostPath, entry: file }, description: The database file; created when absent. }
```

After, each source says which package its files are a release of, and the
better-sqlite3 binary also declares the SQLite it links, with the CPE scanners that
match by CPE look it up under:

```yaml
kind: Telo.Library
metadata:
  name: Vault
  version: 0.3.0
  license: MIT
  description: >-
    Embedded storage for an application: a SQLite file on disk, with rendered
    thumbnails of stored images.
exports: { kinds: [Store] }
native:
  - { name: better-sqlite3, format: node, os: linux, arch: amd64, libc: gnu, abi: node-141, path: ./native/linux-amd64-gnu-node-141/better_sqlite3.node }
  - { name: better-sqlite3, format: node, os: darwin, arch: arm64, abi: node-141, path: ./native/darwin-arm64-node-141/better_sqlite3.node }
  - { name: canvas, format: napi, os: linux, arch: amd64, libc: gnu, path: ./native/linux-amd64-gnu/skia.node }
  - { name: canvas, format: napi, os: darwin, arch: arm64, path: ./native/darwin-arm64/skia.node }
sources:
  better-sqlite3:
    version: 12.8.0
    purl: pkg:npm/better-sqlite3
    contains:
      - { purl: pkg:generic/sqlite, version: 3.51.3, cpe: "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*" }
    url: https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-{upstream}.tar.gz
    archive: tar.gz
    notices: [./notices/better-sqlite3.LICENSE]
    entries:
      ./native/linux-amd64-gnu-node-141/better_sqlite3.node:
        { upstream: node-v141-linux-x64, member: build/Release/better_sqlite3.node, sha256: 0c1f6a7e2b9d4c3a8e5f7b1d2a6c9e4f3b8d1a7c5e2f9b4d6a3c8e1f7b2d5a9c, executable: true }
      ./native/darwin-arm64-node-141/better_sqlite3.node:
        { upstream: node-v141-darwin-arm64, member: build/Release/better_sqlite3.node, sha256: 7a2d9c4e1b8f3a6d5c2e9b7f4a1d8c3e6b9f2a5d7c4e1b8a3f6d9c2e5b7a4f1d, executable: true }
  canvas:
    version: 1.0.10
    purl: pkg:npm/%40napi-rs/canvas
    url: https://registry.npmjs.org/@napi-rs/{upstream}/-/{upstream}-{version}.tgz
    archive: tar.gz
    notices: [./notices/napi-rs-canvas.LICENSE]
    entries:
      ./notices/napi-rs-canvas.LICENSE:
        { upstream: canvas, member: package/LICENSE, sha256: 8802fecf9da4367bc23bcf20b21cc143785fc6c92b152f3fa7fbe6ce08d344d6, executable: false }
      ./native/linux-amd64-gnu/skia.node:
        { upstream: canvas-linux-x64-gnu, member: package/skia.linux-x64-gnu.node, sha256: eff464d8c283ad1e73e36c636d9ec9a6469ae34c3c04b298794735c89f9c863a, executable: false }
      ./native/darwin-arm64/skia.node:
        { upstream: canvas-darwin-arm64, member: package/skia.darwin-arm64.node, sha256: 207921c48ce2f93b85548ffc1a1226d50d3e1c2cece96a711844828a62fdbabe, executable: false }
---
kind: Telo.Definition
metadata:
  name: Store
  description: >-
    Opens a SQLite file of stored images on start-up and renders their thumbnails on
    request.
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nodejs/vault.mjs&local_path=./nodejs/src/index.ts#Store
schema:
  type: object
  additionalProperties: false
  required: [file]
  properties:
    file: { type: string, x-telo-type: { name: Telo.HostPath, entry: file }, description: The database file; created when absent. }
```

A source stages the files of one package. One that took several (tesseract's
`tessdata`, staging `@tesseract.js-data/eng` and `@tesseract.js-data/osd`) is split
into one source per package.

Every mistake in these keys is a schema violation: a fetched source without `purl`, and
a value the `package-url` or `cpe` format refuses. The After document with three slips
— the purl written with its version, a CPE with too few fields, and `purl` left off
`canvas`:

```
$ telo check ./telo.yaml
error SCHEMA_VIOLATION  telo.yaml:18:11
  sources.better-sqlite3.purl "pkg:npm/better-sqlite3@12.8.0" is not a package-url:
  it names a version (@12.8.0). A source's version is its `version:`; write
  pkg:npm/better-sqlite3
error SCHEMA_VIOLATION  telo.yaml:20:61
  sources.better-sqlite3.contains[0].cpe "cpe:2.3:a:sqlite:sqlite:3.51.3" is not a
  cpe: a CPE 2.3 formatted string has 13 colon-separated fields, this one has 6
error SCHEMA_VIOLATION  telo.yaml:30:5
  sources.canvas is fetched from a url and names no purl. Add the package URL its
  files are a release of, e.g. purl: pkg:npm/%40napi-rs/canvas
3 errors
$ echo $?
1
```

A source built from a crate in the module (`build: { cargo }`) may omit `purl`; its
bytes are the author's own code, and without a producer for its dependencies the
record is incomplete.

An author file at the record's path is refused at publish:

```
$ telo publish ./modules/vault
error publish_failed
  ./sbom.cdx.json is the path the module's bill of materials is written to. Rename
  the file or leave it out of `files:`.
$ echo $?
1
```

The `sbom` layer `telo publish` writes for Vault, covering every platform:

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "version": 1,
  "metadata": {
    "component": {
      "type": "library",
      "name": "Vault",
      "version": "0.3.0",
      "licenses": [{ "license": { "id": "MIT" } }]
    }
  },
  "components": [
    {
      "type": "library",
      "bom-ref": "pkg:generic/sqlite@3.51.3",
      "name": "sqlite",
      "version": "3.51.3",
      "purl": "pkg:generic/sqlite@3.51.3",
      "cpe": "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*",
      "properties": [
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux" },
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=arm64;format=node;os=darwin" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "pkg:npm/%40napi-rs/canvas@1.0.10",
      "name": "@napi-rs/canvas",
      "version": "1.0.10",
      "purl": "pkg:npm/%40napi-rs/canvas@1.0.10",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" },
        { "name": "telo:layer", "value": "role=native;arch=amd64;format=napi;libc=gnu;os=linux" },
        { "name": "telo:layer", "value": "role=native;arch=arm64;format=napi;os=darwin" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "pkg:npm/better-sqlite3@12.8.0",
      "name": "better-sqlite3",
      "version": "12.8.0",
      "purl": "pkg:npm/better-sqlite3@12.8.0",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" },
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux" },
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=arm64;format=node;os=darwin" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "pkg:npm/kysely@0.28.15",
      "name": "kysely",
      "version": "0.28.15",
      "purl": "pkg:npm/kysely@0.28.15",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" }
      ]
    }
  ],
  "dependencies": [
    { "ref": "pkg:npm/better-sqlite3@12.8.0", "dependsOn": ["pkg:generic/sqlite@3.51.3"] }
  ]
}
```

### What consumers run

**`telo sbom` writes the inventory for a team's own scanner; `telo audit` checks the
same closure itself.**

- `telo sbom <manifest>` writes one document to stdout and a summary to stderr. The
  document composes the application's own local modules (derived in place), every
  imported module's record (fetching only its `sbom` layer) and child applications.
  A packaged executable is accepted wherever a manifest is; its record covers the
  payload.
- **Platform scope.** With neither flag, the document covers every selector. The flags
  filter occurrences: an occurrence is kept when its layer has no selector or matches
  every axis the flags name, an axis the flags leave out keeps every value (unlike
  `telo install`, where a missing `--abi` skips abi layers), and a component left with
  no occurrence is dropped. Module nodes are always kept.
- A graph that `telo check` refuses has no record, and neither does a local module
  whose build fails: the error goes to stderr naming the module, stdout stays empty,
  and the exit status is 1, with or without `--allow-incomplete`.
- **Unrecorded modules are refused.** A module with no complete record — an artifact
  published without an `sbom` layer, a pre-layers artifact, or a record carrying
  `telo:incomplete` — is one `SBOM_INCOMPLETE` error anchored at the application's
  import reaching it. A module reached through another import is named with its chain,
  and the remedy is given for that depth: import a recorded version of a direct
  import, upgrade the import that pins an unrecorded one or ask its publisher to
  republish. Stdout stays empty and the exit status is 1. `--allow-incomplete` writes
  the document instead, with each such module node marked `incomplete` in the
  document's `compositions`, reports each as a warning, and exits 0.
- `telo module sbom <ref>` mirrors `telo module manifest`.

The application used below:

```yaml
kind: Telo.Application
metadata:
  name: Brochure
  version: 1.0.0
requires:
  telo: ">=0.133.0"
imports:
  Http: oci://ghcr.io/telorun/http-server@0.45.0
ports: { http: { env: PORT, default: 8080 } }
targets:
  - !ref server
  - { invoke: { kind: Telo.OpenUrl }, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: { kind: Http.Static, root: !module-path ./site } }
```

Producing the document and handing it to a scanner:

```
$ telo sbom ./telo.yaml > brochure.cdx.json
Brochure: 2 modules, 46 components, every selector
$ osv-scanner scan --sbom brochure.cdx.json
Scanned brochure.cdx.json file and found 46 packages
╭─────────────────────────────────────┬──────┬───────────┬─────────────────┬─────────┬───────────────────╮
│ OSV URL                             │ CVSS │ ECOSYSTEM │ PACKAGE         │ VERSION │ SOURCE            │
├─────────────────────────────────────┼──────┼───────────┼─────────────────┼─────────┼───────────────────┤
│ https://osv.dev/GHSA-83w8-p2f5-377r │ 7.5  │ npm       │ @fastify/static │ 10.1.0  │ brochure.cdx.json │
╰─────────────────────────────────────┴──────┴───────────┴─────────────────┴─────────┴───────────────────╯
$ echo $?
1
```

The same application pinned to `http-server@0.44.2`, published before the record
existed:

```
$ telo sbom ./telo.yaml > brochure.cdx.json
error SBOM_INCOMPLETE  telo.yaml:8:9
  Http (oci://ghcr.io/telorun/http-server@0.44.2) was published without a software
  bill of materials (SBOM: the list of third-party components it ships, which
  vulnerability scanners read), so what it ships cannot be listed. Import a version
  published with one (`telo upgrade`), or pass --allow-incomplete to write the
  document with this module marked incomplete.
1 error
$ echo $?
1
$ telo sbom ./telo.yaml --allow-incomplete > brochure.cdx.json
warning SBOM_INCOMPLETE  telo.yaml:8:9
  Http (oci://ghcr.io/telorun/http-server@0.44.2) was published without a software
  bill of materials (SBOM); it is marked incomplete and its contents are not listed.
Brochure: 2 modules, 0 components, every selector, 1 incomplete
$ echo $?
0
```

The document written under `--allow-incomplete`, with the reader-added identities:

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "serialNumber": "urn:uuid:8c3f1e27-5a9d-5b40-9e6c-1d7a2f4b8e93",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "bom-ref": "./",
      "name": "Brochure",
      "version": "1.0.0"
    }
  },
  "components": [
    {
      "type": "library",
      "bom-ref": "sha256-Z3aQs8Q0qiXMrxwC8RFylKFbxqMv4BE1d1wJ_akPtb8",
      "name": "HttpServer",
      "version": "0.44.2"
    }
  ],
  "dependencies": [
    { "ref": "./", "dependsOn": ["sha256-Z3aQs8Q0qiXMrxwC8RFylKFbxqMv4BE1d1wJ_akPtb8"] }
  ],
  "compositions": [
    { "aggregate": "incomplete", "assemblies": ["sha256-Z3aQs8Q0qiXMrxwC8RFylKFbxqMv4BE1d1wJ_akPtb8"] }
  ]
}
```

The same application importing `Billing: oci://ghcr.io/acme/billing@1.2.0` in place of
`Http`, where Billing was published with a record but pins `http-server@0.44.2`:

```
$ telo sbom ./telo.yaml > brochure.cdx.json
error SBOM_INCOMPLETE  telo.yaml:8:12
  Billing (oci://ghcr.io/acme/billing@1.2.0) imports HttpServer
  (oci://ghcr.io/telorun/http-server@0.44.2), which was published without a software
  bill of materials (SBOM: the list of third-party components it ships, which
  vulnerability scanners read). Upgrade Billing to a version pinning a recorded HttpServer, ask its
  publisher to republish, or pass --allow-incomplete.
1 error
$ echo $?
1
```

A local module whose build fails is the build's own error, which no flag lets through:

```
$ telo sbom ./telo.yaml --allow-incomplete
error ERR_CONTROLLER_BUILD_FAILED  modules/invoices/telo.yaml:21:5
  Invoices.Render: the controller ./nodejs/src/index.ts could not be built: Could not
  resolve "pdfkit" (imported by nodejs/src/render.ts). Install the module's
  dependencies and run again.
1 error
$ echo $?
1
```

An application using Vault, composed: each component is qualified by the module
carrying it, and the module node depends on its own top-level components.

```yaml
kind: Telo.Application
metadata:
  name: Gallery
  version: 1.0.0
imports:
  Vault: oci://ghcr.io/acme/vault@0.3.0
variables:
  dbFile: { env: GALLERY_DB, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: ./gallery.db }
---
kind: Vault.Store
metadata: { name: store }
file: !cel "variables.dbFile"
```

```
$ telo sbom ./telo.yaml --platform linux/amd64/gnu --abi node-141
Gallery: 2 modules, 4 components, linux/amd64/gnu node-141
```

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "serialNumber": "urn:uuid:2e9b7c41-0d3a-5f68-b1e4-7a5c9d2f6e18",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "bom-ref": "./",
      "name": "Gallery",
      "version": "1.0.0"
    }
  },
  "components": [
    {
      "type": "library",
      "bom-ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE",
      "name": "Vault",
      "version": "0.3.0",
      "licenses": [{ "license": { "id": "MIT" } }]
    },
    {
      "type": "library",
      "bom-ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:generic/sqlite@3.51.3",
      "name": "sqlite",
      "version": "3.51.3",
      "purl": "pkg:generic/sqlite@3.51.3",
      "cpe": "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*",
      "properties": [
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/%40napi-rs/canvas@1.0.10",
      "name": "@napi-rs/canvas",
      "version": "1.0.10",
      "purl": "pkg:npm/%40napi-rs/canvas@1.0.10",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" },
        { "name": "telo:layer", "value": "role=native;arch=amd64;format=napi;libc=gnu;os=linux" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/better-sqlite3@12.8.0",
      "name": "better-sqlite3",
      "version": "12.8.0",
      "purl": "pkg:npm/better-sqlite3@12.8.0",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" },
        { "name": "telo:layer", "value": "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux" }
      ]
    },
    {
      "type": "library",
      "bom-ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/kysely@0.28.15",
      "name": "kysely",
      "version": "0.28.15",
      "purl": "pkg:npm/kysely@0.28.15",
      "licenses": [{ "license": { "id": "MIT" } }],
      "properties": [
        { "name": "telo:layer", "value": "role=controller;format=js" }
      ]
    }
  ],
  "dependencies": [
    { "ref": "./", "dependsOn": ["sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE"] },
    {
      "ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE",
      "dependsOn": [
        "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/%40napi-rs/canvas@1.0.10",
        "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/better-sqlite3@12.8.0",
        "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/kysely@0.28.15"
      ]
    },
    {
      "ref": "sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:npm/better-sqlite3@12.8.0",
      "dependsOn": ["sha256-Vq3J8nR2xT5mL9cK1wF7hD4pZ6sA0eY2uG8bN3iQ5oE#pkg:generic/sqlite@3.51.3"]
    }
  ]
}
```

Every darwin occurrence is gone; no component lost its last occurrence, so all four
remain.

### Auditing an application

`telo audit <manifest>` takes what `telo sbom` takes, builds the same closure, and
gives `--platform`, `--abi` and `--allow-incomplete` the meaning they have there. It
sends each component's package URL and version to OSV through `@telorun/osv` and
contacts no hub.

- **Findings.** Each advisory is one `COMPONENT_VULNERABLE` error on stderr in the
  `telo check` format, anchored at the application's `imports:` entry reaching the
  carrying module and naming its chain (a component of the application's own module
  is anchored at its module document). It names the advisory, its aliases, its summary,
  its severity as OSV records it, and the component's fixed versions. There is no
  severity threshold.
- **The upgrade hint.** For a component of an imported module, the hint is the
  version `telo upgrade` would select for the direct import reaching it — the same
  newest-first walk and prerelease rule. That version's closure is read from the
  registry (only `sbom` layers, under the same platform filter) and checked in a
  second batch. The hint then says the upgrade removes the advisory, or that the
  newest usable version still carries it, naming the module in the chain that pins it,
  or that it cannot tell (the candidate is unrecorded, or the registry did not answer)
  and why. For a component of a local module it names the dependency or the
  `sources.<name>.version` to raise. A hint never changes the exit status, and an
  accepted advisory gets none.
- **Unchecked components.** A component OSV did not judge is one `COMPONENT_UNCHECKED`
  warning at the import carrying it, naming the component and its CPE, with `telo sbom`
  into a CPE-matching scanner as the remedy: a `pkg:generic` one with no `vcs` (for a
  local module's, the warning names `sources.<name>.contains[<i>]` to declare `vcs:`
  on), or one built from a repository OSV records no advisory against, named with its
  repository and commit. It does not change the exit status.
- **Embedded code by commit.** A component with `vcs` is checked when the tool is one OSV
  matches commits of (`git`, data in `@telorun/osv` beside the purl-type table) and OSV
  names the repository in at least one record — one probe per distinct repository, a
  package query with no version — and its revision is in that repository's history. The
  history is never inferred from OSV, since GitHub serves a fork network's commits
  through every repository of it: `telo publish` (and `telo release stage`) reads the
  repository's commits over git's smart HTTP protocol, commits only, before writing the
  record, and `telo audit` does the same for a local module. A revision no branch or tag
  reaches is `SOURCE_REVISION_UNREACHABLE` at its `vcs.revision`, a host giving no
  history `SOURCE_REPOSITORY_UNREADABLE`. The advisories are then OSV's answer to a commit
  query, added to the purl-and-version answer when the purl's type is matched too, and
  `COMPONENT_VULNERABLE` says `Fixed by commit <sha> of <repository>` for one the
  revision alone matched.
- **The lookup.** `--osv-url` overrides `TELO_OSV_URL`, which overrides
  `https://api.osv.dev`; a value that is not an http or https URL refuses the
  invocation. Every OSV request of the run goes there, the hint's included, and a
  summary names it when it is not the default. A request is retried on a timeout, a
  failed connection, a 429 (honouring `Retry-After`) or a 5xx, with jittered backoff:
  at most 4 attempts, 30 s each, 120 s for the whole lookup. After that the run is one
  unanchored `ADVISORY_LOOKUP_FAILED` naming the endpoint and the cause, and no
  component is reported clean: one failed batch fails the run. There is no offline
  mode; offline, `telo sbom` (answered from the cache `telo install` warms) goes into a
  scanner with a local database.
- **Accepting an advisory.** The `audit:` block of the `telo-workspace.yaml` governing
  the application lists `ignore:` entries of `{ id, reason, expires }`, all three
  required, `expires` a date. An entry matches an advisory whose `id` or any alias
  equals its `id`; a matched advisory is not an error and is listed as ignored, with
  its reason and expiry, in the summary and in `-o json`. Once `expires` has passed the
  entry no longer applies, and the advisory's `COMPONENT_VULNERABLE` names the expired
  entry. A problem inside `audit:` refuses `telo audit` (`WORKSPACE_UNKNOWN_KEY`,
  `WORKSPACE_INVALID_VALUE`). An application outside a workspace adds a marker; one
  holding only `audit:` is valid.
- **Exit status.** 0 when no `COMPONENT_VULNERABLE` remains; 1 on a
  `COMPONENT_VULNERABLE`, an `SBOM_INCOMPLETE` without `--allow-incomplete`, an
  `ADVISORY_LOOKUP_FAILED`, a graph `telo check` refuses, a local build failure or a
  problem inside `audit:`; 2 for a refused invocation.

Brochure, pinned to `http-server@0.45.0`:

```
$ telo audit ./telo.yaml
error COMPONENT_VULNERABLE  telo.yaml:8:9
  Http (oci://ghcr.io/telorun/http-server@0.45.0) ships @fastify/static 10.1.0, which
  has GHSA-83w8-p2f5-377r (CVE-2026-15074, CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N):
  @fastify/static fails to reject dot-dot path segments, bypassing route guards.
  Fixed in @fastify/static 10.1.1. `telo upgrade` moves Http to 0.46.0, which no
  longer carries it.
Brochure: 2 modules, 46 components checked, every selector
1 error
$ echo $?
1
```

The same run under `-o json`, the envelope on stdout:

```json
{
  "ok": false,
  "errorCount": 1,
  "warnCount": 0,
  "diagnostics": [
    {
      "file": "telo.yaml",
      "line": 8,
      "column": 9,
      "severity": "error",
      "code": "COMPONENT_VULNERABLE",
      "message": "Http (oci://ghcr.io/telorun/http-server@0.45.0) ships @fastify/static 10.1.0, which has GHSA-83w8-p2f5-377r (CVE-2026-15074, CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N): @fastify/static fails to reject dot-dot path segments, bypassing route guards. Fixed in @fastify/static 10.1.1. `telo upgrade` moves Http to 0.46.0, which no longer carries it.",
      "advisory": {
        "id": "GHSA-83w8-p2f5-377r",
        "aliases": ["CVE-2026-15074"],
        "summary": "@fastify/static fails to reject dot-dot path segments, bypassing route guards",
        "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
        "component": "pkg:npm/%40fastify/static@10.1.0",
        "fixed": ["10.1.1"]
      },
      "chain": [{ "alias": "Http", "source": "oci://ghcr.io/telorun/http-server@0.45.0" }],
      "upgrade": { "alias": "Http", "version": "0.46.0", "resolves": true }
    }
  ],
  "ignored": []
}
```

`resolves` is `false` when the selected version still carries the advisory and `null`
when the audit cannot tell, the message saying why; `upgrade` is `null` for a
component of a local module.

Accepting it in the workspace marker beside the application:

```yaml
audit:
  ignore:
    - id: CVE-2026-15074
      reason: Brochure serves its own static site; no route guard sits in front of Http.Static.
      expires: 2026-12-31
```

```
$ telo audit ./telo.yaml
Brochure: 2 modules, 46 components checked, every selector
ignored GHSA-83w8-p2f5-377r (CVE-2026-15074) in Http, @fastify/static 10.1.0, until
  2026-12-31: Brochure serves its own static site; no route guard sits in front of
  Http.Static.
$ echo $?
0
```

The same run on 2027-01-04:

```
$ telo audit ./telo.yaml
error COMPONENT_VULNERABLE  telo.yaml:8:9
  Http (oci://ghcr.io/telorun/http-server@0.45.0) ships @fastify/static 10.1.0, which
  has GHSA-83w8-p2f5-377r (CVE-2026-15074, CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N):
  @fastify/static fails to reject dot-dot path segments, bypassing route guards.
  Fixed in @fastify/static 10.1.1. `telo upgrade` moves Http to 0.46.0, which no
  longer carries it. The audit.ignore entry accepting it (telo-workspace.yaml:3:7)
  expired on 2026-12-31.
Brochure: 2 modules, 46 components checked, every selector
1 error
$ echo $?
1
```

An entry without a reason:

```
$ telo audit ./telo.yaml
error WORKSPACE_INVALID_VALUE  telo-workspace.yaml:3:7
  audit.ignore[0] has no reason. Every accepted advisory says why it is accepted,
  beside its id and expires.
1 error
$ echo $?
1
```

Gallery, whose Vault embeds SQLite:

```
$ telo audit ./telo.yaml --platform linux/amd64/gnu --abi node-141
warning COMPONENT_UNCHECKED  telo.yaml:6:10
  Vault (oci://ghcr.io/acme/vault@0.3.0) ships sqlite 3.51.3 (pkg:generic/sqlite,
  cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*), which no advisory database matches by
  version. Check it with a scanner that matches by CPE:
  telo sbom ./telo.yaml > gallery.cdx.json && grype sbom:gallery.cdx.json
Gallery: 2 modules, 3 of 4 components checked, linux/amd64/gnu node-141
1 warning
$ echo $?
0
```

Brochure importing `Billing: oci://ghcr.io/acme/billing@1.2.0` in place of `Http`,
where Billing pins `http-server@0.45.0` and its newest version still does:

```
$ telo audit ./telo.yaml
error COMPONENT_VULNERABLE  telo.yaml:8:12
  Billing (oci://ghcr.io/acme/billing@1.2.0) imports HttpServer
  (oci://ghcr.io/telorun/http-server@0.45.0), which ships @fastify/static 10.1.0,
  which has GHSA-83w8-p2f5-377r (CVE-2026-15074,
  CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N): @fastify/static fails to reject
  dot-dot path segments, bypassing route guards. Fixed in @fastify/static 10.1.1.
  `telo upgrade` moves Billing to 1.3.0, which still pins HttpServer 0.45.0: ask
  Billing's publisher for a version over a fixed HttpServer, or accept the advisory
  in telo-workspace.yaml.
Brochure: 3 modules, 61 components checked, every selector
1 error
$ echo $?
1
```

An OSV mirror that does not answer, and an address that is not one:

```
$ TELO_OSV_URL=https://osv.internal.acme.dev telo audit ./telo.yaml
error ADVISORY_LOOKUP_FAILED
  https://osv.internal.acme.dev/v1/querybatch gave no answer after 4 attempts: connect
  ECONNREFUSED 10.0.4.12:443. No component was judged. Check the address
  (--osv-url, TELO_OSV_URL) or the network, and run again.
1 error
$ echo $?
1
$ telo audit ./telo.yaml --osv-url ftp://osv.internal.acme.dev
Invalid value for --osv-url: "ftp://osv.internal.acme.dev" is not an http or https URL.
$ echo $?
2
```

### Hub

- At ingest, the hub stores each tracked version's components, read through
  `telo module sbom`.
- On a schedule, it calls `Osv.Query` once per distinct component and stores advisory
  ids per component; that table is the one source. A component is its purl, version and
  revision. Which components are checked is `Osv.Query`'s `checked` answer, the same
  one `telo audit` reads: the hub holds no list of package types or tools of its own,
  and a `pkg:generic` component is checked only by the revision of a repository OSV
  records.
- A version's advisories cover its transitive pinned closure, nested modules included.
  They are materialised per version as a derived read model, recomputed by the
  scheduled pass, by ingest and by a change in tracking status, and served as stored.
- `advisoriesComplete` is false when any module in the closure is untracked or has no
  complete record, or a component is of a type the hub does not check or has not been
  queried yet. An empty list is clean only beside `advisoriesComplete: true`.
- `get_module` serves each advisory as OSV records it: `id`, `aliases`, `summary`,
  `severity`, the affected `component` and the `fixed` versions. `list_module_versions`
  serves the same items holding only `id`, one per distinct advisory in the closure, so
  a caller choosing a version is not sent every summary for every version.
- `telo upgrade` does not consult the hub.

`list_module_versions` (and `GET /module/versions`):

```
GET /module/versions?ref=oci://ghcr.io/telorun/http-server
```

```json
{
  "ref": "oci://ghcr.io/telorun/http-server",
  "versions": [
    {
      "version": "0.46.0",
      "integrity": "sha256-q8Vd1kR3mZ7wT2pXc5LbN9fH4jE6sA0uYgK1oQ3iWzM",
      "advisories": [],
      "advisoriesComplete": true
    },
    {
      "version": "0.45.0",
      "integrity": "sha256-Hc2nT7yU4oB9eR1wL6kZ3mX8vP5aJ0dGfS2qN7iKtE4",
      "advisories": [{ "id": "GHSA-83w8-p2f5-377r" }],
      "advisoriesComplete": true
    },
    {
      "version": "0.44.2",
      "integrity": "sha256-Z3aQs8Q0qiXMrxwC8RFylKFbxqMv4BE1d1wJ_akPtb8",
      "advisories": [],
      "advisoriesComplete": false
    }
  ]
}
```

`get_module` (and `GET /module?ref=oci://ghcr.io/telorun/http-server&version=0.45.0`)
adds these two members beside the module's existing ones:

```json
{
  "advisories": [
    {
      "id": "GHSA-83w8-p2f5-377r",
      "aliases": ["CVE-2026-15074"],
      "summary": "@fastify/static fails to reject dot-dot path segments, bypassing route guards",
      "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
      "component": "pkg:npm/%40fastify/static@10.1.0",
      "fixed": ["10.1.1"]
    }
  ],
  "advisoriesComplete": true
}
```

`get_kinds` answers in text. Each module's import line stays exactly the line to copy,
and an `# Advisories:` line follows it, always present for a module answered at a
version — naming each advisory, saying none, or saying unchecked when
`advisoriesComplete` is false — plus the newest clean and complete version when that is
another one:

```
# HttpServer
# imports:
#   HttpServer: oci://ghcr.io/telorun/http-server@0.45.0#sha256-Hc2nT7yU4oB9eR1wL6kZ3mX8vP5aJ0dGfS2qN7iKtE4
# Advisories: GHSA-83w8-p2f5-377r (pkg:npm/%40fastify/static@10.1.0, fixed in 10.1.1); newest clean and complete: 0.46.0
```

The MCP tool descriptions and the primer tell the agent: the `# Advisories:` line
describes that version and is never written into a manifest; pick the newest version
with no advisories and `advisoriesComplete: true`; when every version has advisories,
use the newest and name them to the user; when no version is complete (a module
embedding C code), use the newest with no advisories and tell the user its embedded
code is unchecked; never read an empty list beside `advisoriesComplete: false` as
clean.

### The OSV lookup

`@telorun/osv` (MIT) owns the lookup once: the package types OSV matches by version,
as data (purl type to OSV ecosystem); the batch query, chunked at OSV's per-request
limit and following page tokens; fetching each advisory's full record and shaping it
as the hub's advisory item; the retries above; and each component's `checked` answer.
The CLI depends on it. The hub, a declarative application, reaches it through the
standard-library module `osv`, whose one kind `Osv.Query` (an invocable) wraps it:
`baseUrl` (a `Telo.Url`, http or https, default `https://api.osv.dev`), input
`components`, a list of `{ purl, version, vcs? }` with the purl in the `package-url`
format and `vcs` in the `vcs-url` and `vcs-revision` formats, and output `components`,
each echoing its input with its `checked` answer and its `advisories`. The
caller bounds each call's input.

```yaml
kind: Telo.Application
metadata:
  name: AdvisoryCheck
  version: 1.0.0
imports:
  Osv: oci://ghcr.io/telorun/osv@0.1.0
  Console: oci://ghcr.io/telorun/console@0.19.4
targets:
  - name: query
    invoke: { kind: Osv.Query }
    inputs:
      components:
        - { purl: pkg:npm/%40fastify/static, version: 10.1.0 }
        - { purl: pkg:generic/sqlite, version: 3.51.3 }
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "${{ steps.query.result.components.filter(c, c.advisories.size() > 0).size() }} vulnerable, ${{ steps.query.result.components.filter(c, !c.checked).size() }} unchecked"
```

The query step's result:

```json
{
  "components": [
    {
      "purl": "pkg:npm/%40fastify/static",
      "version": "10.1.0",
      "checked": true,
      "advisories": [
        {
          "id": "GHSA-83w8-p2f5-377r",
          "aliases": ["CVE-2026-15074"],
          "summary": "@fastify/static fails to reject dot-dot path segments, bypassing route guards",
          "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
          "component": "pkg:npm/%40fastify/static@10.1.0",
          "fixed": ["10.1.1"]
        }
      ]
    },
    { "purl": "pkg:generic/sqlite", "version": "3.51.3", "checked": false, "advisories": [] }
  ]
}
```

A lookup that fails after its retries is the invocation's `ADVISORY_LOOKUP_FAILED`
error, so the hub's pass records the failure and changes no stored advisory.

### Release floor

`sources:` is removed from the published `telo.yaml`, so a consumer never reads the new
keys. Floor measurement, `telo release check` and the `telo publish` preflight
therefore judge a module as it is published: the specification lists the
authoring-input blocks removed at publish (today `sources:` alone), and the
measurement copy drops every block on that list. The adopting modules' floors do not
change. An older telo run on a source checkout as its entry reports the `sources:`
schema violation rather than `MODULE_REQUIRES_NEWER_RUNTIME`.

### Adoption in the standard library

Every module with a `sources:` block gains `purl`, plus `contains` where a binary links
other code: sqlite, http-server, tesseract, pdf, image, ui-lucide, and every generated
`tesseract-lang` module, whose generator emits `purl`. Tesseract's `tessdata` is split
into `tessdata-eng` and `tessdata-osd`. Because the record is part of the payload
digest, the next release republishes every module with its `sbom` layer.

### Documentation and agent

- The native-files guide documents `purl`, `contains` (the author's declaration,
  revisited on a `version` bump), one package per source, and the `package-url` and
  `cpe` formats.
- The CLI reference documents both commands, `--allow-incomplete`, `SBOM_INCOMPLETE`,
  the build-failure behaviour, and the filter semantics of `--platform` / `--abi` with
  their contrast to `telo install`. Its page opens by saying what an SBOM is and when
  one is needed (a scanner gate in CI, a customer or regulator asking for one) before
  the commands, and the `--help` text of `telo sbom` and `telo module sbom` opens with
  the same one-sentence definition. It documents `telo audit`: its three codes, the
  upgrade hint, `--osv-url` / `TELO_OSV_URL` and their order, the exit status, and the
  offline path (`telo sbom` into a scanner).
- The workspaces guide documents the `audit:` block and its `ignore:` entries.
- `modules/osv` carries `license: MIT`, a `LICENSE`, a README and `docs/` describing
  `Osv.Query`, `baseUrl` and the `checked` answer; `packages/osv` joins the MIT
  directory list (`pnpm run check:licenses`, the root README).
- The module-artifact specification gains the `sbom` role, the stored record and what a
  reader adds, the derivation and the incompleteness rule, the composition rule, the
  `telo:layer` / `telo:incomplete` grammar, the reserved `sbom.cdx.json` path and the
  authoring-input list; the CLI guide's reserved-name paragraph names the path.
- The root `CLAUDE.md` "Layered module artifacts" paragraph lists the `sbom` role; the
  nested `CLAUDE.md` guides of the analyzer, kernel, CLI, release and hub packages
  record what each now owns.
- The requirements guide and the root `CLAUDE.md` section on changing the grammar state
  that a block removed at publish is not measured.
- The hub README, the hub `CLAUDE.md` (the closure read model, and that coverage is
  `Osv.Query`'s `checked` answer) and the MCP tool descriptions describe the advisory fields and how to read
  them.
- The authoring-agent primer gains the commands, the `sources:` keys, how to read an
  `SBOM_INCOMPLETE` refusal and the three `telo audit` codes, that an accepted advisory
  needs a reason and an expiry, the rule that the `# Advisories:` line is never copied,
  and the version-picking rule above.
- `docs/guides/what-you-get.md` gains one entry under **Telo itself**: checking what an
  application actually runs, inlined code included, against known vulnerabilities with
  `telo audit` — each finding named at the import carrying it with the upgrade that
  removes it — or handing `telo sbom`'s inventory to any standard scanner.
- `cli/rust` owes `telo sbom`, `telo module sbom` and `telo audit`, recorded beside its
  `telo publish` debt, and `@telorun/osv` gains its Rust twin with a shared vector set
  when `cli/rust` takes `telo audit`; both analyzers check the two formats against one
  conformance set.

## Verify

- Publishing `http-server` lists `@fastify/static` at its exact version, with a
  `telo:layer` property for the `library` layer's role and selector, and lists
  `@scalar/fastify-api-reference` under its own identity.
- Removing an import from a bundle's source drops that component.
- Publishing twice from one tree gives identical `sbom` digests, and mirroring an
  artifact to another registry leaves every layer digest unchanged.
- `telo module sbom ./modules/sqlite` and `telo module sbom` of the published version
  agree on every component, occurrence and edge, better-sqlite3's `contains` included,
  and differ only in the subject's `bom-ref` and serial number.
- The image module's record lists one `@napi-rs/canvas@1.0.10` component occurring in
  every canvas native layer, and no `canvas-<platform>` component.
- `telo sbom` on an application importing a fixture module that inlines a package with
  a planted advisory, and one staging a source whose `purl` names a package with a
  known advisory at the staged version, piped to `osv-scanner scan --sbom`, reports
  both advisories. The same application scanned through its own lockfile reports
  nothing. `trivy sbom` and `grype sbom:` read the same document without errors, and
  `grype sbom:` matches an SQLite CVE through a `contains` entry's `cpe`.
- `telo sbom` of an application importing sqlite lists better-sqlite3 with every
  native occurrence on any host; `--platform linux/amd64/gnu` keeps both abi variants;
  adding `--abi node-141` keeps one.
- `telo sbom` of one application gives identical bytes under the npm CLI and the
  standalone binary.
- An application importing a fixture artifact with no `sbom` layer: `telo sbom` exits
  1 with stdout empty and stderr naming the import; with `--allow-incomplete` it exits
  0, the node is marked `incomplete`, and one warning is printed.
- `telo sbom` on an application whose local module imports an uninstalled package exits
  1, stdout empty, stderr naming the module and the unresolved import, with
  `--allow-incomplete` too.
- `purl: pkg:npm/better-sqlite3@12.8.0`, a malformed `cpe`, and a fetched source
  without `purl` are each a `SCHEMA_VIOLATION`; a `build:` source with a `purl` gives a
  complete record; both analyzers pass the `package-url` and `cpe` conformance sets.
- A fixture module with a checked-in `native:` file no source stages publishes a record
  carrying `telo:incomplete` for that layer, and `telo sbom` of a consumer refuses it
  with `SBOM_INCOMPLETE` on every platform.
- An application importing two modules that both inline `kysely@0.28.15` gets two
  `kysely` components, each a dependency of its own module node; `osv-scanner`,
  `trivy sbom` and `grype sbom:` read it and report a planted advisory.
- A transitive unrecorded module is refused at the direct import, naming the chain.
- `telo release status` on the change lists every module with an added `sbom` layer,
  and a change touching only a `purl` moves only that module's `sbom` digest and its
  `manifest` digest (the `layers:` index lists the record), with every dependent's pin,
  and bumps it.
- Every `telo:layer` and `telo:incomplete` value, minus its `role=` pair, equals the
  canonical key of a selector in the module's `layers:` index, or is empty for a
  selector-less layer.
- A `files:` entry selecting `sbom.cdx.json` is refused at publish, naming the path.
- `telo module sbom` downloads exactly one payload blob.
- Swapping the layer's bytes fails integrity.
- `telo release floor` on the change reports no floor change for any adopting module,
  and for each republished module the CLI at its measured floor runs a consumer of the
  republished artifact with no diagnostic.
- A hub version importing a tracked version that later gains an OSV advisory shows it
  after the next scheduled pass, with no re-ingest. A pre-`sbom` import makes its
  dependents report `advisoriesComplete: false`, and so does a `pkg:generic` component
  with no `vcs`. `GET /module/versions` for http-server holds no
  `summary` or `severity`, and the import line `get_kinds` returns for a version with an
  advisory is exactly `<Name>: <ref>@<version>#<integrity>`.
- `telo audit` and `telo sbom` piped to `osv-scanner scan --sbom` report the same
  advisory ids for one application; only `telo audit` names the import and its chain,
  and no `telo audit` run sends a request to `TELO_HUB_URL`.
- `telo audit` on an application whose only vulnerable component sits in a local
  module, and on one importing from a registry the hub does not track, reports both;
  the local one's hint names the version to raise.
- A fixture whose next import version drops the vulnerable component says the upgrade
  removes it (`resolves: true`); one whose next version still carries it names the
  pinning module (`resolves: false`); neither contacts the hub.
- `telo audit` of an application importing sqlite reports SQLite checked by its commit,
  with no `COMPONENT_UNCHECKED` for it; a component whose repository OSV records nothing
  about (tesseract's fork) is one `COMPONENT_UNCHECKED` naming the repository, listed
  under `-o json`.
- `revision: version-3.51.3`, a 7-character id, `url` without `git+` and a `url` with a
  user name are each a `SCHEMA_VIOLATION`; `vcs` without `revision` is refused by the
  schema; both analyzers pass the `vcs-url` and `vcs-revision` conformance sets.
- Two sources containing `pkg:generic/sqlite` 3.51.3 at different revisions publish two
  components, and publishing twice gives identical `sbom` digests.
- A stand-in OSV that records no repository answers `checked: false` for every
  component with `vcs`; one that records the repository and an advisory for the commit
  makes `telo audit` report `COMPONENT_VULNERABLE` with `Fixed by commit`.
- A fork's commit declared under the upstream repository's URL is refused at publish with
  `SOURCE_REVISION_UNREACHABLE`, and a host that does not speak git's version 2
  protocol with `SOURCE_REPOSITORY_UNREADABLE`; nothing is pushed.
- The hub stores one component per purl, version and revision, and checks a revisioned
  one through `Osv.Query`.
- An application importing a fixture artifact with no `sbom` layer: `telo audit` exits
  1 with no OSV request; under `--allow-incomplete` one warning, and the exit status
  follows the other components.
- An advisory on a darwin-only occurrence fails `telo audit` without flags and passes
  with `--platform linux/amd64/gnu`.
- An `audit.ignore` entry with a future `expires` passes the run and lists the
  advisory as ignored, matched by an alias as well as by its id; after the date the
  same entry fails the run naming it; an entry with no `reason` refuses the run with
  `WORKSPACE_INVALID_VALUE`; `audti:` is a near-miss error.
- A planted advisory with no `severity` fails `telo audit`.
- With `TELO_OSV_URL` at a stand-in server, every OSV request of the run, the hint's
  included, goes there and the summary names it; `--osv-url` beside it wins;
  `--osv-url ftp://x` exits 2. A stand-in that refuses gives exit 1 and
  `ADVISORY_LOOKUP_FAILED` naming it, and so does one failing one page of several.
- A component set larger than one OSV batch, served with page tokens by the stand-in,
  is answered completely by `telo audit` and by `Osv.Query`; adding a package type to
  `@telorun/osv`'s data changes both the hub's `advisoriesComplete` and `telo audit`'s
  unchecked set with no other edit.

## Decisions

- **An audit command beside the inventory.** Every package ecosystem gives the
  developer who asks "am I affected?" one command (`npm audit`, `cargo audit`,
  `pip-audit`, `govulncheck`), and only Telo knows which import carries a component and
  which upgrade removes it. `telo sbom` stays the path for a team's own scanner,
  offline databases, severity policy and SARIF.
- **OSV queried directly, never the hub.** The hub knows only tracked, published
  versions as of its last pass, so a verdict through it would pass local modules,
  private registries and anything advised since.
- **One shared lookup.** The CLI and the hub depend on one `@telorun/osv`, the hub
  through `Osv.Query` since a declarative app runs code only through kinds; two
  copies of the package-type list or the paging would drift into a false clean in one
  surface. The list lives in that package, not among the built-in formats, which name
  no service.
- **A failed lookup fails the audit.** Retries live in the lookup alone; one failed
  batch fails the whole run, and there is no offline mode, because `telo sbom` into a
  scanner with a local database already serves that.
- **Unchecked is a warning, unrecorded an error.** A component no database matches by
  version is known and named, and its consumer has no remedy, so an error would
  become a permanent flag hiding every later gap; an unrecorded module is unknown and
  upgrading fixes it.
- **Acceptance in the workspace marker, with a reason and an expiry.** The converged
  form (osv-scanner, cargo-deny, Trivy, Snyk, Grype); a flag carries neither and never
  expires. VEX is a supplier's statement, not a consumer's time-boxed acceptance.
- **No severity threshold.** Many OSV records carry no severity, so a threshold would
  pass them unseen; acceptance is per advisory.
- **The hint is the version `telo upgrade` selects.** The consumer can move only an
  import pin, so the hint checks that one candidate's closure; searching for the
  newest clean version would need the hub or an unbounded walk, and could name a
  version `telo upgrade` would never pick.
- **A pinned layer, not an OCI referrer.** A referrer is unpinned, so a republish can
  swap it while every pin still verifies. A nested module has no OCI manifest to attach
  one to, and referrer support varies by registry. A `common`-layer file would
  download with every controller, and a block in `telo.yaml` would make every manifest
  read pay for an inventory no scanner looks for there.
- **One singleton record, not one per selector.** Occurrence tags let one fetch answer
  for every platform, and a record that is a function of the artifact never depends on
  the machine producing it.
- **Location-free stored record.** The module's own pin and a nested module's location
  cannot be written into the record they hash; module nodes are already in the
  published `telo.yaml`, so readers add them rather than storing a second copy.
- **CycloneDX 1.6 over SPDX.** It is read by Dependency-Track, Trivy, Grype and
  OSV-Scanner, and it can mark one subtree `incomplete`, which an unrecorded import
  needs. SPDX 2.3 is compliance-oriented, and today's scanners barely read SPDX 3.0.
- **Reported by each producer, not read from a lockfile or the bytes.** A lockfile
  lists more than ships and is target-independent, and inlined bytes no longer carry
  package identity. Only the producer knows what it put in, and a new controller
  format adds one producer.
- **`purl` on `sources:`, not `cargo-auditable`.** A third-party prebuilt binary never
  opted in to embedding its dependency list, so its identity must be declared. It names
  the package advisories are filed against, which nothing can derive. One package per
  source keeps it a single literal: a per-entry purl would repeat it per file and pull
  authors toward platform subpackages no advisory names.
- **Formats, not a bespoke code.** Purl and CPE syntax are properties of the value
  alone, checked by reusable Telo formats every later purl-bearing slot shares, so a
  mistake is a schema violation like every other in the block.
- **Imported modules by reference only.** Copying a dependency's content into each
  parent stores one fact in many places, and the copies go stale.
- **Components never merged across modules.** A merge by purl loses which module
  carries a vulnerable component and needs a rule for fields that disagree; nested
  components would rely on every scanner recursing into them.
- **One incompleteness rule over the payload.** Compiled code no producer reported
  makes the record incomplete, whatever produced it, instead of a rule per source kind
  or a refusal of checked-in binaries, which would forbid publishing an author's own
  addon.
- **The record is in the payload digest.** Left out, unchanged modules would never gain
  a record and a corrected `purl` could never republish.
- **Unrecorded modules refuse by default.** An inventory that silently omits imports
  turns a green scanner gate into a false pass; partial output must be asked for.
  Scanners are not relied on to surface `compositions`. A local build failure is not
  "unrecorded": it is the author's to fix, so no flag lets it through.
- **No runtime in the record.** The telo running `telo sbom` in CI is not the telo
  running the application in production; listing it would attribute the wrong runtime.
- **Advisories over the whole closure, materialised.** Direct-only hides a composite
  module pinning a vulnerable `http-server`; joining the closure on every read walks it
  per request, while a version's pinned closure is immutable. Coverage is the shared
  lookup's `checked` answer, never inferred from an empty answer. The version list
  carries advisory ids only; the full record is read for one version.
- **Advisories beside the import line, never on it.** The agent copies `get_kinds`'s
  import lines verbatim, so a comment on one becomes a stale security claim in the
  user's manifest.
- **Hub flags, `telo upgrade` does not.** A discovery service stays out of the path of a
  registry operation. The consumer's check is `telo audit`, or `telo sbom` plus a
  scanner.
