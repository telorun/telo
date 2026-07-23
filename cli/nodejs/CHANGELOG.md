# @telorun/cli

## 0.52.0

### Minor Changes

- 84002d3: Remove the Telo module registry as a publish/discovery surface; the hub is now the discovery path.

  The `registry.telo.run` origin stays a read-only resolution source, so apps that
  import bare `namespace/name@version` refs keep resolving and running unchanged.
  `telo run` / `install` / `check` / `module` / `upgrade` are unaffected — they
  resolve and enumerate versions against the still-deployed origin. What is removed:

  - **`telo publish` targets OCI only.** A non-OCI (HTTP registry / bare-host)
    destination is rejected with a clear error; publish to `oci://host/repo`.
    `--registry` remains, used solely to resolve/pin dependencies read-only.
  - **`RegistryTransport.publish()` now throws** — the transport is read/resolve
    only. Resolution, cache placement, version listing, digest, and manifest
    hashing are unchanged.

### Patch Changes

- Updated dependencies [ab4a911]
- Updated dependencies [84002d3]
  - @telorun/templating@0.11.0
  - @telorun/kernel@0.52.0
  - @telorun/analyzer@0.41.1
  - @telorun/ide-support@0.7.1

## 0.51.2

### Patch Changes

- 2e1bb5c: Fix `telo publish` for OCI imports and directory arguments.

  - The pre-flight analysis loader now uses the kernel's transport sources (same
    chain as `telo check`), so a manifest whose `imports:` reference an `oci://`
    dependency — pinned (`#sha256-…`) or not — resolves for analysis instead of
    failing with `No source found for: oci://…`. Previously it used the analyzer's
    `defaultSources()` (HTTP + registry only), which owns no `oci://` scheme.
  - A directory argument now resolves to its `telo.yaml` (standard Telo path
    resolution, matching `run` / `check`), instead of failing with
    `Cannot read file: <dir>`.

- Updated dependencies [0c1c8fd]
- Updated dependencies [2e1bb5c]
  - @telorun/analyzer@0.41.0
  - @telorun/ide-support@0.7.0
  - @telorun/kernel@0.51.2

## 0.51.1

### Patch Changes

- Updated dependencies [bdc21e9]
  - @telorun/ide-support@0.6.0

## 0.51.0

### Minor Changes

