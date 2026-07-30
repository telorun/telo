# Layered module artifacts

## Problem

A Telo module publishes as a single tarball: `telo.yaml` plus everything its
`files:` allowlist selects. Two consequences follow from that atomicity.

**Materialization happens after resolution.** The payload is written to disk by
`extractModuleBundles`, a CLI hook that runs *after* `kernel.load()`. On a cold
cache every bundled controller therefore resolves against an `oci://` base URI,
which `BundleControllerLoader` mis-reads as a filesystem path — producing a
nonsense `<cwd>/oci:/ghcr.io/...` lookup and `ERR_CONTROLLER_NOT_FOUND`. The
first run of any OCI-imported module with bundled controllers fails; the second
succeeds, because the failed run populated the cache on its way out.
`Http.Static` carries the same defect silently: it reads
`ctx.moduleContext.source` and, when that is not a `file://` URL, falls back to
a cwd-relative root and serves the wrong directory. `mcp-client` copies the
pattern.

**Nothing can be fetched selectively.** The manifest read pulls the whole blob
and discards the payload, so the current CLI flow downloads every OCI module
twice. Every runtime downloads every other runtime's controllers. An app
downloads a module's static assets whether or not it ever serves them.

## Solution

Split the artifact into layers, and materialize each layer at the moment its
consumer needs it.

**Publish** (`cli/nodejs/src/commands/publish.ts`, `bundle/select-files.ts`,
`transports/oci/oci-transport.ts`) partitions the selected payload into: a
**manifest** layer holding `telo.yaml`; one **controller layer per selector**,
holding the entry-point files named by the `pkg:telo/local/<format>?path=` PURLs
sharing that selector; an **asset** layer holding whatever an optional `assets:`
declaration claims; and a **common** layer holding everything else `files:`
selected. No directory convention is imposed. The new authoring syntax — the
`assets:` list and the qualifiers below — is entirely optional, and every
omission costs laziness rather than correctness (see the sink rule below).

A **selector** is the tuple a controller candidate is chosen by: its format,
plus the optional `os` / `arch` / `libc` qualifiers on the same PURL. A `js`
controller declares none and is platform-neutral; a native controller declares
them, so a Rust module publishes one layer per platform and every kernel pulls
exactly one. Qualifier values use the OCI/GOOS vocabulary (`linux`, `darwin`,
`windows`; `amd64`, `arm64`) rather than Node's, because they land in OCI
descriptors; `process.platform` / `process.arch` are mapped at the loader
boundary. `libc` (`gnu` / `musl`) is the one platform axis the os/arch pair
misses and is load-bearing on Linux, where a glibc build will not run on Alpine;
absent means "any".

**The sink runs toward correctness, not laziness.** An unclaimed file — one
`files:` selected that neither a controller candidate nor `assets:` names — joins
the **common** layer, which is materialized whenever *any* of the module's
controller layers is **and** whenever anything reads a module-relative file. So a
sidecar nobody declared is on disk before the controller that needs it imports, an
unclaimed static file is there when it is served, and a forgotten declaration costs
bytes, never a runtime failure. Both triggers are needed: a module that ships only
static files has no controller to ride along with. Publish prints the partition so the author can see what landed
where and reclaim it.

Two optional declarations buy back the laziness:

- **`assets:`** — a subset of `files:` naming the lazily-materialized asset layer.
  Without it, static files ride in the common layer and are pulled alongside
  controllers.
- **A sibling qualifier** on a controller candidate, claiming the files an entry
  point loads that the manifest cannot otherwise see — a `.wasm` beside its JS
  glue, a native library opened at runtime. Claiming one moves it out of the
  common layer into that selector's, so other platforms stop pulling it. A
  bundled `js` controller is a single self-contained file and needs none.

The common layer is what closes the multi-selector question: with several
platform layers there is no non-arbitrary way to attribute an unclaimed file to
one of them, so it goes somewhere every controller-hosting kernel will pull.

The published `telo.yaml` carries a **layer index** in place of the scalar
`filesIntegrity`: per layer, its role, selector, blob digest and content digest.
Each layer is verified before extraction.

