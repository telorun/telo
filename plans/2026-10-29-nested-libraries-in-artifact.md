# Nested libraries ship inside their module's artifact

## Problem

A library that lives inside a module's directory is private to that module, but
publishing treats it like any other relative import. `telo publish` rewrites
`source: ./chat` in `apps/authoring-agent/telo.yaml` to a separate artifact at a
derived address, `oci://ghcr.io/telorun/authoring-agent/chat@<version>#<pin>`. That
artifact must be published first or the agent's publish is refused
(`sibling_not_published`). So the chat library:

- needs its own `telo-workspace.yaml` entry (`path: apps/authoring-agent/chat`,
  `registry: oci://ghcr.io/telorun/authoring-agent`), its own `metadata.version`
  and its own place in the publish order;
- is pushed, versioned and indexed by the hub as if other modules could use it,
  which they are not meant to.

The primer tells every author to lay an application out the same way: feature
libraries as `apps/<app>/<area>.yaml` beside the app's `telo.yaml`. Each of those
would also have to be published as its own artifact.

## Solution

**A library whose manifest lies inside the directory of the module being published
ships inside that module's artifact.** A library outside that directory publishes
exactly as today.

"Inside" is decided at publish from paths on disk, against the directory of the
module named on the `telo publish` command line (the root of the publish), never
against the immediate importer. So a nested library importing another library
elsewhere under the same root also embeds it, while an import leaving the root is
rewritten to a separate artifact as today. Both forms of nested manifest count: a
directory holding a `telo.yaml` (`./chat`) and a file beside the importer
(`./ordering.yaml`). No new manifest key is introduced.

### What a published artifact holds

- **The import stays relative and pinned.** The published `telo.yaml` carries
  `source: ./chat#sha256-<hash>`, where the hash is of the nested library's own
  published `telo.yaml`. This is the same rule a separately published import's pin
  follows today. The parent's pin covers its `telo.yaml`, which carries this hash,
  so the parent's pin covers the nested manifest.
- **The nested manifest rides in the parent's manifest layer**, at its path
  relative to the root (`chat/telo.yaml`, `ordering.yaml`). Reading the parent for
  static analysis still pulls only the manifest layer. The artifact spec's rule
  that reading a manifest never fetches payload layers still holds.
- **The nested manifest is transformed like any published manifest:** remote
  imports must be pinned (`import_unpinned` otherwise), `include:` partials are
  inlined, `sources:` is removed, its own nested imports are handled recursively,
  and imports leaving the root are rewritten to separate artifacts. Those
  rewritten refs are the same ones today's separate publication of the nested
  library produces.
- **The nested library keeps its own `layers:` index.** Its controllers, library
  entry points, assets, browser entries, native files and `LICENSE` are
  partitioned into layers of its own. Their blobs are pushed into the parent's
  repository and listed in the parent's OCI manifest, and the nested library's
  published `telo.yaml` indexes them. They are fetched by digest, as every
  payload layer is.
- **A nested directory belongs to its library.** The parent's `files:` /
  `assets:` patterns do not select files under a nested library's directory, so
  nothing ships twice. A nested file manifest (`ordering.yaml`) shares its
  directory with the parent, so no such exclusion applies to it. Its own layers
  hold only what it claims or selects.
- **A nested library needs no `metadata.version`.** Nothing addresses it by
  version. Publish stops requiring one for a nested target and carries it as
  written when present.

### How a runtime reads it

- **The nested module's identity is `oci://<host>/<repo>@sha256:<digest>/<path>`**,
  where `<digest>` is the OCI manifest digest of the parent as resolved. For
  example `oci://ghcr.io/telorun/authoring-agent@sha256:<digest>/chat`, or
  `…@sha256:<digest>/ordering.yaml` for a file.
  - It is built from the digest, never from the tag the parent was loaded by.
    The bytes behind a digest cannot change, so a cached nested module cannot go
    stale when a tag moves. A tag-built identity would be served from cache after
    `latest` moved and then fail the new parent's pin.
  - `<path>` is the import's path relative to the artifact root, `/`-separated.
    It resolves inside the artifact as a relative import resolves on disk: a
    directory means its `telo.yaml`, otherwise the file.
  - The text after `@sha256:<digest>/` can only be a path, because a digest
    cannot contain `/`.
  - Authors never write this form: the runtime builds it while resolving. It is
    the module's identity everywhere one is used: the module cache,
    shared-library keys, the analysis stamp, and `telo module manifest`.
  - Diagnostics name the parent as it was written (`…/authoring-agent@0.29.3`)
    beside the path, so a reader never has to look up a digest.
- **Where the parent's digest comes from.** A parent loaded by digest supplies it
  as written. A parent loaded by tag supplies the digest of the OCI manifest the
  registry served.
  - For a cached copy, the digest comes from the record `.origins.json` already
    keeps for every cached tag (`host/repo@tag` → digest).
  - A cached parent with no record is re-read from the registry once to learn
    its digest. With no registry reachable, the load refuses, naming the parent
    and `telo install` as the remedy.
  - `telo install` and `telo package` write the record for every parent they
    fetch, so an installed tree and a packaged payload never need the registry
    for it.