- 6418e2a: `telo check` now resolves every import scheme the runtime does — `oci://`
  included — and reports locations as CWD-relative paths.

  `check` built its loader from the analyzer's browser-safe `defaultSources()`
  (HTTP + registry only), so an `oci://` import failed with "No source found for".
  It now uses the kernel's `defaultTransportRegistry(registryUrl).sources()` — the
  same origin-direct chain `install` / `run` use — so OCI resolves straight from
  the origin registry, never through the hub cache (the discovery plan's invariant:
  CLI resolution never routes through the hub; the `manifests.telo.sh` cache is the
  browser editor's read path only). A `--registry-url` option is added, matching
  the `--registry-url → TELO_REGISTRY_URL → https://registry.telo.run` fallback of
  `run` / `install` / `upgrade`.

  Diagnostic locations for on-disk manifests are now printed relative to the
  working directory (e.g. `examples/hello-world/telo.yaml:12:12`) instead of an
  absolute `file://` URL; genuine `http(s)://` sources stay absolute.

  `@telorun/kernel` gains a `./transports` subpath export (re-exporting
  `defaultTransportRegistry` and the transport registry) and a
  `./manifest-sources/local-file-source` subpath so a Node consumer can pull just
  the transport-resolution sources and the local-file source without the
  controller/bundler machinery the package root drags in. `telo check` and the VS
  Code host both import through these subpaths.

- 6418e2a: Surface broken `imports:` sources as structured diagnostics through one shared
  code path, so every host reports them identically.

  Import-resolution failures were collected into `LoadedGraph.errors` as raw
  `Error`s with no diagnostic code. Each host assembled its own diagnostic list
  from the graph, and they drifted: the CLI re-threw the first error as a bare
  message, while the VS Code extension dropped the channel entirely — a manifest
  with an unresolvable import showed **no** in-editor diagnostic.

  The channels split cleanly across two layers:

  - The analyzer owns the raw conversion: `importResolutionDiagnostics(graph)`
    turns `graph.errors` into coded `AnalysisDiagnostic`s — `INVALID_IMPORT_SOURCE`
    for a source no transport can ever resolve (e.g. `not-found@whatever`) and
    `IMPORT_UNRESOLVED` for a well-formed ref that failed to fetch (404, missing
    file). Each adopts the `{ filePath, path: "imports.<alias>" }` shape
    version-reconciliation diagnostics already use, so the shared `findPositions` /
    `resolveRange` routing anchors them on the offending import line with no
    host-specific code.
  - `@telorun/ide-support` owns the presentation policy:
    `assembleGraphDiagnostics(graph, analysis)` folds parse, version, import, and
    static analysis into one list and partitions out the cascade that would bury
    the real cause — the analysis diagnostics of any file that failed to parse
    **or** whose import failed to resolve (both have unreliable kind resolution).
    It returns `{ diagnostics, suppressed }`: hosts surface `diagnostics` and may
    render `suppressed` dimmed. The compromised-file set is exposed on its own as
    `compromisedFiles(graph)` so the multi-closure telo-editor applies the exact
    same policy the single-closure VS Code host does — the two show identical
    info. The CLI, VS Code extension, and telo-editor all route through this one
    source, so a channel can never again be surfaced by some hosts and forgotten
    by others.

  `GraphLoadError` gains `alias`, `source` (the author-written import string), and
  `sourceLine` to support precise anchoring and messages that quote what the
  author wrote rather than a resolved `file://` URL.

  `telo check` now renders import-resolution failures as coded diagnostics
  alongside everything else — with a file:line:col and code — instead of throwing
  the first as an uncoded message, and suppresses the secondary kind-resolution
  cascade a broken import would otherwise trigger.

- 6418e2a: `telo upgrade` now upgrades OCI imports and can follow relative imports
  recursively.

  Version enumeration, ref reconstruction, and integrity hashing during an
  upgrade are delegated to the transport that owns each ref's scheme, so every
  backend the kernel can resolve is also upgradeable. Previously the command used
  a registry-only ref classifier that skipped `oci://host/repo@tag` imports as
  "not a registry ref"; they are now bumped in place like registry refs. The
  `Transport` interface gains two methods for this — `refVersion(ref)` (the
  version segment currently named) and `withVersion(ref, version)` (the ref
  rewritten at a new version) — implemented by `RegistryTransport` and
  `OciTransport`.

  A new `--recursive` / `-r` flag follows relative (local) imports into their
  sibling manifests and upgrades those too. It is cycle-safe and upgrades each
  file at most once even when a sibling is reached from several manifests. Remote
  refs are always upgraded in place; recursion only descends into on-disk
  siblings. Without the flag, a relative import is reported skipped with a hint to
  use `--recursive`.

### Patch Changes

- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
  - @telorun/kernel@0.51.0
  - @telorun/analyzer@0.40.0
  - @telorun/ide-support@0.5.0

## 0.50.0

### Minor Changes

- c1fef72: Implement the structured logging specification (`kernel/specs/logging.md`).

  Records carry an OTel severity number, a message, structured attributes, the
  emitting resource's identity, its import-alias scope, and the active dispatch
  span's trace and span ids — all attached automatically. Controllers emit through
  the new ambient `ctx.log`.

  Logging is configured by a `logging:` block on the root `Telo.Application`:
  `level`, `attributes`, `redact`, `sampling`, and a `sinks:` list of ref-or-inline
  entries. `Telo.ConsoleSink` and `Telo.FileSink` are kernel built-ins resolvable
  without an import; omitting `sinks:` yields exactly one console sink, so the
  zero-config case stays "pretty on a terminal, JSON when piped". An `imports:`
  entry may carry its own `logging:` block to raise verbosity for that dependency's
  subtree; config cascades and may be narrowed at each hop. There is no
  `TELO_LOG_*` variable and no logging CLI flag — a level derived from the host
  environment goes through a `variables:` entry read with `!cel`.

  New `Telo.Sink` capability and `Telo.LogSink` abstract, so the sink set is open
  to the ecosystem: a third party ships a sink by publishing a module whose kind
  extends `Telo.LogSink`. The new `std/otlp` module does exactly that.

  Behaviour changes:

  - The CLI now honours `NO_COLOR` and implements the spec's full color-precedence
    order. `FORCE_COLOR=0` disables color rather than enabling it.
  - `TracePayload.spanId` / `parentSpanId` on the debug wire are now 16-character
    lowercase hex strings rather than numeric counters, matching the ids log
    records carry. The internal counter is unchanged; hex is rendered only at the
    encoding boundary and is salted per process so two services in one distributed
    trace cannot mint the same id.
  - `Http.Server`'s `logger:` field now means "enable request logging" rather than
    being a raw Fastify passthrough. Fastify's Pino instance is replaced with a
    Telo-backed adapter, so request records inherit the root `logging:` block's
    level, encoding, redaction, and sinks.
  - The kernel no longer writes diagnostics to `process.stderr` or `console.*`;
    everything routes through the logger. The ad-hoc `TELO_BUNDLE_DEBUG` env var is
    replaced by ordinary trace-level records.
  - `on_full: block` and invalid redaction paths are now caught by `telo check`
    (static analysis), not only at boot — `on_full: block` is unimplementable on a
    single-threaded runtime and a bad redaction path would otherwise silently fail
    to redact. Both remain enforced at runtime as a backstop.

  Two pre-existing bugs fixed along the way:

  - A CEL expression feeding **any** enum-constrained field produced a spurious
    `SCHEMA_VIOLATION`, because the placeholder substituted for the expression
    satisfied `type` but violated `enum`. Fixed in both the analyzer and the
    kernel.
  - `teardownResources` aborted the whole cascade on the first throwing resource,
    with no aggregation and no reporting. Failures are now collected into
    `ERR_TEARDOWN_FAILED` so one bad teardown cannot skip the rest — including the
    log sinks, which are pinned to tear down last.
  - The inline `imports:` desugaring silently dropped unknown entry fields, so a
    per-import `logging:` block never reached the import controller.

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/sdk@0.50.0
  - @telorun/kernel@0.50.0
  - @telorun/analyzer@0.39.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.45

## 0.49.0

### Patch Changes

- Updated dependencies [2395a4a]
  - @telorun/sdk@0.49.0
  - @telorun/kernel@0.49.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1

## 0.48.0

### Minor Changes

- 0368e6f: Pin `oci://` imports on publish, restoring the integrity chain for OCI modules.

  `fetchManifestHash` recognised only bare registry refs and `http(s)` URLs, so an
  `oci://` import fell through to "cannot hash non-remote import" and `telo
publish` skipped it as best-effort-unresolved. Published OCI artifacts therefore
  carried unpinned dependencies, and the Merkle chain that makes an importer's
  hash transitively cover its dependencies stopped at the first OCI ref — leaving
  integrity to rest on registry trust alone, contrary to the inline hash being
  authoritative across transports.

  Hashing moves onto the `Transport` interface as `manifestHash(ref)`, so each
  transport hashes exactly what its own `read()` verifies — registry/HTTP the raw
  response bytes, OCI the UTF-8 encoding of the `telo.yaml` extracted from the tar
  layer — and a pin written at publish always matches at import. `fetchManifestHash`
  is now transport dispatch rather than a scheme chain.

  That placement is the actual fix. The bug was the failure mode of a caller-side
  `isRegistryRef`/`http(s)`/else chain: a ref whose scheme nobody had added a branch
  for degraded silently to best-effort-unresolved. A fourth transport would have
  reproduced it identically. Since `manifestHash` is required on the interface, one
  cannot now be added without deciding what it hashes.

### Patch Changes

- Updated dependencies [8af345f]
- Updated dependencies [8af345f]
- Updated dependencies [0368e6f]
- Updated dependencies [0368e6f]
- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/kernel@0.48.0
  - @telorun/sdk@0.48.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.44

## 0.47.0

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0
  - @telorun/kernel@0.47.0
  - @telorun/sdk@0.47.0
  - @telorun/ide-support@0.4.43
  - @telorun/templating@0.10.1

## 0.46.0

### Minor Changes

- bd4f3ac: Support direct `https://` module refs in the manifest-cache key contract. `analyzer` gains `isHttpsModuleRef` and `urlManifestCacheCoords(ref, version)` — a URL addresses one file whose version lives inside it, so the version is supplied by the caller rather than parsed from the ref; a trailing `telo.yaml` is dropped so the key doesn't duplicate the filename, and refs carrying a query or userinfo are rejected (both would let distinct URLs collide onto one key, or smuggle an authority). `telo module manifest --json` now emits a `cacheKey` for `https://` refs, built from the `metadata.version` the fetched manifest declares.

### Patch Changes

- Updated dependencies [bd4f3ac]
- Updated dependencies [bd4f3ac]
  - @telorun/kernel@0.46.0
  - @telorun/analyzer@0.36.0
  - @telorun/ide-support@0.4.42

## 0.45.0

### Minor Changes

- d88a397: Federated discovery, phase 1 — the ingest/search spine behind the telo hub.

  - **analyzer**: browser-safe `manifestCacheKey` / `manifestCacheUrl` /
    `ociManifestCacheCoords` helpers plus `ManifestCacheSource`, resolving
    `oci://` imports against the hub's static manifest cache
    (`manifests.telo.sh`) with `#sha256-…` verification for pinned refs. The OCI
    ref grammar (`parseOciRef` / `isOciRef` / `OCI_SCHEME`) moves here from the
    kernel so the tracker's write key and the editor's read key share one source
    of truth. The throws-coverage check now reads `when:` clauses written with
    the `!cel` tag (previously only the inline `${{ }}` string form parsed).
  - **kernel**: `Transport.digest(ref)` — a cheap content-identity digest per
    version (OCI: `Docker-Content-Digest` via HEAD; HTTP: hash of the
    `telo.yaml` bytes) so the discovery tracker can detect re-pushed tags
    without re-downloading. OCI `tags/list` now follows pagination `Link`
    headers. New `TELO_EGRESS=public-only` egress guard refuses transport
    fetches to private/loopback/link-local/CGNAT hosts (SSRF guard for
    deployments that fetch registered, attacker-suppliable refs).
  - **cli**: `telo module digest <ref>` (the digest verb the tracker records and
    re-checks), `telo module manifest --json` (emits `{ ref, cacheKey,
manifest }` with the shared cache key), and `telo search "<query>"` /
    `telo search --kinds` — a thin client of the hub's `/search/*` endpoints
    (`TELO_HUB_URL`, default `https://telo.sh`).

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0
  - @telorun/kernel@0.45.0
  - @telorun/ide-support@0.4.41

## 0.44.1

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1
  - @telorun/kernel@0.44.1
  - @telorun/ide-support@0.4.40

## 0.44.0

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/kernel@0.44.0
  - @telorun/analyzer@0.34.0
  - @telorun/sdk@0.44.0
  - @telorun/ide-support@0.4.39
  - @telorun/templating@0.10.1

## 0.43.0

### Minor Changes

- 3961e35: Add a `telo module` inspection command group — generic, transport-neutral verbs
  (the `npm view` / `docker manifest inspect` analog):

  - `versions <ref>` — published versions newest-first (`--json`); for a local
    path or direct URL it reports the single declared `metadata.version`.
  - `manifest <ref>` — the module's `telo.yaml`, verified against the inline hash
    when pinned.
  - `resources <ref>` — the resource instances declared in the manifest (`--json`).
  - `kinds <ref>` — the resource kinds the module defines: kind suffix, owning
    module, capability, export status, and description (`--json`). The prefix in a
    `kind:` field is the consumer's own import alias, so a kind's identity is
    reported as the `(module, name)` pair, not a fixed dotted string.

  Every verb resolves a ref uniformly across sources — a local path, a direct
  `https://` URL, a registry `ns/name[@ver]` ref, or an `oci://host/repo[@tag]`
  ref — dispatching through the existing `TransportRegistry` with no scheme
  branching. This is the read seam the federated-discovery hub's tracker consumes.

- 9a92bf1: Add a `Transport` abstraction that owns everything ref-scheme-specific about a
  module's lifecycle — manifest read, full-artifact fetch, cache path, version
  list, and publish — and ship two implementations behind it: the existing HTTP
  registry (`RegistryTransport`) and a new OCI transport (`OciTransport`). The
  loader, cache, `telo upgrade`, `telo install`, and `telo publish` no longer
  branch on ref shape; they ask the transport registry which transport owns a ref
  and delegate, so adding a backend is "implement one interface and register it."

  `OciTransport` resolves and publishes `oci://host/repo@version` modules to any
  OCI distribution registry (GHCR / ECR / Docker Hub / Harbor) over a hand-rolled
  minimal client — pull/push manifest + blob, the `WWW-Authenticate` token
  handshake, and the ambient Docker credential chain (`~/.docker/config.json` +
  `docker-credential-*`). A module is one artifact: a single tar blob carrying
  `telo.yaml` and the `files:` payload, pushed under a standard OCI artifact
  manifest (`artifactType: application/vnd.telo.module.v1+tar`).

  `telo publish` gains a destination-first positional — `telo publish
<destination?> <paths…>` — whose scheme selects the transport (`oci://` → OCI,
  `https://` / bare host → HTTP registry, omitted → the default registry). Bare
  `telo publish .` is unchanged. Relative sibling imports are canonicalized
  against the destination (OCI: via the destination repo; HTTP: the sibling's
  `<namespace>/<name>`), pinned to the sibling's own version, and every derived
  ref is verified to resolve at its published location before publishing.

  Telo's inline `#sha256-…` hash stays authoritative across transports: the
  manifest is verified against it and the payload against the manifest's
  `filesIntegrity`, the same Merkle chain regardless of backend. A tamper failure
  is a distinct `IntegrityError` (always terminal, never a best-effort skip). The
  `isRegistryRef` shape-test now rejects any `scheme://`, so an `oci://…` ref can
  never be misrouted to the default registry or a garbage cache path. The tar and
  `filesIntegrity` helpers moved from the CLI into the kernel so both transports
  share one implementation.

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0
  - @telorun/templating@0.10.1
  - @telorun/kernel@0.43.0
  - @telorun/ide-support@0.4.38

## 0.42.0

### Minor Changes

- 2ff9027: Add inline module integrity — remote imports may carry a `#sha256-<base64url>`
  fragment (or an `integrity:` sibling on the object form) that pins the fetched
  `telo.yaml` bytes. Every source `read()` (registry, HTTP, and the kernel's
  on-disk manifest cache) hashes the fetched bytes and fails the load on a
  mismatch — a terminal error, never a self-healing cache miss. A canonical
  `parseModuleRef`/`splitIntegrity` in the analyzer strips the fragment at every
  path-building site so it never pollutes fetch URLs or cache paths.

  Bundle modules (`files:` → `module.tar.gz`) pin their payload with a
  `filesIntegrity` field on the manifest — a canonical per-file content digest
  that `telo publish` writes and `extract` verifies before unpacking. Because the
  importer's hash covers the manifest, the payload is pinned transitively.

  `telo publish` pins each remote import to its dependency's hash (best-effort:
  unresolvable imports are warned, not fatal; `--frozen` makes them hard errors).
  `telo upgrade` re-pins on a version change and also pins already-current imports
  in place (so a rarely-changing module whose version never moves still gets a
  hash), both best-effort.