**The index must live in `telo.yaml`, even though OCI has native layers.** A
Telo import is pinned to a hash of `telo.yaml` and nothing else. OCI's layer list
lives one level up in the OCI manifest, which is fetched by reference — usually a
mutable tag — and which Telo never hashes; the code already treats it as
corroboration only (`oci-transport.ts`, "Telo's inline hash is authoritative").
Digests held only there would leave the pin proving nothing about the payload:
re-push different layers and every importer still verifies. Pinning the OCI
manifest instead is circular — `telo.yaml` is one of its layers, so `telo.yaml`
would have to contain the hash of a thing that contains `telo.yaml`. The
selector has to be pinned alongside its digest for the same reason: if it lived
only in OCI annotations, relabelling which layer is `darwin/arm64` versus
`linux/amd64` would leave both digests intact and hand a host a valid but wrong
blob.

**The index is self-addressing**: each entry carries the layer's OCI blob digest
beside its content digest, so a client pulls blobs by digest and never reads the
OCI layer list at all. This is not circular — publish pushes the payload blobs
first, injects their digests into `telo.yaml`, then pushes the manifest blob and
the OCI manifest, so `telo.yaml` only ever names the *other* layers. Grounding
addressing in the pinned index rather than in list order also means a republish
that reorders layers is simply ignored instead of turning a pinned import into a
hard failure. Descriptors still carry role and selector annotations so
`docker manifest inspect` is legible, but nothing reads them back.

Both digests are kept because they answer different questions: the blob digest
addresses the layer and verifies the transfer, the content digest verifies files
already extracted on disk — framing-independent and re-derivable, which is what
makes a cache marker checkable without re-tarring.

The index and the selector are a **cross-runtime wire format** — a Rust or
Python kernel reading a published artifact implements them — so they get a
normative spec at `kernel/specs/module-artifact.md`, alongside
`specs/logging.md`. It fixes the index shape, role naming, selector encoding and
normalization, the matching rule (an absent qualifier means "any", on every
axis), precedence when several candidates match (declaration order in the
manifest, so the author controls it), and verification-before-extraction.

**The model, its parser, the matching rule and the static checks live in the
analyzer**, which already owns the owner-doc schema this replaces
(`builtins.ts`, the `filesIntegrity` property on both the Application and Library
docs) and is browser-safe. This is the precedent the logging redaction path
parser set: the grammar lives in the analyzer so `telo check` and the runtime
share one implementation instead of drifting. The kernel keeps fetch, extract and
verify; the CLI keeps partitioning; all three consume the analyzer's selector
model rather than parsing qualifiers themselves. The editor and hub **validate** the
index but never consume it. `validate-module-artifact.ts` is what makes the plan's
"a malformed index is a `telo check` diagnostic" true, and it covers the authored
half too: an unknown controller qualifier (a mistyped `arch`, which would otherwise
be silently ignored and make the candidate platform-neutral), an invalid selector
value, and two candidates in one module colliding on one selector.

**The kernel gains a module-scoped artifact handle**
(`kernel/nodejs/src/bundle/`), constructed during module load, where the
**pinned** import ref and the already-verified manifest are both in hand. It
owns the pin, the parsed layer index, cache placement via
`cachePathForCanonical`, per-layer verification, and exposes materialization by
selector: pull that layer's blob alone, verify against the index digest,
extract, write a per-layer marker in place of today's single `.telo-bundle`. It
is memoized in-process and guarded by a cross-process file lock, mirroring
`NpmControllerLoader`'s `ensureInstallRoot` / `withInstallLock` — oauth-client
alone has seventeen definitions resolving concurrently against one controller
file.

Holding the pin inside the handle is what keeps the Merkle chain anchored to the
*importer's* pin rather than to whatever `telo.yaml` happens to be in the cache
directory. The canonical base URI a controller loader sees carries no `#sha256-`,
so a loader that fetched for itself would silently downgrade verification.