- **Digest entries on disk are spelled `sha256-<hex>`.** Every digest-addressed
  entry of the manifest cache and of materialized module directories, nested or
  not, is `…/oci/<host>/<repo>/sha256-<hex>/…`, from one key function shared by
  every reader and writer, the Rust kernel's included. `:` cannot appear in a
  Windows path. A tag spelled exactly like a digest (`sha256-<64 hex>`) is
  refused, so a tag folder and a digest folder never coincide. The digest is
  never read back out of a path. Existing digest-pinned caches miss once.
- **A library nested inside another nested library** (`q` importing
  `../p/inner`) is nested too, with the identity `…@sha256:<digest>/p/inner`,
  whichever module imports it.
- **The editor is out of scope.** The browser reads published manifests from the
  hub, which holds only `telo.yaml`, so Studio and VS Code still resolve a
  nested import to the separate artifact. This is recorded in the loop backlog.
- **The ref grammar gains the path.** It is parsed by the one OCI ref reader that
  the analyzer, kernel and editor share. Today that reader takes everything after
  the last `@` as the reference, and would read `sha256:<digest>/chat` as a
  digest.
- **Resolution.** A relative import in a module loaded from an `oci://`
  artifact resolves to the nested identity when the target path stays inside the
  artifact root and the parent's verified manifest layer carries the file there.
  Otherwise it resolves to a separate artifact, exactly as today, so any
  previously published artifact reads unchanged. The nested manifest is checked
  against the import's `#sha256-…` pin before it is used. A mismatch fails like
  any pin mismatch.
- **Materialization.** A nested module's directory is its directory inside the
  parent's materialized tree (`<parent module dir>/chat`, or the parent's own
  directory for a nested file manifest). Its layers extract there when its own
  rules in the artifact spec call for it. Concurrent materialization is
  serialized per directory, which already covers two modules sharing one
  directory. `ctx.resolveModuleFile`, `!include-*` and `!module-path` resolve
  against that directory, as they do on disk.

### Publishing, release and the CLI

- **A nested library imported from outside its root is refused at the outside
  importer's publish.** The other direction cannot be detected, and that is
  acceptable: only the outside importer's publish fails. That publish walks up
  from the import's target, within the workspace, to the nearest directory
  holding a module's `telo.yaml`. When the target lies inside another module's
  directory, publish refuses with a new failure code `import_nested`, naming the
  enclosing module and the remedy: move the library out of that directory to
  share it. This replaces the misleading "publish the sibling first" that
  `sibling_not_published` would give, since nothing publishes there any more.
- **`telo release` refuses a workspace module whose directory lies inside another
  workspace module that imports it.** Such a module ships inside that one, and
  publishing it separately as well is the duplication this plan removes. The
  refusal names the workspace entry to drop. Changes to a nested library's files
  already count towards the enclosing module, because changed files are
  attributed to the nearest enclosing module. Because the library's bytes are now
  inside the parent's payload, they move the parent's digest and version.
- **`telo install` / `telo package`** warm and carry nested modules' layers like
  any import's. **`telo upgrade --pin-local`** never repins a nested import.
  **`telo changed`** already follows relative imports and needs no change.
- **The hub** indexes the published artifact only. A nested library is not
  indexed as a module of its own.

### Applying it to the authoring agent

- The `apps/authoring-agent/chat` entry is removed from `telo-workspace.yaml`
  along with its comment, and chat's `metadata.version` is removed. Nothing reads
  `module.version` in chat. The comment in the module publish script describing
  "the authoring agent with its chat library" is updated.
- Already published `oci://ghcr.io/telorun/authoring-agent/chat` versions stay
  where they are. Nothing deletes them.
- The agent's `requires: telo:` floor is raised to the release that ships this.
  The floor, not the pin, is what stops an older runtime.
  - A runtime below it resolves a relative import from an `oci://` module as a
    URL path, which drops both the `#sha256-…` pin and the tag. So `./chat#sha256-…`
    becomes the old separate artifact `oci://ghcr.io/telorun/authoring-agent/chat`
    at `latest`, compared against nothing.
  - `requires:` is judged during analysis, after imports are fetched. So that
    runtime fetches chat at `latest`, then refuses the agent with
    `MODULE_REQUIRES_NEWER_RUNTIME` before anything runs.
  - Where no `latest` tag exists, it refuses earlier, with an import failure at
    `Chat`.

### Rust half

`kernel/rust` loads anonymous `oci://` imports, but has no `requires:` check, and
resolves a relative import by joining it to the base as a filesystem path. Neither
would stop it from mis-resolving a nested import.

In this change it refuses a relative import declared by a module loaded from an
`oci://` artifact, with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming nested libraries
as the unsupported feature. No released Rust runtime needs covering, since
`cli/rust` is not published. Nested resolution and the `@sha256:<digest>/<path>`
grammar are recorded as debt in its README, beside the other loader gaps.