### Patch Changes

- Updated dependencies [b7d378a]
- Updated dependencies [2ff9027]
  - @telorun/kernel@0.42.0
  - @telorun/analyzer@0.32.0
  - @telorun/ide-support@0.4.37

## 0.41.0

### Patch Changes

- Updated dependencies [721a241]
- Updated dependencies [721a241]
  - @telorun/kernel@0.41.0
  - @telorun/sdk@0.41.0
  - @telorun/analyzer@0.31.0
  - @telorun/templating@0.10.0

## 0.40.2

### Patch Changes

- 36af5f5: Surface YAML parse failures as error diagnostics. A document that fails to
  parse (e.g. an unquoted scalar containing `: ` that the parser reads as a
  nested mapping) previously produced a mangled `toJSON()` projection that
  static analysis silently accepted — `telo check` reported "passed" while the
  registry rejected the same file on push. The loader now aggregates every
  file's YAML `parseErrors` into `LoadedGraph.parseDiagnostics` (fatal `Error`
  diagnostics carrying the parser's line/column range), surfaced by `telo check`
  / `telo publish` / the editor / VS Code and treated as fatal by the kernel at
  load.
- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0
  - @telorun/kernel@0.40.2
  - @telorun/ide-support@0.4.36

## 0.40.1

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1
  - @telorun/kernel@0.40.1
  - @telorun/ide-support@0.4.35

## 0.40.0

### Patch Changes

- Updated dependencies [4e5d861]
- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/kernel@0.40.0
  - @telorun/analyzer@0.30.0
  - @telorun/ide-support@0.4.34

## 0.39.1

### Patch Changes

- Updated dependencies [ef511d9]
  - @telorun/kernel@0.39.1

## 0.39.0

### Minor Changes

- d84a585: Give the `telorun/node` image a smart entrypoint, modeled on the official node image's `docker-entrypoint.sh`. It prepends `telo` only when the first argument is a flag (`-…`), an unknown command, or a non-executable file — so `docker run telorun/node ./telo.yaml` and `docker run telorun/node --watch ./telo.yaml` both reach the CLI, while `bash`, `sh`, and `node` still run verbatim as escape hatches. A derived image may write either the explicit `CMD ["telo", ".", "--watch"]` or the terse `CMD ["./telo.yaml"]` — both work; the bare image runs the CLI via the default `CMD ["telo"]`.

### Patch Changes

- d84a585: Honor `--no-cache-write` when fetching the on-demand debug UI for `--inspect`. Previously the bundle was always written into `TELO_CACHE_DIR`, so in the k8s runner — where `/telo-cache` is the baked, read-only deps cache and the workload runs with `--no-cache-write` — the cache write failed (`EROFS` / `ENOENT mkdir '/telo-cache/debug-ui'`) and the inspect UI came up unavailable. Under `--no-cache-write` the fetched bytes are now served in-memory via `DebugServer` and never touch disk.
- d84a585: Unify glob matching across the monorepo onto a single dependency-free engine in a new `@telorun/glob` package. It exports `selectByPatterns` (plus `HARD_IGNORE` / `DEFAULT_IGNORE` / `GLOB_PRUNE_DIRS`) as the one matcher used everywhere a `.gitignore`-style pattern set is resolved: `files:` bundling (`telo publish` + the editor run bundle), `include:` expansion (kernel `LocalFileSource` + the editor adapters), and test discovery (`@telorun/test`).

  This removes four divergent implementations — the kernel's `minimatch`, the editor's hand-rolled glob→regex, the test runner's own `globToRegex`, and an `ignore`-based pass — in favor of a small matcher implementing a documented **Telo glob** subset of gitignore. The subset and its exact behavior are pinned by a language-neutral conformance suite (`packages/glob/conformance/glob.json` + `README.md`) so any runtime (Node today; Rust / Go later) can reimplement it identically rather than chasing one library's quirks. The kernel drops `minimatch` and the CLI drops its direct `ignore` dependency; the matcher lives in its own package rather than the static analyzer, so consumers depend on it directly instead of reaching into `@telorun/analyzer` for a non-analysis primitive.

  The deny set is split into a non-overridable **hard** tier (`node_modules`/`.git`/`.telo`) and a soft, opt-out-able tier (`.telobundle.*`). `applyDefaultIgnore: false` (used by `include:` resolution to reach co-located partials) now only skips the soft tier — a broad `**` `include:` can no longer recurse into the manifest cache, and resolves identically in the kernel and the editor.

- Updated dependencies [ebca26a]
- Updated dependencies [d84a585]
  - @telorun/analyzer@0.29.0
  - @telorun/kernel@0.39.0
  - @telorun/glob@0.2.0
  - @telorun/ide-support@0.4.33

## 0.38.0

### Patch Changes

- Updated dependencies [a9ac4ba]
- Updated dependencies [a125804]
  - @telorun/sdk@0.38.0
  - @telorun/analyzer@0.28.1
  - @telorun/kernel@0.38.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.32

## 0.37.0

### Minor Changes

- 5ea5ff3: Reconcile module versions to one version per identity within an import graph.

  When the same `<namespace>/<module-name>` is reached at multiple versions (a diamond import), the loader now collapses them onto a single version before any controller, definition, or kind is registered — fixing the spurious `DUPLICATE_IMPORT_ALIAS` and the silent last-writer-wins controller collision that two versions of one module previously caused.

  - Same major → the highest version wins (a non-lossy hoist given the additive-only pre-1.0 policy), reported as a `MODULE_VERSION_HOISTED` warning on the lower-version import line.
  - Different major → a fatal `MODULE_VERSION_CONFLICT`; `telo run` refuses to start and `telo check` errors.
  - Same version from two sources with differing content → a `MODULE_VERSION_HOISTED` warning; identical content is deduplicated silently.

  Reconciliation lives in the shared analyzer loader, so `telo check`, the kernel runtime, and the editor all resolve the same single version. `LoadedGraph` gains `overrides` and `versionDiagnostics`.

### Patch Changes