**Controllers materialize lazily, per selector.** `BundleControllerLoader`
decides which candidate wins and asks the handle for that selector's directory;
it never fetches, and never resolves a module ref as a path. This is the
contract `NpmControllerLoader` already honours: a controller loader materializes
its own controller. A Node kernel never downloads the `napi` or `wasm` layers,
and a `linux/amd64` host never downloads the `darwin/arm64` binary.

Selection reuses the existing fallthrough rather than the runtime policy: the
loader compares a candidate's qualifiers against the host and raises
`ControllerEnvMissingError` on mismatch, so the candidate list advances to the
matching entry exactly as it already does between `napi` and `js`.
`ControllerPolicy` is unchanged — `pkg:telo` is deliberately not a policy label
(`runtime-registry.ts`) because it carries its runtime in the PURL and rides the
default policy's wildcard; platform is the same thing one level finer. The
platform check must run **before** materialization, or falling through a
candidate list would download every platform's binary on the way to the right
one.

Because the handle owns fetching, an `oci://` ref never reaches the loader as a
path. What remains is a guard on genuinely unhostable schemes, reported with an
actionable error instead of path-resolving `oci:/…` against the working
directory.

**Assets materialize whole, on first module-relative file access.** The SDK gains
a module-asset accessor on `ResourceContext` that resolves a module-relative
reference to a **URI**, materializing the asset layer as a side effect — so a
module whose assets are never read never downloads them. A URI, not a filesystem
path: the SDK is cross-runtime, and a path is merely what the Node kernel happens
to return. The codebase already leans that way — `assert`'s manifest loader
resolves with `new URL(source, ctx.moduleContext.source)`. Assets have no
selector — a static root is all-or-nothing — so the layer is the unit and there
is nothing finer to be lazy about.

Every current consumer of `ctx.moduleContext.source` moves onto the accessor,
which removes the silent cwd fallback wherever it appears. The audit covers at
least `Http.Static`, `mcp-client`'s stdio client, `assert`'s manifest loader and
the test suite; `oauth-client`'s `resolveSource` helpers need checking for the
same pattern.

Materialization lives in the kernel and never in `ManifestSource.read`, so
analyzer-only consumers (`telo check`, the editor, the VS Code extension) read
manifests and touch no payload.

**Transports.** The OCI transport's manifest read pulls only the manifest layer,
so reading a manifest no longer downloads and discards a payload. Publishing to
the HTTP registry was already removed; its now-dead `module.tar.gz` payload path
goes with it. The registry keeps manifest reads, so bare `std/x@version` imports
and npm-backed modules continue to resolve for `install` and `run`.

**Commands.** `telo install` materializes every layer the target runtime could
need — it is the explicit make-this-offline command — and takes an optional
target platform, defaulting to the host, so a baked image (`TELO_CACHE_DIR`) can
be built from a machine of a different architecture. `telo run` materializes on
demand for the host. `extractModuleBundles` and the payload half of the
post-load `persistManifestCache` hook disappear as correctness requirements;
cache warming becomes an optimization rather than the thing that makes a second
run work.

**Compatibility.** Layered artifacts are the only format that can carry a
payload, but the manifest **read** path still accepts a pre-layers single-blob
artifact — that blob contains `telo.yaml`, which is all the read path wants.
This is what keeps npm-backed modules working: they declare no `files:`, fetch
controllers from npm, and are unaffected by the format change even though they
were published in the old shape. Without the fallback the change breaks every
OCI-published module, not just the ones with payloads.

What genuinely breaks is a **payload** published in the old shape: such an
artifact can offer no `layers:` index, so its manifest resolves and its bundled
controller then fails with an actionable "republish" error. That is the six
modules shipping `files:` — `oauth-client`, `scheduler`, `kv-store-memory`,
`kv-store-redis`, `kv-store-sql`, `idempotency` — which must be republished, with
consumers bumping to the new versions.

## Decisions

- **One layer per selector — format plus platform — not one controller layer.**
  The polyglot goal is the payoff: a Node kernel skips blobs it can never host,
  and a host skips binaries for architectures it is not. Rejected: a single
  controller layer, which keeps every runtime downloading every runtime's
  binaries.