## Verify

- **Payload builder** (the CLI's own unit tests, beside the published-manifest
  and published-pin suites):
  - A root with a nested directory library and a nested file library publishes
    one artifact.
  - Its manifest layer holds `telo.yaml`, `chat/telo.yaml` and `ordering.yaml`.
  - The root's published imports read `./chat#sha256-<hash>` and
    `./ordering.yaml#sha256-<hash>`, each hash equal to the hash of the nested
    published manifest.
  - The nested library's `!include-text` file is in a layer its own `layers:`
    index lists, and not in any root layer.
  - An import leaving the root is still rewritten to
    `<destination>/<path>@<version>#<pin>`.
  - A nested library with no `metadata.version` publishes.
  - An unpinned remote import inside a nested library is `import_unpinned`.
- **Outside importer:** a module importing `../app/lib` where `app/` holds a
  `telo.yaml` is refused with `import_nested`, naming `app`.
- **Kernel** (the OCI transport tests' mock registry): push such an artifact,
  then load the root by ref.
  - Loaded by tag, the nested module's identity is
    `oci://<host>/<repo>@sha256:<parent digest>/chat`, and a diagnostic raised
    inside it names the parent by its tag.
  - Move the tag to a new parent whose chat differs, then load again with the
    first one cached. The new chat is loaded under the new digest. Nothing stale
    is served and no pin mismatch is raised.
  - A cached tag-loaded parent with no `.origins.json` record, run offline, is
    refused naming the parent and `telo install`. After `telo install`, the same
    run needs no registry.
  - Its `!include-text` reads the shipped file.
  - Its layers are fetched only when the spec's rules call for them, and none
    while the manifest is only read.
  - A nested manifest altered in the manifest layer is refused as a pin
    mismatch.
  - An artifact whose relative import has no file in the manifest layer still
    resolves to a separate artifact.
- **Ref grammar:**
  - `oci://h/r@sha256:<hex>/chat` and `oci://h/r@sha256:<hex>/a/b.yaml` parse
    to the digest plus path.
  - `oci://h/r/chat` still parses as repository `r/chat`, and `oci://h/r@1.2.0`
    as a tag.
  - The pin fragment parses after the path.
- **Release:** with chat's workspace entry restored, `telo release status`
  refuses it, naming the entry. With it removed, a change under `chat/` bumps
  `apps/authoring-agent`.
- **End to end:**
  - `telo publish --dry-run oci://ghcr.io/telorun/authoring-agent
    apps/authoring-agent/telo.yaml` succeeds with no chat artifact anywhere and
    lists chat's layers in the artifact.
  - Pushed to a local registry, `telo run --no-input
    oci://<local>/authoring-agent@<version>` boots and serves `GET /health`.
  - Run the authoring agent's offline tests that import the chat library from
    the checkout, narrowed to `apps/authoring-agent/chat/tests/*.yaml`.
- **Older runtime, by execution:** run `npx @telorun/cli@<previous> run`
  against the locally pushed agent, once with a `chat` repository holding a
  `latest` tag beside it and once without.
  - With the tag: `MODULE_REQUIRES_NEWER_RUNTIME`, naming the agent's floor.
  - Without it: an import failure at `Chat`.
  - Anything that boots stops the work.
  - Then strip the agent's `requires:` block and run again with the tag. It must
    no longer be refused by the floor, which confirms that the floor is what
    refuses it.
- **Rust kernel, by execution:** the checkout's Rust kernel, loading a module
  from the mock registry whose artifact carries a nested import, refuses with
  `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming nested libraries. It never fetches
  the separate artifact.

## Docs and companions, in the same change

- `kernel/specs/module-artifact.md`: a section on nested modules covering the
  identity form, the manifest-layer placement, the pin, the nested layer index
  and where they materialize.
- `docs/extend/releasing-modules.md`: which imports ship inside the artifact,
  and the `import_nested` and workspace refusals.
- `cli/nodejs/CLAUDE.md` (Publishing), `kernel/nodejs/CLAUDE.md` (layered
  artifacts), root `CLAUDE.md` (Layered module artifacts; `imports` → `source`),
  `analyzer/nodejs/CLAUDE.md` (`imports`).
- `apps/hub/guides/design-library.md`: where it says a library is the same
  shape in a sibling directory or published, add that one inside an
  application's directory ships inside that application's artifact, and one
  meant for other modules lives outside it.
- The authoring agent's primer, in its layout section on feature libraries:
  the same sentence.
- `telo publish -o json`'s closed failure-code set gains `import_nested`,
  documented beside the others.
- One changeset naming `@telorun/analyzer`, `@telorun/kernel` and `@telorun/cli`.
  They are in the telo version line, so it releases the whole line. Also a
  `telo release add` fragment for `apps/authoring-agent` (`Added`): the chat
  library now ships inside the agent's artifact.
- No benefits-ledger entry: a typed framework already ships an application's
  internal packages with it.