- 5ea5ff3: Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

  `new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

  This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0
  - @telorun/kernel@0.37.0
  - @telorun/ide-support@0.4.31

## 0.36.0

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/kernel@0.36.0
  - @telorun/sdk@0.36.0
  - @telorun/analyzer@0.27.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.30

## 0.35.0

### Minor Changes

- 12f6d6f: Add `files:` for bundling static assets into a published module. A `Telo.Application` or `Telo.Library` may declare a `files:` list of ordered, `.gitignore`-style patterns (matched with the `ignore` engine: positive patterns opt in, `!` patterns carve out, last-match-wins). When present, `telo publish` packs `telo.yaml` plus the selected files into a `module.tar.gz` and PUTs it to the registry; `telo install` / `telo run` extract that archive into the local cache next to the cached `telo.yaml`, so a relative `Http.Static` `root:` (e.g. a built SPA in `./public`) resolves on the consumer exactly as it does in development. An always-on ignore set (`node_modules/`, `.git/`, `.telo/`, `.telobundle.*`) is never shipped. The CLI's `include:` resolver moves from `minimatch` to the same `ignore` engine.

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0
  - @telorun/kernel@0.35.0
  - @telorun/ide-support@0.4.29

## 0.34.0

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/sdk@0.34.0
  - @telorun/analyzer@0.25.0
  - @telorun/kernel@0.34.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.28

## 0.33.0

### Patch Changes

- Updated dependencies [95f168e]
- Updated dependencies [95f168e]
  - @telorun/kernel@0.33.0
  - @telorun/sdk@0.33.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.32.0

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/sdk@0.32.0
  - @telorun/kernel@0.32.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.31.0

### Patch Changes

- b41012f: cli: two debug event serializer fixes.

  - The serializer no longer mislabels a **shared reference** as `[Circular]`. `toWire`'s cycle detection is now path-scoped (a value is "circular" only while it's an ancestor on the current descent), so an object reachable by two sibling paths — a DAG, common in invocation `inputs` where a sub-value is shared — serializes fully. Genuine cycles still collapse to `[Circular]`.
  - A **bigint** now serializes as a plain number when it fits a JS safe integer (CEL models small integers as bigint, so `${{ size(x) }}` reads as `3`, not `[BigInt 3]`), falling back to its decimal digits as a string for out-of-range values so no precision is lost.

- Updated dependencies [b41012f]
- Updated dependencies [b41012f]
  - @telorun/kernel@0.31.0
  - @telorun/sdk@0.31.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.30.2

### Patch Changes

- Updated dependencies [912044a]
  - @telorun/kernel@0.30.2

## 0.30.1

### Patch Changes

- b1dd65c: Inspect debug UI: surface an explicit failure (including the exact fetch URL and HTTP status / error) when the on-demand UI bundle can't be resolved or fetched, instead of a generic "not available" notice — the reason is shown in the endpoint's 503 and logged at startup. Add a `TELO_DEBUG_UI_VERSION` override so the version to fetch can be set when the CLI manifest doesn't carry a concrete one (e.g. container images built via `pnpm deploy`, where `workspace:*` isn't rewritten).
- Updated dependencies [0c16f41]
  - @telorun/templating@0.10.0
  - @telorun/analyzer@0.24.1
  - @telorun/kernel@0.30.1
  - @telorun/ide-support@0.4.27

## 0.30.0

### Patch Changes

- Updated dependencies [aaa760d]
- Updated dependencies [aaa760d]
- Updated dependencies [cce2caa]
  - @telorun/analyzer@0.24.0
  - @telorun/templating@0.9.0
  - @telorun/kernel@0.30.0
  - @telorun/ide-support@0.4.26

## 0.29.0

### Patch Changes

- Updated dependencies [b4e6ac8]
  - @telorun/kernel@0.29.0

## 0.28.0

### Minor Changes

- d59e847: Debug stream now carries **logs as well as events**, and the editor embeds the
  debug UI.

  - New `@telorun/debug-wire` package: the language-neutral frame contract shared
    by the producer, the runner, the editor, and the debug UI. A stream now carries
    two discriminated frame kinds on one channel — `kind: "event"` (kernel events)
    and `kind: "log"` (one stdout/stderr line). Browser-safe; `wire-schema.json` is
    the source of truth a non-TypeScript producer conforms to. `@telorun/debug-ui`
    re-exports its types.
  - `@telorun/cli`: `--inspect` / `--debug` now tee the run's stdout/stderr into the
    stream as `log` frames (the terminal is untouched; the tee is restored on stop).
    The inspect server adds permissive CORS so an embedding webview can read it.
  - `@telorun/debug-ui`: the watcher is now a **Logs / Events** tab split over one
    frame stream (`DebugPanel` + `LogView`); `DebugWatcher` wraps it for the
    standalone app. `connectDebugStream` delivers `DebugFrame`s routed by `kind`.
    Components take a `theme` prop (`"light" | "dark" | "system"`, default
    `"system"` — follows `prefers-color-scheme` live); `DebugPanel` also takes a
    `logsSlot` (an embedding host can render its own interactive terminal in the
    Logs tab) and a `defaultTab`. When **no** `theme` is supplied the panel owns
    its mode and shows a system/light/dark toggle in its header; when a host
    passes `theme`, the host owns it and the toggle is hidden.

  The editor (private) embeds `DebugPanel` in the run view's Debug tab: remote
  HTTP/k8s runners relay frames over the existing `/v1/sessions/:id/events`
  transport (the security/ingress boundary), while the local runner reads the
  workload's loopback `--inspect` port directly — both surface identical `debug`
  run events. Blob payloads aren't resolvable in the editor embed yet (the
  workload's blob endpoint isn't reachable from the editor); events and logs work.

- d59e847: Debug UI now links to the running application's exposed ports.

  - `@telorun/debug-ui`: `DebugPanel` takes an `endpoints` prop and renders each as
    a link in its header (tcp → clickable `http://host:port`, udp → plain label).
    New `AppEndpoint` type + `endpointHref` / `endpointLabel` helpers (browser-safe,
    no runner/kernel dependency). The standalone `DebugWatcher` sources endpoints
    from the producer's `/json/version` handshake, filling a blank host from the
    page origin so the link points where the viewer reached the server (localhost
    locally, the bound host remotely).
  - `@telorun/kernel`: new `Kernel.getResolvedPorts()` — the root Application's
    resolved `ports:` (integer + declared protocol per name), available after
    `load()`. Empty when the root declares no ports.
  - `@telorun/cli`: the `--inspect` server advertises the app's resolved ports as
    `appEndpoints` in its `/json/version` handshake. The UI now opens once the
    ports are known (deferred from server start to first load), so the discovery
    handshake already carries the endpoints.

  The editor (private) renders the same links inside `DebugPanel` from its resolved
  run endpoints, replacing the separate chips in the run-view header.

### Patch Changes

- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2
  - @telorun/kernel@0.28.0
  - @telorun/ide-support@0.4.25

## 0.27.0

### Minor Changes

- 9ef48a6: Add a live debug-event inspection UI. `telo run --inspect` starts a
  localhost-only inspection endpoint and prints its URL — a single page that
  watches the kernel event stream in real time (SSE), with text/kind/suffix
  filtering, expandable payloads, pause, and replay of events that fired before
  the page was opened. (`--debug` independently writes the `.telo.debug.jsonl`
  event log; the two compose. See the `--inspect` flag set for delivery details.)

  New `@telorun/debug-ui` package: the browser-safe, runtime-agnostic consumer
  surface — the debug wire-format types + JSON Schema, filter logic, an SSE client,
  and React components (incl. the standalone app served by the inspection server).
  It has no Node-only dependency so it also runs in the editor webview.

  Binary payloads (images and any other file kind) are not inlined: the producer
  offloads each `Uint8Array`/`Buffer` to an in-memory, content-addressed LRU blob
  store and emits a small `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }`
  pointer in its place (the key it sits under is preserved). The `DebugServer`
  serves the bytes at `GET /blobs/:id`; the UI renders `image/*` inline and other
  types as download links. Content addressing dedupes repeated buffers (e.g. a
  redraw loop).

  The producer (serializer + `DebugServer` + blob store) stays Node-side in the
  CLI; the cross-runtime contract is the wire format
  (`@telorun/debug-ui/wire-schema.json`), so a future Rust/Go kernel can serve the
  same UI by conforming to it. The inspection server binds `127.0.0.1` and is
  `unref`'d, so a one-shot `--inspect` run still exits normally.