- **Platform rides on PURL qualifiers and is selected by env-missing
  fallthrough**, not by `ControllerPolicy`. The qualifier sits beside `path=` on
  the PURL that already names the binary, and the fallthrough mechanism already
  exists for format. Rejected: extending the runtime policy, which would make
  every host's platform a declared concern of the manifest.
- **A flat layer list, not an OCI image index.** A manifest list is the native
  multi-arch mechanism, but a Telo artifact is mostly platform-neutral — the
  manifest and asset layers are shared — so an index would duplicate them per
  platform entry and add a round trip for a selection Telo already makes from its
  own `telo.yaml` index.
- **The layer index lives in `telo.yaml`, not in the OCI manifest**, despite OCI
  having layers natively. The import pin hashes `telo.yaml` alone, so that is the
  only document whose contents the pin can vouch for; the OCI manifest is fetched
  by a mutable tag and is outside the chain. Rejected: pinning the OCI manifest's
  digest from `telo.yaml`, which is circular — `telo.yaml` is one of its layers.
  Selector and digest are pinned together, since a swapped selector alone would
  serve a host a valid blob for the wrong platform.
- **`telo.yaml` is its own layer.** Without it, selective fetch is defeated at
  the first step — reading a manifest would still pull the whole artifact, which
  is exactly today's double-download.
- **The partition is derived from controller PURLs; declarations only refine it.**
  The manifest names every controller entry point in a `?path=` qualifier, and
  the optional `assets:` list and sibling qualifier reclaim files from the common
  layer. Rejected: deriving controller layers from the entry points' directories,
  which imposes a layout mandate on every module author. Also rejected: computing
  the closure from static imports, which succeeds only where it is unnecessary —
  an esbuild bundle is one self-contained file — and fails exactly where sidecars
  exist, since a `.wasm` fetched at runtime and a native library opened via
  `dlopen` are not statically discoverable.
- **Unclaimed files sink to the common layer, pulled with any controller layer
  and on any module-relative file read.** A forgotten declaration then costs bytes,
  not a broken import — and a module shipping only static files, with no controller
  to ride along with, still reaches its own payload. Rejected: an
  unclaimed file falling into the *asset* layer, which made an omitted sibling
  fail as a module-not-found inside a dynamic import — undiagnosable, and against
  the goal that errors point at the YAML needing the fix. Also rejected: failing
  publish when a selected file sits next to a controller entry point, which is
  the same kind of guess as inferring intent from a file extension.
- **Both layer classes are lazy; only their triggers differ.** A controller
  layer is pulled when its candidate wins resolution, an asset layer when
  something first resolves a module-relative reference. Selection belongs to the
  selector: only the controller loader knows which format and platform it can
  host, and assets have no selector at all. Rejected: eager assets on the
  module-load path — it would leave the Problem's "downloads assets whether or
  not it ever serves them" unfixed.
- **The new authoring syntax is optional and fail-safe.** `assets:`, the
  platform qualifiers and the sibling qualifier all add surface; the plan does not
  claim otherwise. What it guarantees instead is that omitting any of them
  degrades laziness and never correctness.
- **The index model, parser and matching rule live in the analyzer.** It already
  owns the owner-doc schema being replaced and is browser-safe, and the logging
  redaction path parser set the precedent — one grammar shared by `telo check` and
  the runtime. Kernel keeps fetch/extract/verify, CLI keeps partitioning.
  Rejected: a new shared artifact-format package, which is a package for one
  model.
- **The index is self-addressing via per-entry OCI blob digests.** Rejected:
  mapping index entry *i* to OCI `layers[i]`, which made the untrusted manifest
  load-bearing, left an off-by-one against the entry-less manifest layer, and
  turned a benign republish reorder into a hard failure.
- **Materialization never sits in `ManifestSource.read`.** `read` is an
  analyzer-owned interface implemented in the browser by the editor; filesystem
  materialization has no place in its contract, and `telo check` must not
  download payloads.