- 9ef48a6: Ship the debug UI on demand instead of bundling it in the CLI, and give the
  inspection endpoint its own composable flag set.

  - `telo run --inspect[=[host:]port]` starts the live inspection endpoint
    (default `127.0.0.1:9230`; non-loopback binds print a security warning) and
    serves the UI same-origin, with a `/json/version` discovery handshake.
    `--no-open` suppresses auto-opening the browser. `--debug` is a separate,
    composable flag that writes only the `.telo.debug.jsonl` event log (no network,
    no UI).
  - The CLI does not bundle `@telorun/debug-ui` (it's a `devDependency`). The UI is
    fetched on demand from npm via jsDelivr and cached under the `.telo` cache
    root; in the monorepo it resolves from the workspace, so local builds are
    testable offline. `TELO_DEBUG_UI_PATH` overrides the bundle path; `TELO_DEBUG_UI_URL`
    overrides the CDN base.
  - `@telorun/debug-ui` builds a self-contained single-file bundle
    (`app-single/index.html`) alongside `app-dist/`.

### Patch Changes

- 9ef48a6: Move the `--debug` event log out of the kernel into the CLI. The kernel no
  longer monkeypatches `EventBus.emit` with an always-installed streaming wrapper;
  debugging is now a plain `kernel.on("*", …)` subscriber (`DebugEventSubscriber`,
  attached by the CLI only when `--debug` is set). A normal run registers no `*`
  listener, so the event bus carries zero added overhead.

  Serialization is cycle- and value-safe and logs only plain data. Stream-bearing
  payloads (e.g. an Invocable's `{ outputs: { output: Stream } }`) whose
  async-generator closures form reference cycles previously threw `cannot serialize
cyclic structures` and dropped the event. Live runtime objects — a resolved
  `!ref` is a controller instance whose `.ctx` back-references the whole Kernel —
  previously serialized into multi-megabyte heap dumps. Now: a resolved `!ref`
  renders as the `{ kind, name }` reference it stands for; every other live object
  collapses to a one-token `[ClassName]` / `[Stream]` / `[Circular]` marker;
  object/array literals still log in full.

  BREAKING (kernel public API): `EventStream`, `Kernel.enableEventStream`,
  `Kernel.disableEventStream`, and `Kernel.getEventStream` are removed. The CLI was
  the only consumer.

- 9ef48a6: Fix `telo run --watch --inspect` dropping the debug UI on every reload. The
  inspection server is now created once per session and the rebuilt kernel
  re-attaches to it each cycle, so the browser's SSE connection (and replay buffer
  - JSONL) survive reloads instead of the UI showing the process as terminated.
- Updated dependencies [9ef48a6]
- Updated dependencies [9ef48a6]
  - @telorun/kernel@0.27.0

## 0.26.1

### Patch Changes

- Updated dependencies [5973024]
- Updated dependencies [a592710]
  - @telorun/analyzer@0.23.1
  - @telorun/kernel@0.26.1
  - @telorun/ide-support@0.4.24

## 0.26.0

### Minor Changes

- 1ddd803: Add a single, threaded cache-root resolution and a read-only cache mode for ephemeral runs.

  - **`TELO_CACHE_DIR` reinstated** as the override for the `.telo` cache root, resolved once per load via the new `resolveCacheRoot(entryUrl)` and threaded to the manifest cache, compiled validators, analysis stamp, and npm install root — no consumer re-derives it or reads the env independently. `Kernel.load` gains a `cacheDir` option so a CLI caller resolves it once and the kernel reads no env.
  - **`telo run --no-cache-write`** (kernel `writeCache: false`) keeps the cache read-only: baked validators/manifests are still loaded, anything uncached validates in-memory, and nothing is persisted — so a read-only, ephemeral session rootfs validates without touching (or failing to write) the cache. Validation errors still surface normally.
  - **SDK**: `ResourceContext` gains `getInstallRoot()`, the threaded npm install root, so controllers honour a relocated cache root.

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/kernel@0.26.0
  - @telorun/sdk@0.26.0
  - @telorun/analyzer@0.23.0
  - @telorun/templating@0.8.0

## 0.25.0

### Patch Changes

- 206cf98: fix(cli): restore `telo run --watch`

  Watch mode was inert — its file watching and reload were stubbed out against
  two kernel methods (`getSourceFiles`, `reloadSource`) that no longer exist.
  Reimplement it as a full-restart loop: load → derive the graph's local files
  (entry, `include:` partials, imported libraries) → start (held alive so
  one-shot apps don't exit) → reload on any change by cancelling and tearing the
  kernel down, then rebuilding. Load/boot failures are reported as diagnostics
  and watch keeps running so the next edit retries. The watcher set is persistent
  across reloads (one long-lived `fs.watch` per file) rather than torn down and
  recreated each cycle — under bun, re-`fs.watch`-ing a just-closed path never
  fires again, which limited reloads to exactly one.

- Updated dependencies [c89e79b]
- Updated dependencies [c89e79b]
- Updated dependencies [1098ad0]
- Updated dependencies [4794671]
  - @telorun/kernel@0.25.0
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.24.2

### Patch Changes

- 004a848: Warm analysis caches at `telo install` time so a prebuilt image boots without re-deriving them.

  `kernel.load` now accepts an `analyzeOnly` option that runs the static-analysis pre-flight and persists its caches (the `.validated.json` analysis stamp and the compiled `__validators/` schema cache) but stops before module instantiation, target wiring, and application-env resolution. It also pre-compiles the application-env residual validators (`variables`/`secrets`/`ports`), which the runtime would otherwise recompile on every boot. `telo install` invokes this offline `kernel.load` to bake the caches onto a writable filesystem, so the runtime `load()` on a read-only session rootfs hits the stamp and skips the validation walk instead of failing to persist the caches (EROFS/ENOENT) on every boot.

- Updated dependencies [004a848]
  - @telorun/kernel@0.24.2

## 0.24.1

### Patch Changes

- Updated dependencies [9a305e6]
  - @telorun/kernel@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [ee8926f]
- Updated dependencies [ee8926f]
  - @telorun/kernel@0.24.0
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.23.0

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/kernel@0.23.0
  - @telorun/analyzer@0.21.0
  - @telorun/sdk@0.23.0
  - @telorun/templating@0.7.0
  - @telorun/ide-support@0.4.21

## 0.22.0

### Minor Changes

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/kernel@0.22.0
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0
  - @telorun/ide-support@0.4.20

## 0.21.0

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/sdk@0.21.0
  - @telorun/analyzer@0.19.1
  - @telorun/kernel@0.21.0
  - @telorun/ide-support@0.4.19

## 0.20.1

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/kernel@0.20.1
  - @telorun/ide-support@0.4.18

## 0.20.0

### Patch Changes

- Updated dependencies [2864c4d]
  - @telorun/kernel@0.20.0

## 0.19.0

### Minor Changes

- 5331205: Add cooperative invoke cancellation via an out-of-band `InvokeContext`.

  Every `invoke(inputs, ctx?)` now receives a second argument carrying a read-only
  cancellation token (`ctx.cancellation`): poll `isCancelled`, subscribe via
  `onCancelled`, bail with `throwIfCancelled`, or hand its `signal` to a Web API.
  The SDK exposes the source/token split (`createCancellationSource`,
  `CancellationSource`/`CancellationToken`), a never-cancellable sentinel, and the
  `isCancellationError` helper. Deadlines are scheduled cancellation
  (`source.cancelAt(epochMs)` / `cancelAfter(ms)`).

  The kernel mints one cancellation scope per invocation tree (inherited by nested
  invokes via a kernel-internal `AsyncLocalStorage`, always passed to controllers
  as the explicit argument), refuses a not-yet-dispatched invoke whose tree was
  cancelled with `ERR_INVOKE_CANCELLED`, and emits a scoped `InvokeCancelled`
  event. `Kernel.invoke(ref, inputs, opts?)` accepts `{ signal, deadlineAt }`.
  Sources are allocated lazily, so invokes that never touch cancellation pay no
  extra allocation.

  The boot `targets` run is also cancellable: `Runnable.run(ctx?)` now receives
  the token, `Kernel.cancel(reason?)` cancels the boot scope, and the CLI's
  SIGINT/SIGTERM handler calls it so Ctrl-C cooperatively stops honoring targets
  and in-flight invoke trees (then unblocks graceful exit via `forceIdle`).

  Honoring leaves: `Ai.Text` / `Ai.TextStream` / `Ai.Agent` forward the token's
  signal into the model (aborting a live LLM stream on cancel); `http-client`
  merges it with its request timeout. Triggers: `http-server` cancels on client
  disconnect and returns 499; `lambda` arms cancellation at the AWS deadline.

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/sdk@0.19.0
  - @telorun/kernel@0.19.0
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.18.0

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/sdk@0.18.0
  - @telorun/kernel@0.18.0
  - @telorun/ide-support@0.4.17
  - @telorun/templating@0.4.1

## 0.17.3

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/kernel@0.17.3
  - @telorun/ide-support@0.4.16

## 0.17.2

### Patch Changes

- 0505e9b: cli + ide-support: operate on the inline `imports:` map instead of standalone `Telo.Import` documents

  `telo upgrade` and `telo publish` now read and rewrite import sources from the
  `imports:` map on the `Telo.Application` / `Telo.Library` doc, covering both the
  scalar shorthand (`Alias: <src>`) and the object form (`Alias: { source: <src>, … }`).
  Standalone `Telo.Import` document handling is dropped from both commands. `upgrade`
  keeps its byte-level splice (quote style, comments, and folded block scalars are
  preserved); `publish` canonicalizes relative `imports:` sources to
  `<namespace>/<name>@<version>` and now loads the pre-flight analysis graph with
  `desugarImports` so inline imports resolve during static validation. `telo install`
  likewise loads its graph with `desugarImports`, so transitive inline imports are
  discovered, cached, and analyzed.

  ide-support source autocomplete fires on `imports:` entries (scalar value or the
  `source:` under the object form), gated on the enclosing path so unrelated `source:`
  fields never trigger it. `Telo.Import` is removed from the no-registry kind
  completion fallback.

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.17.1

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/kernel@0.17.1
  - @telorun/ide-support@0.4.14

## 0.17.0

### Patch Changes

- 0cd36a1: inline imports — `imports:` map on Telo.Application / Telo.Library

  Add an optional name-keyed `imports:` map to `Telo.Application` and
  `Telo.Library` as additive sugar for separate `Telo.Import` documents. Each
  entry's key is the PascalCase alias; its value is either a bare source string
  (`Console: std/console@1.2.3`, shorthand for `{ source }`) or the full object
  form carrying `variables` / `secrets` / `runtime`. Authored `Telo.Import`
  documents keep working unchanged and both forms may coexist.

  The loader desugars inline entries into synthetic `Telo.Import` manifests via a
  new `desugarImports` `LoadOptions` flag (folded into the file cache key; mirrored
  on the SDK's `ResourceContext.loadModule` options). The flag is on for every
  resolved consumer — the kernel's analysis and runtime loads, the
  import-controller's child-module load, the analyzer, `telo check`, and the
  `Assert.Manifest` test helper — and off for the editor's round-trip view, which
  reads the raw `imports:` map and pairs manifests to YAML nodes by index. Inline
  imports therefore resolve and execute identically to authored docs.

  Adds a `DUPLICATE_IMPORT_ALIAS` diagnostic: an alias declared twice in one
  module scope (across either form) is now an error instead of silently
  shadowing.

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/kernel@0.17.0
  - @telorun/sdk@0.17.0
  - @telorun/ide-support@0.4.13
  - @telorun/templating@0.4.1

## 0.16.1

### Patch Changes

- Updated dependencies [acb8996]
  - @telorun/kernel@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/kernel@0.16.0
  - @telorun/sdk@0.16.0
  - @telorun/templating@0.4.1
  - @telorun/ide-support@0.4.12

## 0.15.0

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/kernel@0.15.0
  - @telorun/analyzer@0.14.0
  - @telorun/templating@0.4.0
  - @telorun/ide-support@0.4.11

## 0.14.0

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/kernel@0.14.0
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1
  - @telorun/ide-support@0.4.10

## 0.13.2

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/kernel@0.13.2
  - @telorun/ide-support@0.4.9

## 0.13.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.13.0

### Minor Changes

- f3e5fbc: Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

  - **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
  - **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
  - **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.

- 768f5d7: Add `telo upgrade <paths..>` — scans the given manifest files for `Telo.Import` declarations whose `source` is a registry ref (`<namespace>/<name>@<version>`), queries the registry for the latest published version, and rewrites the source in place when a newer version is available.

  The command uses the same registry-URL fallback as `install` / `run` (`--registry-url` flag > `TELO_REGISTRY_URL` > `https://registry.telo.run`). Pre-release versions are excluded by default; pass `--include-prerelease` to consider them. `--dry-run` reports the proposed upgrades without touching the file.

  Non-registry sources (relative paths, HTTP URLs) and unparseable versions are skipped with a notice rather than treated as errors.

### Patch Changes

- Updated dependencies [c0129c0]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.8

- Updated dependencies [0331069]
- Updated dependencies [0331069]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.7

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]

  - @telorun/analyzer@0.12.0
  - @telorun/templating@0.3.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.6

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.5

- 3e3f134: Migrate Docker image publishing to a per-runtime-repo scheme with variant + multi-arch tagging.

  **Kernel image** moves from `telorun/telo` to `telorun/node`, reserving the namespace for future polyglot kernels (`telorun/rust`, `telorun/go`). The previous monolithic image is split into four variants per release:

  - `telorun/node:<v>` / `telorun/node:<v>-slim` — lean variants, no Rust toolchain.
  - `telorun/node:<v>-rust-<rust-version>` / `telorun/node:<v>-rust-<rust-version>-slim` — opt-in Rust toolchain layered on top.

  Rolling tags (`latest`, `<major>`, `<major>.<minor>`) compose with the variant suffixes. Release tags are immutable; pin to exact versions for reproducible builds. Release images are multi-arch (`linux/amd64` + `linux/arm64`). Dev tags (`sha-<short>-*`) appear on every main-branch push, slim variants only.

  **Lambda base images** newly published as `telorun/lambda-node-managed:<lambda-version>` (managed nodejs runtime) and `telorun/lambda-node-custom:<lambda-version>` (custom `provided.al2023` runtime). Both pre-install `@telorun/lambda` and its workspace deps at `${LAMBDA_TASK_ROOT}`; user images derive from them and add only their manifest + install root. The `-node-` segment in the repo name reserves the namespace for future `telorun/lambda-rust-*` images.

  **CI**: docker publishing now runs from `.github/workflows/publish-docker.yml`, called by `publish.yml` after `changesets/action` actually publishes packages. Per-image gating reads `outputs.publishedPackages` so kernel images rebuild only when `@telorun/cli` bumps and lambda images only when `@telorun/lambda` bumps.

- Updated dependencies [39aef08]

  - @telorun/kernel@0.13.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.4

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/kernel@0.13.0
  - @telorun/sdk@0.12.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.3
  - @telorun/templating@0.3.0

## 0.12.0

### Patch Changes

- Updated dependencies [67a9b31]
- Updated dependencies [0f80fc5]
  - @telorun/kernel@0.12.0
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.11.1

### Patch Changes

- Updated dependencies [58362c4]
- Updated dependencies [58362c4]
  - @telorun/kernel@0.11.1
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1
  - @telorun/templating@0.2.3
  - @telorun/ide-support@0.4.1

## 0.11.0

### Minor Changes

- f61b36a: `telo install` now also persists every imported manifest's YAML to `<entry-dir>/.telo/manifests/` (registry refs under `<namespace>/<name>/<version>/telo.yaml`, HTTP imports under `__http/<host>/<pathname>`). `telo run` registers a new `LocalManifestCacheSource` ahead of the registry / HTTP sources, so production images that ran `telo install` at build time boot with zero registry network I/O — fixing the self-bootstrap loop in the registry image and unblocking air-gapped deploys. Cache misses fall through to the network source transparently; dev runs without a prior install are unchanged. New CLI flag `telo install --registry-url <url>` mirrors `telo run` for consistency.

  The reader and writer share a single URL→path function so direct-URL imports of a registry-served manifest (`source: https://registry.telo.run/...`) hit the same cache file as the corresponding `source: namespace/name@version` ref. HTTP URLs with a query string or fragment are disambiguated with a 12-char content hash on the filename so two different manifests never collide. All cache paths are validated to stay under the cache root, guarding against `..` segments in module refs.

  - `@telorun/kernel`: adds `LocalManifestCacheSource`, `writeManifestCache`, `cachePathForCanonical`, and `resolveEntryDir` exports.
  - `@telorun/cli`: `telo install` writes the manifest cache; `telo run` registers the cache source; new `--registry-url` flag on `telo install`.

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [f61b36a]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/kernel@0.11.0
  - @telorun/analyzer@0.10.0

## 0.10.0

### Patch Changes

- 5c49834: Loader returns the canonical load result; editor stops re-parsing.

  The analyzer's `Loader` now produces a single `LoadedFile` / `LoadedModule` / `LoadedGraph` that carries text, parsed `yaml.Document` ASTs, manifests, position metadata, and canonical identity together. Hosts consume the same parse — the editor no longer runs a parallel YAML pipeline, the VS Code extension and CLI no longer read positions from non-enumerable manifest metadata, and the kernel uses the same primitive for static analysis and runtime entry loads.

  **Breaking changes** in `@telorun/analyzer`. The deprecated methods are removed in this release rather than kept as shims:

  - `Loader.loadModule(url, opts)` now returns `LoadedModule` (was `ResourceManifest[]`).
  - `Loader.loadModuleGraph` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadManifests` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadModuleForFile` legacy shape removed; the replacement is `loadGraphForFile(url) → { graph, ownerUrl } | null`.
  - `attachPositionIndex` (the non-enumerable-metadata helper) removed; positions live on `LoadedFile.positions` and consumers look them up via `findPositions(graph, …)` from `@telorun/ide-support`.
  - `LoadedGraph.importEdges` is now `Map<string, Map<string, ImportEdge>>` carrying `{targetSource, targetModuleName, targetNamespace}` rather than a bare target URL — `flattenForAnalyzer` reads library identity off the edge directly instead of re-deriving from manifest metadata.

  **New surface**:

  - `parseLoadedFile(source, requestedUrl, text, opts?)` — pure, I/O-free parse primitive shared between the editor's source-view debounce and the loader's `read()` post-processing.
  - `Loader.loadFile(url, opts?)`, `Loader.loadGraph(entry, opts?)`, `Loader.loadGraphForFile(fileUrl)` — new methods returning the canonical types.
  - `flattenForAnalyzer(graph)` and `flattenLoadedModule(mod)` — produce the flat `ResourceManifest[]` `analyze()` consumes (graph-wide vs. single-module).
  - `@telorun/ide-support`: `findPositions(graph, diagnosticData)` returns `{file, positionIndex?, sourceLine?}` and replaces every host's hand-rolled "look up the file owning this diagnostic + its positions" loops.

  **Internal effects**:

  - `@telorun/cli`: migrated `check`, `install`, and `publish` to the new API; `formatAnalysisDiagnostics` takes a `LoadedGraph`.
  - `@telorun/kernel`: the kernel's facade methods (`loadModule`, `loadManifests`) preserve their `ResourceManifest[]` API so module controllers don't need to migrate; internally they project from the new types via `flattenForAnalyzer` / `flattenLoadedModule`.
  - The editor's `ModuleDocument` collapses to `{filePath, loaded: LoadedFile, dirty: boolean}`; the previous parallel `parseModuleDocument` pipeline (`text` / `docs` / `loadedJson` / `parseError` snapshots, in-memory adapter, chained adapter, populate/collect-partial passes, `mergeSubGraph`) is gone. Source-view edits and form edits both flow through `parseLoadedFile`; saves re-parse the just-written text to refresh the load-time snapshot.

- f1c35bc: Split `Kernel.start()` into `boot()` / `runTargets()` / `teardown()`, add public `Kernel.invoke()`, rename `Kernel.shutdown()` → `Kernel.forceIdle()`.

  Embedders that want "boot once, invoke many" (e.g. an AWS Lambda managed-runtime adapter, IDE previews, programmatic tests) can now drive each lifecycle phase explicitly without owning the wait loop. `start()` stays as a convenience method with no observable behaviour change — its `try` widens to cover `boot()` and `runTargets()` so init-time failures still drive teardown and still emit `Kernel.Stopping` / `Kernel.Stopped`, matching the pre-split contract that the CLI and test runner rely on.

  **New methods**:

  - `boot(): Promise<void>` — initialize resources, emit `Kernel.Initialized`. Does not run targets, does not wait.
  - `runTargets(): Promise<void>` — emit `Kernel.Starting`, run `targets:` from the manifest, emit `Kernel.Started`. Throws `ERR_KERNEL_STATE_INVALID` if called before `boot()` or after `teardown()`, or a second time.
  - `teardown(): Promise<void>` — emit `Kernel.Stopping`, tear down every initialized resource, emit `Kernel.Stopped`. Idempotent on the second call (no-op, no re-emit). Tolerates partial state — a `boot()` that threw mid-init still cleans up.
  - `invoke<TInputs, TOutput>(ref, inputs): Promise<TOutput>` — invoke a `Telo.Invocable` resource by `<Kind>.<Name>` (dot-form string) or `{ kind, name }`. Throws `ERR_KERNEL_STATE_INVALID` before `boot()` or after `teardown()`.

  **Breaking**:

  - `Kernel.shutdown(): void` is renamed to `Kernel.forceIdle(): void`. Same semantics (force-resolve a pending `waitForIdle()` regardless of active holds; used by SIGINT/SIGTERM handlers). The name disambiguates from the new `teardown()`. The only known external caller is the CLI's signal handler, updated in this changeset.
  - New `ERR_KERNEL_STATE_INVALID` runtime error code on `RuntimeErrorCode`.

  No migration needed for callers that only use `start()` — its semantics are unchanged.

- 47f7d83: Single-realm controller install: every controller in a kernel process now resolves through one `<entry-manifest-dir>/.telo/npm/` tree, with the kernel's own `@telorun/sdk` wired in as a `file:` dep. The realpath collapse this produces fixes class-identity bugs across the kernel/controller boundary — most visibly cel-js's `registerType("Stream", Stream)` matching `Stream` instances created on either side of the realm split.

  - `@telorun/kernel`: `Kernel.load(url)` records the entry URL; `getEntryUrl()` is exposed via `ResourceContext`. `NpmControllerLoader` rewrites every load — registry tag or `local_path` — as an `npm install <spec>` into the per-manifest install root. A filesystem lock at `<root>/.lock` (atomic `fs.open(path, 'wx')`, PID + start-time inside) makes the install cross-process safe; a hash of the materialized `package.json` short-circuits repeat installs. The legacy `~/.cache/telo/npm/` global cache is no longer consulted (existing trees are safe to delete by hand). `TELO_PKG_MANAGER` overrides the default `npm` invocation.
  - `@telorun/cli`: `telo install` passes the manifest's entry URL through to the kernel-side loader so the install root lands next to the manifest. `TELO_CACHE_DIR` is no longer consumed.
  - `@telorun/sdk`: `ResourceContext` gains a `getEntryUrl()` method.
  - `@telorun/assert`: `package.json` `exports` map now declares the Bun/Node conditional split (`bun → src/*.ts`, `import → dist/*.js`). The previous bare-`./src/*.ts` entries only worked because the old controller loader silently rewrote `src→dist`; that rewriter is gone.

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0
  - @telorun/kernel@0.10.0
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.9.2

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/templating@0.2.1
  - @telorun/kernel@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [543b91f]
  - @telorun/kernel@0.9.1

## 0.9.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/templating@0.2.0
  - @telorun/kernel@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [019c62a]
- Updated dependencies [c792025]
  - @telorun/kernel@0.8.0
  - @telorun/analyzer@0.7.0

## 0.7.3

### Patch Changes

- 84e9edf: `telo publish` now canonicalizes relative `Telo.Import.source` paths (e.g. `../ai`) into absolute registry references of the form `<namespace>/<name>@<version>` before pushing the manifest. Relative paths are only meaningful on the publisher's filesystem; once a manifest reached the registry, the leading `..` collapsed the version segment of the registry URL (so e.g. a sibling import at `…/<package>/<version>/` + `../<sibling>` resolved to `…/<package>/<sibling>`, dropping the version), and any consumer that imported a published library which itself used relative imports got a 500 from the registry. Sibling-module metadata (`namespace` / `name` / `version`) is read from the local target's `telo.yaml` at publish time.

## 0.7.2

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/kernel@0.7.2

## 0.7.1

### Patch Changes

- 024debe: Declare `engines.node: ">=24"` on `@telorun/cli` and `@telorun/kernel`. Makes the supported Node version explicit (and fixes the npm Node-version badge in the README, which previously rendered "not specified").
- Updated dependencies [024debe]
  - @telorun/kernel@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [6d4280e]
- Updated dependencies [b62e535]
  - @telorun/kernel@0.7.0
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0

## 0.6.1

### Patch Changes

- 0c4d023: Surface controller-download progress as kernel events and render them in the CLI.

  `ControllerLoading` / `ControllerLoaded` / `ControllerLoadFailed` /
  `ControllerLoadSkipped` are now emitted from `ControllerLoader` itself, one
  cycle per attempted PURL candidate so env-missing fallback chains are visible.
  Payloads carry the single attempted `purl` instead of the full candidate
  array, plus `source` (`local` | `node_modules` | `cache` | `npm-install` |
  `cargo-build`) and `durationMs` on `Loaded` so consumers can distinguish real
  work from cache hits. `pkg:cargo` resolutions through `local_path` (the only
  cargo mode currently wired up) report `source: "local"` — cargo's incremental
  cache makes every run after the first effectively a no-op build, the same
  mental model as the npm `local_path` branch. `cargo-build` is reserved for a
  future distribution mode (fetch from a registry + compile). `Skipped` is
  emitted for recoverable env-missing fallbacks (e.g. `pkg:cargo` with no
  `rustc` on PATH) so consumers can close out per-attempt UI state without
  conflating it with a hard failure.

  The CLI renders a `⬇ <purl>` line at `Loading` and rewrites it in place to
  `✓ <purl> (<source>, <ms>)` (or `✗ …`) at `Loaded` / `Failed`. By default the
  renderer activates only when stdout is a TTY, so CI logs and the dockerised
  `telorun/telo` service stay silent. `--verbose` forces rendering on regardless
  of TTY (so captured/piped logs get the lines too).

  By default, resolutions reporting `source: cache` or `local` have their line
  erased once `Loaded` arrives — they're sub-millisecond and don't represent
  work worth surfacing. `--verbose` bypasses this filter and prints every
  resolution, including cache/local, which is useful for debugging which branch
  the loader took. Other sources (`node_modules`, `npm-install`, `cargo-build`)
  always render their `✓` line.

  The cargo / napi loader now also accepts an optional PURL fragment. When
  present, `pkg:cargo/foo?local_path=...#bar` projects to `module.bar` after
  loading the dylib (each sub-export must itself have `create` or `register`);
  without a fragment the whole module is the controller, as before. This
  mirrors the npm `#entry` semantics for crates that want one source file per
  controller. The raw module is cached per crate, so two PURLs differing only
  by fragment share one cargo build.

- Updated dependencies [0c4d023]
  - @telorun/kernel@0.6.1

## 0.6.0

### Minor Changes

- 2e0ad31: In-memory kernel bootstrap and `Adapter` → `Source` rename.

  **Breaking changes:**

  - `Kernel.loadFromConfig(path)` → `Kernel.load(url)`. The new method dispatches the URL through the registered `ManifestSource` chain unchanged — no implicit `file://` cwd-wrapping. The `loadDirectory` deprecation shim is removed.
  - `KernelOptions.sources: ManifestSource[]` is now required. Callers must pass an explicit list, e.g. `new Kernel({ sources: [new LocalFileSource()] })`. The previous hardcoded `LocalFileAdapter` registration in the `Kernel` constructor is gone.
  - `ManifestAdapter` interface renamed to `ManifestSource`. Per-scheme classes renamed: `LocalFileAdapter` → `LocalFileSource`, `HttpAdapter` → `HttpSource`, `RegistryAdapter` → `RegistrySource`. Files and directories renamed in turn (`manifest-adapters/` → `manifest-sources/`, `analyzer/.../adapters/` → `.../sources/`).
  - `LoaderInitOptions` field renames: `extraAdapters` → `extraSources`, `includeHttpAdapter` → `includeHttpSource`, `includeRegistryAdapter` → `includeRegistrySource`.
  - The dead-stub `kernel/nodejs/src/manifest-adapters/manifest-adapter.ts` (an unused parallel interface that drifted from the live one in `@telorun/analyzer`) is deleted.

  **New:**

  - `MemorySource`: an in-memory `ManifestSource` for embedders and tests. Available as a top-level export from `@telorun/kernel` and as a subpath export at `@telorun/kernel/memory-source`. Bare module names register under `<name>/telo.yaml` (mirroring disk's "module is a directory containing telo.yaml" convention) so relative imports (`./sub`, `../sibling`) work transparently with POSIX path resolution. `set(name, content)` accepts either YAML text or an array of parsed manifest objects (serialized via `yaml.stringify`).

  **Internal:**

  - `Loader.moduleCache` is now per-instance rather than `private static readonly`. Multiple in-process kernels (the headline use case for `MemorySource` — test runners, IDE previews) no longer share a process-wide cache.

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/kernel@0.6.0
  - @telorun/analyzer@0.5.0

## 0.5.0

### Patch Changes

- Updated dependencies [fc4a562]
- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/kernel@0.5.0
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0

## 0.4.1

### Patch Changes

- 2900b1c: `telo publish` now retries transient registry push failures with exponential backoff (up to 4 attempts). Retries on network errors (DNS, reset, `fetch failed`) and on `408`, `425`, `429`, and `5xx` responses so flaky CI pushes no longer fail the whole workflow.
- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/kernel@0.4.1

## 0.4.0

### Minor Changes

- 6a61dbf: Add `telo install <path>` — pre-downloads every controller declared by a manifest and its transitive `Telo.Import`s into the on-disk cache. At runtime the kernel finds each controller already cached and skips the boot-time `npm install`, removing the startup delay and the network dependency from production containers.

  Reuses the existing `ControllerLoader`, so resolution semantics (local_path, node_modules, npm fallback, entry resolution) are identical to runtime loading. Jobs run in parallel via `Promise.allSettled`; failures are reported per controller and the command exits non-zero if any failed.

  `ControllerLoader` is now exported from `@telorun/kernel`.

  **Cache location**: defaults to `~/.cache/telo/` (XDG-style, shared across projects for a user). Override via `TELO_CACHE_DIR` — set it per-project to bundle the cache alongside the manifest. The registry image now uses `TELO_CACHE_DIR=/srv/.telo-cache` so `telo install` at build time and `telo run` at boot both read/write the same project-local cache, and a single `COPY --from=build /srv /srv` carries the full bundle into the production stage.

### Patch Changes

- Updated dependencies [6a61dbf]
  - @telorun/kernel@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [f75a730]
- Updated dependencies [f75a730]
  - @telorun/kernel@0.3.3

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.
- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/kernel@0.3.2
  - @telorun/analyzer@0.2.1

## 0.3.1

### Patch Changes

- 2d866be: Add `--skip-controllers` flag to `telo publish`. When set, skips the controller build/publish/PURL-rewrite loop and only runs static analysis and pushes the manifest to the Telo registry. Used by the Changesets-driven CI release flow, where controller packages are already published by `changeset publish`.

## 0.3.0

### Minor Changes

- 31d721e: feat: bearer-token auth for the Telo module registry publish endpoint

  The registry's `PUT /{namespace}/{name}/{version}` now requires an `Authorization: Bearer <token>` header. Reads stay anonymous. Tokens are provisioned declaratively at boot via `TELO_PUBLISH_TOKEN` and stored as SHA-256 hashes in a `tokens` table joined to `users` and `namespaces`.

  **Analyzer** (`@telorun/analyzer`) — **breaking for direct API consumers**

  - `StaticAnalyzer` and `Loader` now accept an optional `{ celHandlers }` in their constructors. Analyzer-only callers (VS Code extension, Docusaurus preview, CLI `check`/`publish`) can omit it and get throwing stubs. Runtime callers (kernel) must supply real handlers.
  - The module-level `celEnvironment` singleton is removed — `precompile.ts` now takes the `Environment` as a parameter.
  - New CEL stdlib function: `sha256(string): string`. Always registered with the correct signature so `env.check()` type-checks; behaviour depends on the supplied handler.
  - The throws-union resolver recognises the new `throw:` step shape (see Run module) and resolves its code at the call site using the same rules as passthrough invocables (literal / `${{ 'LIT' }}` / `${{ error.code }}` in catch).
  - CEL type-check failures now surface as diagnostics. Previously the analyzer only reported schema/type mismatches on valid expressions; `env.check(...)` returning `{ valid: false }` (wrong method, wrong operand types, wrong overload — e.g. `s.slice(7)` on a dyn) was silently dropped. Now surfaces as `SCHEMA_VIOLATION` with a `CEL type error:` message.

  **Kernel** (`@telorun/kernel`)

  - Constructs `StaticAnalyzer` and `Loader` with a `node:crypto`-backed `sha256` handler, so CEL templates invoking `sha256()` evaluate at runtime.

  **Run module** (`@telorun/run`) — **breaking**

  - `Run.Sequence` gains a first-class `throw:` step variant: `- name: X; throw: { code, message?, data? }` — throws `InvokeError` directly from inside the sequence. Works inside `catch:` blocks via `code: "${{ error.code }}"` for re-raise. A malformed `throw.code` (non-string or empty after expansion) is itself reported as `InvokeError("INVALID_THROW_STEP", …)` rather than a plain Error, so the failure stays in the structured-error channel and a surrounding `catches:` can map it.
  - The `Run.Throw` invocable is removed. Existing `invoke: { kind: Run.Throw }` call sites must migrate to `throw:` steps. The separate kind was redundant with the new step form, and the `throw:` step expresses the intent more directly inside sequences.
  - **Event-stream change:** `throw:` steps do **not** emit a scoped `<Kind>.<name>.InvokeRejected` event the way `Run.Throw` did. The error is thrown from inside the sequence's own `invoke()`, so the enclosing kind's event is what fires (e.g. `Run.Sequence.<handlerName>.InvokeRejected` — or nothing, when an enclosing `try` absorbs the throw). Downstream observers that filtered on `Run.Throw.*.InvokeRejected` must switch filters.

  **CLI** (`@telorun/cli`)

  - `telo publish` reads `TELO_REGISTRY_TOKEN` and sends it as `Authorization: Bearer <token>`. Without the env var, publishes to auth-gated registries fail with 401.

  See `apps/registry/plans/registry-auth.md` for the full plan.

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/kernel@0.3.0
  - @telorun/analyzer@0.2.0

## 0.2.9

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.4
  - @telorun/kernel@0.2.9

## 0.2.8

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/kernel@0.2.8

## 0.2.7

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/kernel@0.2.7

## 0.2.6

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/kernel@0.2.6

## 0.2.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.5

## 0.2.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.4

## 0.2.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.3

## 0.2.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.2