- **A module-scoped artifact handle owns fetching, not the controller loader.**
  It is built at module load, where the pinned import ref and verified manifest
  are in hand, so the Merkle chain stays anchored to the *importer's* pin. A
  loader fetching for itself would have only the canonical base URI, which
  carries no `#sha256-`, and would fall back to trusting the cached `telo.yaml`
  — verification downgraded to whatever is already on disk. It is also the
  polyglot-correct seam: another runtime's kernel implements the same handle.
- **The layer index and selector get a normative spec.** They are a wire format
  the moment a non-Node kernel reads a published artifact, and publish,
  `install --platform` and the loader must agree on matching and precedence.
- **Layers are OCI-only.** The registry is deprecated and already read-only;
  giving a dying transport a new wire format would be waste.
- **Per-layer markers replace `.telo-bundle`.** Partial materialization is now
  the normal steady state, so the extract-once marker has to be per layer.
- **The authoring-agent primer does need updating**, since `assets:` and the
  controller qualifiers are authored surface. So do kernel docs, module docs, and
  `CLAUDE.md`'s controller-delivery section.
- **Release mechanics.** The six bundled modules take hand-written changie
  fragments (`Added`, minor); `kernel`, `cli`, `sdk`, and `analyzer` changes take
  changesets.

## Author surface after the change

The allowlist is unchanged; one optional list is added beside it:

```yaml
files:
  - nodejs/*.mjs
  - public/**
assets:
  - public/**
```

Publishing that module produces three blobs plus the layer index: the manifest, a
`js` controller layer holding whichever `nodejs/*.mjs` files the manifest's PURLs
name as entry points, and an asset layer holding `public/**`. A Node kernel
importing it downloads the manifest, then the `js` layer when the first resource
of one of its kinds is created, and the asset layer only if something resolves a
reference into it — mounting the static root, say. An app importing the module for
its API alone never pulls `public/**`.

Drop the `assets:` block and nothing breaks: `public/**` becomes unclaimed, joins
the common layer, and is pulled alongside the `js` layer. The declaration buys
laziness, not correctness.

A module shipping native controllers declares the same `files:` list; each binary
is named by its own PURL candidate carrying `os` / `arch` (and `libc` where it
matters), optionally with a sibling qualifier for a library it loads at runtime.
Publishing produces one layer per platform, and a `linux/amd64` kernel downloads
that one and never the others — an unclaimed sidecar still reaches it through the
common layer.

## Generated layer index

Not authored — publish injects this onto the owner doc, exactly where
`filesIntegrity` goes today:

```yaml
layers:
  - role: controller
    selector: { format: js }
    blob: sha256:1f0c…
    integrity: sha256-Ab3…
  - role: controller
    selector: { format: napi, os: linux, arch: amd64, libc: gnu }
    blob: sha256:9d22…
    integrity: sha256-Cd9…
  - role: controller
    selector: { format: napi, os: darwin, arch: arm64 }
    blob: sha256:4e81…
    integrity: sha256-Ef1…
  - role: assets
    blob: sha256:77ba…
    integrity: sha256-Gh7…
  - role: common
    blob: sha256:0ac5…
    integrity: sha256-Ij4…
```

The **manifest layer has no entry**: a hash of `telo.yaml` cannot sit inside
`telo.yaml`, which is the same self-reference today's `filesIntegrity` avoids by
excluding the manifest from its digest. The manifest layer is pinned by the
importer's `#sha256-` instead, so the chain reads `import pin → telo.yaml →
blob digest → layer contents`.

The two digests do different jobs. `blob` is the **OCI blob digest** over the
pushed bytes — it addresses the layer, so a client pulls by digest and never reads
the OCI layer list, and it verifies the transfer. `integrity` is a **content
digest**: `computeFilesIntegrity` over that layer's own files, independent of
tar/gzip framing, so it verifies what is already extracted on disk and can be
re-derived from it without re-tarring — which is what makes a per-layer cache
marker checkable.

Publish order is what keeps this non-circular: payload blobs are pushed first,
their digests injected into `telo.yaml`, then the manifest blob and the OCI
manifest. `telo.yaml` only ever names layers other than itself.
