# @telorun/analyzer

## 0.39.0

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

- @telorun/templating@0.10.1

## 0.38.0

### Minor Changes

- 0368e6f: Declare module provenance in `metadata`, projected into OCI annotations.

  `Telo.Application` and `Telo.Library` metadata now accept four optional
  descriptive fields: `description`, `repository` (the module's source-code URL),
  `license`, and `documentation`. An OCI publish maps them onto the standard
  `org.opencontainers.image.*` annotations (`repository` → `source`, `license` →
  `licenses`), which is the only metadata channel GHCR exposes — it does not serve
  the referrers API. Fields a module does not declare are omitted rather than
  written empty. An HTTP registry publish stores the manifest verbatim, so nothing
  needs translating there.

  These are descriptive, never addressing: nothing resolves, fetches, caches, or
  publishes by them, so identity remains the ref. The field is `repository` rather
  than `source` because `source:` already means "where to fetch a dependency from"
  inside the `imports` map.

### Patch Changes

- 8af345f: Bake `extends`-resolved schemas in the build-time validator warm.

  A `base:`-less `extends` child is validated at runtime against
  `merge(parent, own)`, but the warm pass compiled only the raw `schema:`. The
  validator cache is content-addressed, so those are different keys — every
  inheriting kind missed the warm on every boot, recompiling its validator and,
  on a read-only image, failing to persist it (`EACCES` writing
  `.telo/manifests/__validators/`).

  `precompileDefinitionSchemas` now also compiles the inheritance-resolved form,
  sharing `effectiveAuthorSchema` with the runtime stamp so the two keys cannot
  drift. The raw schema is still baked — it backs definitions that don't inherit
  and the `controller.schema` fallback path.

  The parent is resolved through the new `AnalysisRegistry.resolverForDefinition`,
  scoped to the DECLARING module. `extends` aliases are lexically scoped — a
  library writes `extends: Cache.Store` against its own import map and `Self.Host`
  against its own name — so a global resolver silently fails on both and bakes the
  un-merged schema, reintroducing the miss.

  - @telorun/templating@0.10.1

## 0.37.0

### Minor Changes

- ec524cd: Enforce the `exports.kinds` gate statically. The analyzer's gate was dead code — it read `exports.kinds` off the `Telo.Import` doc, which has no such field, so the list was always empty and no unexported kind was ever rejected. `flattenForAnalyzer` now stamps the target library's resolved `exports.kinds` (re-exports included) onto each `Telo.Import` as `metadata.exportedKinds`, and the analyzer registers it, so `telo check` agrees with the kernel instead of being silently more permissive.

  An unexported kind now reports `KIND_NOT_EXPORTED` naming the module and its exported kinds, rather than an `UNDEFINED_KIND` whose "did you mean" echoed back the kind just rejected.

  `registerImport` / `registerModuleImport` take `kinds?: readonly string[]`, separating cases the previous empty array conflated: a declared gate (`["A"]`), a gate that exports nothing (`[]`), and a target declaring no `exports.kinds` at all (`undefined`, the legacy permissive default). This is the groundwork for making kinds private by default; that default is unchanged for now, since already-published module versions cannot gain the block retroactively.

  The gate is consulted before any definition-registry lookup. The registry is keyed `<module>.<Kind>`, so a library whose `metadata.name` equals the alias it is imported under made the raw kind string a valid key — the definition resolved directly and an unexported kind was accepted, while the kernel threw at boot.

  `resolveExportedKinds` distinguishes a module that declares no `exports.kinds` from one that declares an empty list, so a re-export (`exports.kinds: [Alias.Kind]`) whose source module is ungated still resolves, matching the kernel instead of rejecting a manifest that runs.

  `registerUngatedAlias` replaces the ungated form of `registerImport` for `Self` and the `Telo` built-ins. Those cross no import boundary and must never be gated; keeping them on a separate method leaves the legacy permissive import as the only remaining ungated `registerImport` call, so making kinds private by default is a single greppable site.

  `AnalysisRegistry.registerImport` takes the gate as optional too, and gains `registerUngatedAlias`, so IDE/editor consumers express the same three intents as the kernel.

### Patch Changes

- @telorun/templating@0.10.1

## 0.36.0

### Minor Changes

- bd4f3ac: Support direct `https://` module refs in the manifest-cache key contract. `analyzer` gains `isHttpsModuleRef` and `urlManifestCacheCoords(ref, version)` — a URL addresses one file whose version lives inside it, so the version is supplied by the caller rather than parsed from the ref; a trailing `telo.yaml` is dropped so the key doesn't duplicate the filename, and refs carrying a query or userinfo are rejected (both would let distinct URLs collide onto one key, or smuggle an authority). `telo module manifest --json` now emits a `cacheKey` for `https://` refs, built from the `metadata.version` the fetched manifest declares.

## 0.35.0

### Minor Changes

- 56c810b: Remove the `KIND_MISSING_DESCRIPTION` diagnostic. Exported-kind descriptions feed semantic discovery but are no longer gated by the analyzer — the discovery hub indexes whatever description exists.
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

## 0.34.1

### Patch Changes

- cd3ec0b: Fix a false positive in `base:` mapping validation: a `!cel` value in a `base:`
  mapping is a raw tagged sentinel at analysis time (not a compiled value), so
  `containsCel` missed it and the sentinel was AJV-checked against the parent
  field's type — wrongly raising `BASE_SCHEMA_MISMATCH` ("must be string (got
  undefined)") for any CEL mapping (e.g. `baseUrl: !cel "self.url + '/api'"`) when
  the defining library was analyzed as a root. CEL leaves in `base:` are now
  skipped (their runtime type isn't statically knowable); literal values are still
  fully validated.

## 0.34.0

### Minor Changes

- 8c24da2: General kind inheritance: a `Telo.Definition` may now `extends` **any** kind —
  concrete or abstract — with single inheritance. A child that declares no own
  `controllers:`/template body inherits the parent's controller by delegation: the
  kernel evaluates the child's new `base:` mapping (CEL over `self`) and returns the
  native parent instance verbatim, so the child duck-types as its parent. Capability
  is inherited and immutable (`EXTENDS_CAPABILITY_MISMATCH` on a conflicting
  restatement); `x-telo-ref` slots accept a target kind and every kind that
  transitively extends it (Liskov-substitutable). With `base:`, the child's
  author-facing schema narrows to its own; without it, it is `merge(parent, own)`.
  `Telo.Abstract` is retained as the non-instantiable base. `EXTENDS_NON_ABSTRACT`
  is removed. Both paths run end-to-end: `base:` narrowing and the no-`base:`
  additive merge (the child carries the parent's config fields directly). The
  analyzer statically validates `base:` against the parent config schema
  (`BASE_MISSING_REQUIRED` / `BASE_UNKNOWN_FIELD` / `BASE_SCHEMA_MISMATCH`), and the
  field map, `self` typing, and per-instance validation all resolve against the
  effective (inheritance-aware) schema. The http-client request controller now
  resolves a `client` slot through the live instance so an inherited Client works
  inside a scope.

### Patch Changes

- @telorun/templating@0.10.1

## 0.33.0

### Minor Changes

- 3961e35: Add the `KIND_MISSING_DESCRIPTION` warning: a `Telo.Library` that exports a
  locally-defined kind whose `Telo.Definition` has no `metadata.description` now
  gets a non-blocking warning. The description is the primary text the
  federated-discovery hub embeds for semantic `search_resources`, so exported
  kinds should carry one. Re-exported kinds (`exports.kinds: [Alias.Kind]`) and
  non-exported internal kinds are not flagged, and the check only fires when a
  library is analyzed directly — importing an under-described library never leaks
  warnings to its consumer.
- b5a325f: Validate `Run.Sequence`-style step `invoke` references. The reference field map
  deliberately does not descend into step `invoke` slots (they sit behind the
  shared step `$ref`, and descending would make Phase 5 inject live instances
  there), so these slots escaped `validateReferences` entirely — a step
  `invoke: !ref <name>` that named a missing instance, or a _kind_ instead of an
  exported instance (`invoke: !ref Stream.Of`), passed `telo check` and only
  failed at runtime with `ERR_RESOURCE_NOT_FOUND`. A new pass covers exactly those
  slots in two dimensions: after sentinel resolution, an invoke value still a
  `!ref` sentinel is reported as `UNRESOLVED_REFERENCE` (missing instance /
  kind-instead-of-instance), and a resolved instance whose capability structurally
  has no invoke/run method (`Telo.Provider` / `Telo.Mount` / `Telo.Type` /
  `Telo.Template`) is reported as `REFERENCE_KIND_MISMATCH` — the static mirror of
  the runtime `ERR_RESOURCE_NOT_INVOKABLE` (`Telo.Service` is excluded, since some
  services are invocable). Generic and topology-driven — it walks steps via the
  same `x-telo-step-context` / `x-telo-topology-role` annotations as the
  step-context builder (through a shared step-walker), so nested branches
  (then/else/do/catch/cases) are covered and no resource kind is hardcoded, and it
  applies the same cross-module partial-analysis guard as `validateReferences`.
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

- Updated dependencies [9a92bf1]
  - @telorun/templating@0.10.1

## 0.32.0

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

## 0.31.0

### Minor Changes

- 36af5f5: Surface YAML parse failures as error diagnostics. A document that fails to
  parse (e.g. an unquoted scalar containing `: ` that the parser reads as a
  nested mapping) previously produced a mangled `toJSON()` projection that
  static analysis silently accepted — `telo check` reported "passed" while the
  registry rejected the same file on push. The loader now aggregates every
  file's YAML `parseErrors` into `LoadedGraph.parseDiagnostics` (fatal `Error`
  diagnostics carrying the parser's line/column range), surfaced by `telo check`
  / `telo publish` / the editor / VS Code and treated as fatal by the kernel at
  load.

## 0.30.1

### Patch Changes

- 5dd71ee: Fix Phase-5 reference injection for resources inside an imported library. `expandedFieldMapForResource` resolved a resource's own kind through the global alias scope, so a library-internal resource whose kind uses a library-local import alias (e.g. `Ai.AgentStream` in a library that imports `Ai`) produced no ref-field map — and its references (a model, tool providers, …) were silently left uninjected, surfacing at runtime as `'model' is not a live instance` (ERR_INVALID_REFERENCE). The kind is now resolved through the resource's own module alias scope, so imported-library resources get their refs injected like root resources do.

## 0.30.0

### Minor Changes

- 4e5d861: Remove the `env` CEL global. Manifests can no longer read raw host environment
  variables via `${{ env.X }}` — that path was long superseded by per-field `env:`
  bindings on typed `variables:` / `secrets:` / `ports:` entries.

  To reach a host variable, declare a typed root entry bound to it and reference
  the resolved value:

  ```yaml
  secrets:
    apiKey: { env: OPENAI_API_KEY, type: string, default: "" }
  # then: !cel "secrets.apiKey"
  ```

  The kernel no longer forwards `process.env` into the root module's CEL scope
  (`this.env` still feeds `variables`/`secrets`/`ports` resolution and the
  controller `ResourceContext`), and the analyzer drops `env` from the kernel
  globals, so `env.X` now fails static analysis as an undeclared reference. No
  deprecation shim — references must migrate to a declared `variables:`/`secrets:`
  entry.

### Patch Changes

- 2d9323c: Stop warning on additive pre-1.0 version hoists. When the same module is
  imported at different versions within one major, the graph already resolves
  every importer to the highest version — a non-lossy, by-design redirect. It no
  longer emits a `MODULE_VERSION_HOISTED` warning per import edge (which flooded
  `telo check` and `telo run` output for normal version skew).

  A `MODULE_VERSION_HOISTED` warning is still raised for the genuinely ambiguous
  case — two sources claiming the same version with differing content — and an
  incompatible major mismatch remains a hard `MODULE_VERSION_CONFLICT` error.

## 0.29.0

### Minor Changes

- ebca26a: Add a `CEL_IN_NON_EVAL_FIELD` analyzer diagnostic: a `!cel` (or `${{ }}`) in a field the runtime never evaluates — one with no `x-telo-eval` and outside every `x-telo-context` / `x-telo-step-context` / `x-telo-error-context` region — is now an error instead of passing silently. This closes the static gap that let a `!cel` `concurrency` on `Run.Projection`/`Run.Iteration` read as a literal and degrade to `[null, …]` at runtime. The check resolves eval-paths from both the resource's own schema and its capability abstract (so provider fields, all implicitly `x-telo-eval`, stay live) and stops at nested inline `{ kind }` resource boundaries (their CEL is governed by their own kind).

  `x-telo-eval` path handling now lives in `@telorun/analyzer` and is re-imported by the kernel, so the runtime and the analyzer share it rather than re-implementing it. Both halves are shared: `buildEvalPaths` (schema → eval paths) and the containment rule `evalPathCovers` (does an eval path cover a concrete path). The analyzer's coverage check (`evalPathsCover`) and the kernel's compile/runtime exclusion (`isExcluded`) both route through `evalPathCovers`, so a change to the matching semantics applies to both at once. The kernel's `expandPaths` keeps its own tree-walk for expansion (it mutates the value tree, not a coverage test), structurally consistent with the shared rule because eval paths are property-only.

## 0.28.1

### Patch Changes

- a9ac4ba: Resolve `Type.JsonSchema` `extends` into a single self-contained object schema (a deep-merge of the parent schemas and the own schema) instead of an `allOf` wrapper, and expose the resolved schema as readable `schema` state on the Type instance.

  The merge is now a single shared function, `mergeTypeSchemas` in `@telorun/sdk`, called by both the runtime `type` controller and the analyzer — so static analysis and runtime validation can never disagree on a type's effective shape. This fixes a false `CEL_UNKNOWN_FIELD` the analyzer raised when CEL accessed a field inherited through `extends` (it previously saw only a child type's own properties).

  The merged form carries no `$ref`s, so a named type's effective shape is directly usable as a validation schema (e.g. an HTTP request body) without bundling, and it removes the `allOf` + `additionalProperties: false` footgun where each branch independently rejects the other branch's properties. `required` is unioned across all levels and child properties win on a key conflict. Composition keywords (`allOf` / `oneOf` / `anyOf`) declared on a parent or own schema are preserved as intersected `allOf` branches — never silently dropped — so an inherited constraint still applies.

  - @telorun/templating@0.10.0

## 0.28.0

### Minor Changes

- 5ea5ff3: Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

  `new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

  This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.

- 5ea5ff3: Reconcile module versions to one version per identity within an import graph.

  When the same `<namespace>/<module-name>` is reached at multiple versions (a diamond import), the loader now collapses them onto a single version before any controller, definition, or kind is registered — fixing the spurious `DUPLICATE_IMPORT_ALIAS` and the silent last-writer-wins controller collision that two versions of one module previously caused.

  - Same major → the highest version wins (a non-lossy hoist given the additive-only pre-1.0 policy), reported as a `MODULE_VERSION_HOISTED` warning on the lower-version import line.
  - Different major → a fatal `MODULE_VERSION_CONFLICT`; `telo run` refuses to start and `telo check` errors.
  - Same version from two sources with differing content → a `MODULE_VERSION_HOISTED` warning; identical content is deduplicated silently.

  Reconciliation lives in the shared analyzer loader, so `telo check`, the kernel runtime, and the editor all resolve the same single version. `LoadedGraph` gains `overrides` and `versionDiagnostics`.

## 0.27.0

### Minor Changes

- dded615: Templated definitions can now produce a mountable HTTP surface, and their dispatch targets are created once instead of per call.

  - **`mount:` template dispatch** — a `Telo.Definition` with `capability: Telo.Mount` may declare `mount: <child>` (sibling to `invoke:` / `run:` / `provide:`) naming a `resources:` entry that is itself a `Telo.Mount` (e.g. an `Http.Api`). The template instance's `register()` delegates to that persistent child, so a library can ship a self-contained, declarative HTTP resource. The analyzer validates the new field (`MOUNT_ON_NON_MOUNT`, `MOUNT_DISPATCHER_CONFLICT`, `MOUNT_TARGET_UNKNOWN`, `MOUNT_TARGET_NOT_MOUNTABLE`).
  - **Persistent dispatch targets** — the template controller no longer re-creates its `invoke:` / `run:` / `provide:` target on every call (`withEphemeral` is removed). Every `resources:` entry is created once at `init()` and reused; per-call data flows exclusively through the top-level `inputs:` sibling. A resource body may reference only `self`; `${{ inputs.* }}` inside a target body is no longer supported (move it to the top-level `inputs:`).
  - **Library-scoped child resolution** — a template's `resources:` are spawned in a child context rooted on the _defining_ library's module context (new `EvaluationContext.spawnChildContext()`), so their internal kind aliases and `!ref`s resolve against the library's own imports rather than the consumer's.
  - **http-server** — a route declared at `/` now sits at the mount root (`/todos` + `/` → `/todos`) instead of a trailing-slash variant Fastify treats as a distinct, unmatched URL, so collection-style mounts respond at the mount path itself.

### Patch Changes

- @telorun/templating@0.10.0

## 0.26.0

### Minor Changes

- 12f6d6f: Add `files:` for bundling static assets into a published module. A `Telo.Application` or `Telo.Library` may declare a `files:` list of ordered, `.gitignore`-style patterns (matched with the `ignore` engine: positive patterns opt in, `!` patterns carve out, last-match-wins). When present, `telo publish` packs `telo.yaml` plus the selected files into a `module.tar.gz` and PUTs it to the registry; `telo install` / `telo run` extract that archive into the local cache next to the cached `telo.yaml`, so a relative `Http.Static` `root:` (e.g. a built SPA in `./public`) resolves on the consumer exactly as it does in development. An always-on ignore set (`node_modules/`, `.git/`, `.telo/`, `.telobundle.*`) is never shipped. The CLI's `include:` resolver moves from `minimatch` to the same `ignore` engine.

## 0.25.0

### Minor Changes

- d7fda97: Add module-scoped JSON Schema `$ref`s for named `Telo.Type` resources. A `Type.JsonSchema` now registers its schema under a canonical URI `$id` of `telo://<module>/<name>`, so any `inputType` / `outputType` / config `schema` can reference it with a standard JSON Schema `$ref`. Authors write the reference through an import — `telo://Self/<name>` for the declaring module's own type, `telo://<Alias>/<name>` for an imported module's — and the loader resolves the authority to the module name (the version is carried by the `imports:` entry, never the URI).

  - `@telorun/sdk` exports `canonicalTypeSchemaId`, `parseTeloTypeRef`, and `TELO_TYPE_SCHEME`.
  - `@telorun/analyzer` rewrites `telo://Self|Alias/Type` schema refs to their canonical id in both `analyze` and `normalize` (so the kernel runtime, import loads, and static analysis agree), registers named-type schemas in its AJV, and emits `SCHEMA_TYPE_REF_UNRESOLVED` / `SCHEMA_TYPE_REF_UNKNOWN_ALIAS` diagnostics for refs that resolve to nothing.
  - `@telorun/type` registers each `Type.JsonSchema` under its canonical `telo://` id in the runtime schema registry.

  This lets a module declare a shared schema fragment once (e.g. a filter grammar) and reference it from several definitions without duplicating it, while keeping references statically analyzable and version-pinned through the import.

### Patch Changes

- @telorun/templating@0.10.0

## 0.24.1

### Patch Changes

- Updated dependencies [0c16f41]
  - @telorun/templating@0.10.0

## 0.24.0

### Minor Changes

- aaa760d: Add the `x-telo-context-element-from` CEL-context annotation. On a context variable, it derives the variable's schema from the element type of a sibling collection expression — when that collection is a member-access chain into the resource's typed `inputs` contract, the variable is typed as the array's `items`; non-chain or untyped collections fall back to `dyn` (no false positives). This lets `std/run`'s `Run.Iteration` / `Run.Projection` type `item` automatically from `collection`, so `item.<unknownField>` is a `CEL_UNKNOWN_FIELD` with no author annotation.

### Patch Changes

- Updated dependencies [aaa760d]
  - @telorun/templating@0.9.0

## 0.23.2

### Patch Changes

- d59e847: Fix a false-positive `INVALID_REFERENCE_FORM` diagnostic on `!ref` slots. The
  analyzer's inline-normalization and sentinel-resolution passes mutated their
  input manifests in place, rewriting `!ref` sentinels to `{kind, name}`. When a
  caller reused the same manifest objects across analyses (notably the editor's
  `LoadedFile.manifests` parse cache while a file stayed clean), a later pass saw
  the already-rewritten `{kind, name}` and rejected it as an unsupported reference
  form. `normalizeInlineResources` now deep-clones its input (treating compiled-CEL
  nodes as opaque by-reference leaves), so analysis never mutates caller-owned
  manifests.

## 0.23.1

### Patch Changes

- 5973024: Fix scope resolution for route handlers of an `Http.Api` (or any composer) that
  is defined in a library and mounted/consumed by another module. The library's
  inline `kind:` handlers and their `!ref`s are anonymous children of the
  declaring document and now resolve against that library's import map rather than
  the consumer's.

  - Analyzer: top-level kind validation and throws-union/`catches:` coverage now
    resolve a resource's kind aliases in its own `metadata.module` scope (falling
    back to the consumer's), mirroring the existing nested-inline and reference
    paths. This removes false `UNDEFINED_KIND` and `UNBOUNDED_UNION_NEEDS_CATCHALL`
    diagnostics for imported-library handlers.
  - Kernel: imported libraries now initialize their resources in dependency
    (topological) order, like the root context, so a dependent (e.g. an `Http.Api`
    whose inline handler is extracted to a sibling resource) no longer runs Phase 5
    injection before its dependency is created — which previously left the handler
    ref unresolved and produced `ERR_RESOURCE_NOT_INVOKABLE` at request time. A
    circular dependency purely among a library's own resources (invisible to the
    root graph) is now surfaced as `ERR_CIRCULAR_DEPENDENCY`, mirroring the root.

## 0.23.0

### Minor Changes

- c89e79b: feat(kernel,analyzer): transitive re-export of exported instances and kinds

  A `Telo.Library` may now re-export both an instance and a kind it reaches through one
  of its own imports, using plain dotted names (the `!ref` tag is not allowed in
  `exports.resources`):

  ```yaml
  exports:
    resources:
      - Migrate # export a locally-owned instance
      - Domain.Db # re-export the instance reached via this lib's `Domain` import
    kinds:
      - Greeting # export a locally-defined kind
      - Domain.Thing # re-export a kind imported from `Domain`
  ```

  A consumer importing the library as `Api` then references `!ref Api.Db` /
  `kind: Api.Thing`. Re-export composes to arbitrary depth (`app → api → domain → …`)
  because each hop just re-declares `<PrevAlias>.<Name>` / `<PrevAlias>.<Kind>`,
  and resolution stays O(1) regardless of depth: each import builds flattened export
  tables that copy the owner's terminal getter / canonical kind by reference, so a
  lookup never walks the chain. The analyzer forwards re-exported instances and kinds
  transitively (fixpoint over the import graph) so `telo check` resolves them too,
  keeping static analysis and runtime in agreement, and the `exports.kinds` gate still
  rejects kinds that aren't re-exported. Bare-string `exports.resources` entries keep
  working as local exports.

### Patch Changes

- 4794671: fix(kernel,analyzer): evaluate import `variables`/`secrets` against the importer's config

  An import's `variables:`/`secrets:` values that contained CEL expressions (`${{ }}` or
  `!cel`) were baked into the child library context **verbatim** — as unevaluated
  compiled-value objects — instead of being evaluated against the importing module. So
  config could not flow from an application through intermediate libraries into leaf
  libraries: a nested `dbFile: "${{ variables.dbFile }}"` reached the leaf as an object and
  crashed the consumer (e.g. `Sql.SqliteConnection`: `path must be of type string, got
object`).

  Import inputs are now evaluated against the **importing module's `variables`/`secrets`**.
  Resolution is eager and per-hop — each importer resolves its child's inputs from its own
  already-settled config — so a value flows `app -> lib -> lib` at any nesting depth and a
  leaf reads `variables.X` as an O(1) concrete lookup, with no chain-walk.

  Import inputs are a config-only contract: the analyzer now type-checks these expressions
  against the importer's `variables`/`secrets` (catching typos and fixing the prior
  wrong-scope `!cel` false positive), and rejects `resources`/`env`/`ports` references —
  runtime value-flow surfaces are deliberately out of scope here. To pass an env-derived
  value into a library, bind it to a typed root `variables:`/`secrets:` entry and forward
  `${{ variables.X }}` / `${{ secrets.X }}`.

## 0.22.0

### Minor Changes

- ee8926f: Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
  and bare-string references are removed: the analyzer rejects them up front
  (`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
  authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
  whole manifest tree (including step `invoke`s and refs nested in inline
  definitions), so every consumer sees the uniform resolved shape. The
  http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
  mcp transports / clients read their Phase-5-injected ref instances directly.

  Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
  slot may still pin (older published modules encode references as `type: string`)
  before running AJV, so a resolved reference object validates against a legacy
  `x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
  dependency analyzable and bootable during the migration. Object-typed ref slots
  that also accept an inline value (e.g. `inputType` / `outputType`) are left
  untouched.

  `Run.Sequence` reference slots are brought onto the same enforcement path: a
  step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
  slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
  to `/targets`), so a bare-string ref at either is rejected with
  `INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
  targets — instead of failing as an obscure runtime error. The controller reads
  the resolved reference rather than a bare name.

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/templating@0.8.0

## 0.21.0

### Minor Changes

- 8586b39: Resolve resource references uniformly across import boundaries and execution scopes.

  - **http-server**: `mounts[].type` is now an injected `Telo.Mount` reference (`!ref <name>`, or `!ref <Alias>.<name>` for a mount exported by an imported library) instead of a dotted kind-string. The server consumes the live injected instance, so an `Http.Api` / `Mcp.HttpEndpoint` defined in another library can be mounted across the boundary. The bare `Kind.Name` string form is removed.
  - **s3**: `bucketRef` is now an `x-telo-ref: "std/s3#Bucket"` slot (`!ref <bucket>` / `!ref <Alias>.<bucket>`); controllers consume the injected `S3.Bucket` instance, so S3 operations can reference a bucket exported by another library. The `{ name }` form is removed.
  - **analyzer**: `resolveRefSentinels` recurses into `x-telo-scope` resources, so a `!ref` inside a scoped resource (e.g. a `Run.Sequence` `with:` server's mount) is canonicalized to `{kind, name}` like any top-level slot.
  - **kernel**: Phase-5 dependency injection targets the (compile-CEL-expanded) resource the controller actually receives, so injected instances reach reference fields that also carry `x-telo-eval: compile` (e.g. `Http.Server.mounts`).
  - **sdk**: `CreatedResource` gains an optional `resource`, letting a factory return the expanded manifest the controller was created with.

- 2292a84: Upgraded cel-js package to 7.6.1

### Patch Changes

- Updated dependencies [2292a84]
  - @telorun/templating@0.7.0

## 0.20.0

### Minor Changes

- 06cfcbf: Instantiating an abstract kind directly (e.g. `kind: Sql.Connection`) now fails with a clear message — "Kind 'X' is abstract and cannot be instantiated directly; instantiate a concrete implementation: …" — listing the concrete kinds that extend it, instead of the generic "No controller registered". Adds `AnalysisRegistry.implementationsOf(kind)`.

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/templating@0.6.0

## 0.19.1

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0

## 0.19.0

### Minor Changes

- 81ebf47: Add `AnalysisRegistry.acceptedKindsForRef(ref)` — the canonical (`module.Type`) kinds that satisfy an `x-telo-ref` constraint (an abstract expands to its implementations, a concrete kind yields itself), import-independent so it also covers locally-defined kinds. `userFacingKindsForRef` now derives from it. Lets editor hosts narrow ref candidates by kind satisfaction instead of base capability, so a slot typed to a specific abstract (e.g. an `Mcp.SessionProvider`) only offers that abstract's implementations rather than every `Telo.Provider`.
- 81ebf47: Add `AnalysisRegistry.outputTypeForKind(kind)`, mirroring `inputTypeForKind`: resolves a kind's `outputType` (own definition, then the `extends`-declared abstract) to its JSON Schema for editor hosts that render a typed output signature. Inline and raw-schema forms resolve; a bare named type reference is left unresolved.

### Patch Changes

- ea57e10: CEL type-checking now descends into `additionalProperties` map values, applying the map's value schema to every entry. Previously CEL inside an open-keyed object map (e.g. a migration's `sql:` body) was typed against an empty schema and went unchecked.

## 0.18.0

### Minor Changes

- d2294de: Type `inputType` / `outputType` on `ResourceDefinition` (they were read through an untyped cast). Add `AnalysisRegistry.refFieldsForResource()`, `capabilityForRef()`, and `inputTypeForKind()`. `refFieldsForResource` returns every `x-telo-ref` field a resource's definition declares — path, arity (`isArray`), accepted constraints, and the capabilities each slot may target — derived purely from the schema field map, so it lists slots even when the manifest leaves them empty. `capabilityForRef` resolves an `x-telo-ref` constraint to the base capability it targets (a user-defined abstract's declared `capability`, not its kind). `inputTypeForKind` resolves a kind's `invoke()` input schema (own `inputType`, falling back to the `extends`-declared abstract's). Together they let editor hosts render reference fields as node ports (drag-to-wire for node-capability targets, inline picker for ambient ones) and edit an edge's invocation `inputs` as a typed form — without hardcoding any resource kind.

### Patch Changes

- @telorun/templating@0.4.1

## 0.17.0

### Minor Changes

- 69a0a8d: Align the telo-editor's static-analysis projection with the CLI's import boundary. Extract `flattenForAnalyzer`'s local/foreign forwarding rule into a shared `selectModuleManifestsForAnalysis` helper so the editor and the CLI cannot drift, and have the editor apply it per closure: the closure root stays fully local while imported modules forward only their definitions/abstracts/imports plus `exports.resources` instances (flagged `forwardedExport`). The editor now also anchors a closure at every workspace-local module (not just Applications), so a library imported by an app is validated in its own scope instead of the consumer's. Fixes cross-module `!ref Alias.export` (e.g. a flat `targets` invoke step) reporting spurious `SCHEMA_VIOLATION` / `UNDEFINED_KIND` in the editor while passing `telo check`.

## 0.16.1

### Patch Changes

- c1432a6: ai: `Ai.Agent` tool-use loop + `Ai.ToolProvider` / `Ai.Tools`, with MCP discovery via `@telorun/ai-mcp`

  Adds a tool-use agent to the AI module. `Ai.Agent` (`Telo.Invocable`) runs a buffered
  loop over any `Ai.Model`: it advertises a tool set, executes the tools the model
  requests, replays the results, and loops until the model produces a final answer or
  `maxSteps` is reached. The loop lives in the controller (provider-agnostic, observable
  via the returned `steps` trace), not in the provider.

  Tools come from one field, `toolProviders` — a list of `Ai.ToolProvider` references.
  `Ai.ToolProvider` is a new `Telo.Abstract` (`capability: Telo.Mount`) exposing
  `listTools()` / `callTool()`; the agent mounts providers the way `Http.Server` mounts
  `Http.Api`s. Two implementations ship:

  - `Ai.Tools` (in `@telorun/ai`) — a static list of tools, each wrapping any
    `Telo.Invocable`, with a required model-facing `parameters` schema and optional
    `inputs:`/`result:` CEL mappings for invocables whose call shape diverges.
  - `AiMcp.ToolProvider` (new package `@telorun/ai-mcp`) — discovers a whole MCP server's
    tools at run time (`tools/list` → descriptors, `tools/call` → dispatch). It is the only
    module depending on both `@telorun/ai` and `@telorun/mcp-client`; the `ai` core stays
    MCP-agnostic and `mcp-client` stays a pure transport.

  The `Ai.Model` contract is extended additively: optional `tools` on input, optional
  `toolCalls` on output, a `tool` message role with `toolCallId` correlation, and a
  `tool-calls` finishReason. `Ai.Text` / `Ai.TextStream` never pass tools and are
  unaffected. `@telorun/ai-openai` wires tools through Vercel `generateText({ tools })`
  and translates the tool-role / assistant-tool-call messages.

  Loop bounds are configurable: `maxSteps` (default 8), `onMaxSteps` (`throw` | `return`,
  default `throw`), and `onToolError` (`feedback` | `throw`, default `feedback` — a failed
  or unknown tool is recorded in `steps` and returned to the model so it can recover,
  never silently swallowed).

  Analyzer fix (patch): seed the `Self` alias for every module that contributes
  definitions, not only modules whose `Telo.Library` doc is present in the flattened
  manifest set. `flattenForAnalyzer` forwards an imported library's definitions but not its
  module doc, so a kind declaring `extends: Self.<Abstract>` (an abstract in the same
  library) previously mis-keyed its `extendedBy` edge under the literal `"Self.<Abstract>"`
  when the library was imported rather than analyzed standalone. The bug stayed invisible
  until a second module implemented the same abstract (e.g. `Ai.Tools` + `AiMcp.ToolProvider`
  both implementing `Ai.ToolProvider`), at which point a valid reference to the
  `Self`-extending kind was wrongly rejected as not implementing the abstract.

## 0.16.0

### Minor Changes

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

### Patch Changes

- @telorun/templating@0.4.1

## 0.15.0

### Minor Changes

- 55b4ec5: Add exported resource instances: a `Telo.Library` can declare a resource and export it as a ready-made singleton via `exports.resources`, and consumers reference it across the import boundary with `!ref Alias.name` (and read value-flow exports in CEL as `${{ resources.Alias.name }}`). `std/console` now exports `writeLine` / `readLine` singletons, so a consumer can `!ref Console.writeLine` instead of declaring its own `Console.WriteLine` instance.

  Reference grammar: every `!ref` is `<Alias>.<name>`, split on the first dot — a bare name (or `Self.`-qualified) resolves locally; a non-`Self` alias resolves into that import's `exports.resources`. A resource name may no longer contain a dot (new `INVALID_RESOURCE_NAME` diagnostic), since the dot separates alias from name.

  `Self` now resolves a library's own kinds **ungated** (no longer bound to `exports.kinds`) — `exports` gates importers, not internal use — and the kernel registers `Self` in each import's child context, so a library can declare an instance of a kind it doesn't export (`kind: Self.WriteLine`).

  `std/assert` likewise exports its config-free assertions (`equals`, `matches`, `contains`) as singletons, so a test can `!ref Assert.equals` — including inside a `Run.Sequence` step — instead of declaring an `Assert.Equals` instance.

  Mechanics: the analyzer forwards a library's exported instances across the import boundary (gate = what's forwarded), and the kernel injects/boots them from the import's child context. Cross-module refs resolve on every consumption surface — Phase 5 injection (threads the alias; an unresolved ref defers to a later init pass), flat boot targets, `Run.Sequence` step invokes (via `resolveChildren` + `executeInvokeStep`), and CEL `${{ resources.Alias.name }}`. Lifecycle is unchanged — an exported instance is the import child context's existing singleton.

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

- Updated dependencies [adc248b]
  - @telorun/templating@0.4.1

## 0.14.0

### Minor Changes

- ae0bf77: Add flat invoke steps and conditional `when` guards to Application `targets`, so a
  runnable app can sequence and gate boot-time work without importing `std/run`.

  Alongside the existing bare reference, a `targets` entry now accepts:

  - a gated reference `{ ref: <Runnable/Service>, when?: <CEL> }` — `run()` only when
    the guard holds;
  - an inline invoke step `{ name?, invoke: <Invocable/Runnable ref>, inputs?, when? }`
    — call an Invocable on boot, with `steps.<name>.result` plumbed into later
    targets and an optional `when` guard.

  The flat invoke leaf (`when` + `inputs` expansion + ref resolution + `retry` +
  `steps.<name>.result`) is now a single shared primitive `executeInvokeStep` in
  `@telorun/sdk`. The kernel boot runner and the `Run.Sequence` controller both
  consume it, so the leaf semantics are single-sourced — `Run.Sequence` keeps
  control flow (`if`/`while`/`switch`/`try`), `with:` scopes, and the callable
  `inputs`/`outputs` wrapper.

  The analyzer's reference-field-map descends into object `anyOf` variants on a ref
  node, so nested refs like `targets[].invoke` register and resolve; reference
  validation skips the item-level `{kind, name}` check for the inline/gated object
  forms.

  `targets` are ref-only for now: inline targets reference declared resources
  (`!ref` / `{kind, name}`); inline resource definitions remain a `Run.Sequence`
  feature. Static CEL type-checking of target `when`/`inputs` and editor support
  for the new target forms are follow-ups.

- 222b3d6: `Run.Sequence` now guarantees a non-empty `error.code` and `error.message` inside
  every `catch` block. A caught failure that is not a structured `InvokeError`
  (e.g. a plain `Error` thrown by an invoked resource) is surfaced as
  `error.code === "INTERNAL_ERROR"` instead of `null`. A `throw: { code: "${{
error.code }}" }` rethrow can therefore never resolve to `null` — previously such
  a rethrow failed at runtime with `INVALID_THROW_STEP`, masking the underlying
  error.

  The analyzer's throws resolver mirrors this: a `try` block containing an
  `invoke:` step folds `INTERNAL_ERROR` into the union a `catch` re-raises via
  `error.code`, so an HTTP route's `catches:` list must cover it (or include a
  catch-all). The resolver also now recognises the `!cel`-tagged code form in
  `throw:` steps and passthrough call sites, matching the existing `${{ … }}`
  string handling.

  The analyzer now type-checks the `error` object inside `catch:` / `finally:`
  blocks via a new `x-telo-error-context` schema annotation. CEL expressions like
  `${{ error.cdoe }}` (a typo) are flagged with `CEL_UNKNOWN_FIELD` at any nesting
  depth; valid fields (`code` / `message` / `step` / `data`) pass. Inside `finally`
  `error` is typed as nullable (it is `null` on the success path), faithful to the
  runtime contract. The annotation is generic — any composer that declares
  error-bearing branch fields opts in the same way, with no resource kind hardcoded
  in the analyzer.

  CEL chain validation now also enforces null-safety: dereferencing a value whose
  schema admits `null` (e.g. `error` inside `finally`) without a null-guard is a
  static error (`CEL_NULLABLE_ACCESS`). Guards are recognised through `?:`
  ternaries and `&&` / `||` short-circuits (`error != null && error.code`,
  `error == null ? … : error.code`). This is general — it applies to any nullable
  value in any CEL context, not just `Run.Sequence`.

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/templating@0.4.0

## 0.13.0

### Minor Changes

- bfe4967: Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
  (sibling of `variables` / `secrets`) where each entry binds a host env var to
  an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
  typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
  mirroring the variables env-resolution path, with the same
  `ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
  `ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
  a single declared source. A runner or the editor can read the exposed ports
  (and the env var that configures each) before the app starts. Application-only;
  `Telo.Library` does not declare ports.

  Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
  port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
  nominal CEL type, and a resource field can declare which brand it accepts
  (`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
  `TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
  the value flows as a plain integer at runtime, so there is no runtime cost.

  Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
  `ports` entry that no CEL expression references is flagged (a generic,
  table-driven pass across the three namespaces). Application-only — a
  `Telo.Library`'s `variables` / `secrets` are a controller-consumed public
  contract and are not flagged.

- 1c37ee1: Add `visitManifest` — one shared manifest visitor that emits the annotation
  sites (`RefSite`, `ScopeBoundary`, `SchemaFromSite`, `CelSite`, plus resource
  enter/exit bookends) the analyzer's passes previously each rediscovered with
  duplicated scaffolding. `validate-references`, `dependency-graph`, and the CEL
  context walk now consume it; behaviour is unchanged (full analyzer + integration
  suites pass).

  Path-driven sites (ref / scope / schema-from) come from the per-kind field map;
  CEL sites are found by scanning the value tree, with the field map supplying the
  matched `x-telo-context`. Scope is per-resource: `ScopeBoundary` carries both the
  source-enclosure prefixes (for ref candidate scoping) and the enclosed-resource
  name set (for dropping boot edges to scoped targets), so no cross-resource
  ordering or global state is needed.

  Exposes `AnalysisRegistry.visitManifest` as the public host seam, and adds the
  editor `buildOverviewGraph` adapter that projects `RefSite` events into
  capability-classified edges (Service/Invocable/Runnable/Mount) and "uses" chips
  (Provider/Type).

### Patch Changes

- Updated dependencies [bfe4967]
  - @telorun/templating@0.3.1

## 0.12.1

### Patch Changes

- 6ce1a52: Fail loud instead of silently accepting manifests the analyzer can't fully process. A `Telo.Definition` whose schema AJV cannot compile (e.g. an unresolvable local `$ref`) previously had its compile error swallowed, silently skipping schema validation for every resource of that kind — it is now reported once as `SCHEMA_COMPILE_ERROR` on the definition. An expression tagged with an unregistered templating engine (`!foo`) was silently left unanalyzed and is now reported as `UNKNOWN_ENGINE`.
- 6ce1a52: Validate inline resources nested inside resource bodies. Inline resources sitting at `x-telo-ref` slots reached only through a local `$ref` (notably `Run.Sequence`'s `steps[].invoke`) were never analyzed, so a manifest like `invoke: { kind: Console.ReadLine, prompt: "…" }` — where `prompt` belongs in the step's `inputs` — passed analysis but failed at runtime. The analyzer now walks each resource against its definition schema and, at those reference slots, validates each inline resource's config against its own kind's schema and reports an unknown inline kind (`UNDEFINED_KIND`) — neither of which any field-map-driven pass could see.

## 0.12.0

### Minor Changes

- c0129c0: Tighten `StaticAnalyzer.analyze()`'s position-info contract and fix two `DUPLICATE_RESOURCE_NAME` reporting issues exposed by the telo editor.

  - **Contract.** `analyze()` now requires `metadata.source` (non-empty) and `metadata.sourceLine` (number) on every non-system manifest. Production callers — the `Loader`, `flattenForAnalyzer`, the telo-editor's `emitDocsFor`, the VSCode extension — already stamp these. Programmatic callers (tests, ad-hoc scripts) should pass inputs through the new `withSyntheticPositions(manifests, source?)` helper before calling `analyze()`; a missing position now throws a clear error instead of silently producing wrong diagnostics.

  - **Pipeline-echo false positives** — same physical doc emitted twice through an analyzer host's pipeline (e.g. a workspace file reachable from multiple modules) — now collapse cleanly. The dedup keys on `(kind, name, source, sourceLine)`, so identical docs are deduped while two textually-distinct duplicates in the same file (different `sourceLine`) keep separate fingerprints and still trip the diagnostic.

  - **Squiggle placement on real same-file duplicates.** When a user textually duplicates a resource in a single file (same kind + name, different `sourceLine`), the diagnostic now carries an explicit `range` pointing at the duplicate's line. Editor hosts that resolve diagnostic positions via a `${file}::${kind}::${name}` map otherwise collapse all instances onto whichever one the map happened to record — the explicit `range` short-circuits that lookup so the squiggle lands on the new duplicate, not the original.

  The new helper is exported from the package root:

  ```ts
  import { withSyntheticPositions, StaticAnalyzer } from "@telorun/analyzer";

  const diags = new StaticAnalyzer().analyze(withSyntheticPositions(manifests));
  ```

- 0331069: Static analyzer now catches two classes of bugs that previously surfaced only at kernel boot or request time.

  - **`DUPLICATE_RESOURCE_NAME`** — emitted when two non-system resources share a `metadata.name` (e.g. `Telo.Application HelloApi` and `Http.Api HelloApi`). The kernel's resource registry uses a single namespace across non-system kinds and rejects collisions at boot with `ERR_DUPLICATE_RESOURCE`; the analyzer now matches that behaviour so `pnpm run check` surfaces it.

  - **Fixes a silent bypass in object-form `{kind, name}` reference validation.** A `Telo.Application` (or `Telo.Library`) declared without a `metadata.namespace` was overwriting the registry's built-in `"telo"` identity (`registerModuleIdentity(null, moduleName)` in `definition-registry.ts`). As a result, every `x-telo-ref` keyed off `"telo#…"` (e.g. `Http.Api.routes[].handler`'s `"telo#Invocable"`) resolved to a nonexistent `<UserApp>.<Capability>`, the kind-mismatch check short-circuited on partial context, and the analyzer reported zero issues for manifests that exploded at runtime with `ERR_RESOURCE_NOT_INVOKABLE`. User-level modules without a namespace no longer claim that built-in identity.

  Together these two changes turn the canonical "`kind: JavaScript.Script`-when-the-alias-is-`JS`" mistake into a clear static `REFERENCE_KIND_MISMATCH` diagnostic instead of a runtime crash.

  New regression coverage at `analyzer/nodejs/tests/duplicate-and-bad-alias.test.ts`.

- 7889023: Add `!ref <name>` YAML tag for resource references (additive foundation).

  - **templating**: Register a new `ref` engine alongside `cel` and `literal` so `!ref <name>` parses to a `TaggedSentinel` with `engine: "ref"` and the bare resource name as `source`. Adds `isRefSentinel(v)` to detect ref-tag sentinels. Adds a shared `ResourceRefSchema` fragment plus `MANIFEST_SCHEMA_URI` (`telo://manifest`) and `ManifestRootSchema` — the canonical JSON-Schema home for ref-shape definitions that module YAMLs can `$ref` into. The symbols intentionally omit a host-specific prefix since they live in the templating package (the only layer both analyzer and kernel depend on); the URI is the contract.
  - **analyzer**: Recognises `!ref` sentinels at every `x-telo-ref` slot. A new `resolveRefSentinels` pass runs after inline normalization and substitutes each sentinel in-place with `{kind, name}` so downstream phases (reference validation, dependency graph, kernel controllers) see a uniform shape regardless of which surface the user picked. The substitution descends the manifest tree directly and mutates the parent container — no concrete-path string round-trip — so a future change to the field-path encoding can't silently break the writer. `validate-references` emits `UNRESOLVED_REFERENCE` when a sentinel doesn't resolve locally; `dependency-graph` adds boot-order edges for sentinel-named targets. `precompile` leaves ref sentinels intact (they are identity markers, not templating values, and must reach the resolution pass before being collapsed). A new `system-kinds.ts` consolidates the kind-skip sets the three passes (`REF_VALIDATION_SKIP_KINDS`, `DEPENDENCY_GRAPH_SKIP_KINDS`, `REF_RESOLUTION_SKIP_KINDS`) draw from so the asymmetries are named, not implicit. The analyzer's AJV instance now registers `ManifestRootSchema` under `telo://manifest` so module schemas can `$ref` shared fragments without bundling their own copy. The `Telo.Application.targets[]` schema admits both the legacy string form and the post-resolution `{kind, name}` object form, so `!ref <name>` works at that slot too.
  - **kernel**: `SchemaValidator` registers the same `telo://manifest` root so resource-config validators resolve the shared `$ref`. `ResourceContext.resolveChildren` handles `!ref` sentinels that reach a controller directly — currently a stopgap for slots hidden behind a local `$ref: "#/$defs/..."` that the analyzer's field-map walker doesn't descend; see follow-up below. `Kernel.load()` normalises `Telo.Application.targets[]` entries down to bare resource names whether the source surface was a string or a sentinel-resolved `{kind, name}` object — and now throws `ERR_INVALID_VALUE` on an entry it can't normalize rather than silently dropping it.

  **Follow-up (separate PR):** enable the analyzer's reference-field-map walker to follow local `#/$defs/<name>` refs. The walker already descends `oneOf`/`anyOf`/`allOf` variant properties in this PR; the remaining gap is the early-return on `$ref` (the recursion + cycle-detection plumbing is in place but the descent branch is disabled). Turning it on without first updating `Run.Sequence`'s controller (and any other dispatcher with the same pattern) to route through `EvaluationContext.invokeResolved` regardless of Phase-5 instance injection regresses the kernel's `<Kind>.<Name>.Invoked` event emission — sequence steps call `instance.invoke()` directly when handed a live instance, bypassing the kernel's emit path. The walker fix and the dispatcher fix have to land together; once they do, the `!ref` fallback in `ResourceContext.resolveChildren` becomes dead code and can be removed (preserving the polyglot contract where every controller — Node or otherwise — sees only `{kind, name}` at ref slots).

  The legacy ref shapes (bare-name strings and `{kind, name}` objects) are unchanged and continue to work. This change is non-breaking — no existing manifests, schemas, or controllers need to migrate yet. A subsequent migration sweep will convert every module schema to `$ref: "telo://manifest#/$defs/ResourceRef"` and rewrite example/test manifests to `!ref`, after which the legacy paths can be removed.

- f3e5fbc: Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

  - **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
  - **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
  - **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.

- f3e5fbc: Three further warm-startup optimisations that, layered on top of the manifest-cache write-through, pull warm `telo run hello-world` from ~300 ms to ~215 ms.

  - **#1 — analyzer / kernel**: the kernel exposes a `BuiltinControllerContext.isImportValidatedAtLoad(url)` (kernel-internal, not on the public `ResourceContext`) so built-in controllers can ask whether the kernel's load-time analyzer pass already covered a URL. The `Telo.Import` controller now skips its per-import `new StaticAnalyzer().analyze(...)` when the import was part of the entry graph (the common case — every transitive import is). Adds `Loader.canonicalize(url)` and `Kernel.isImportValidatedAtLoad(url)` as the underlying primitives.
  - **#9 — analyzer / kernel**: hash-keyed analysis cache. `analyzer.analyze` accepts a new `skipValidation` option that runs only the state-mutating setup (identity / alias / definition registration + `normalizeInlineResources`) and elides every diagnostic-producing pass. The kernel stamps `<entry-dir>/.telo/manifests/.validated.json` with a content signature of the full LoadedGraph (manifest bytes + `@telorun/kernel` + `@telorun/analyzer` versions) after each successful validation; the next load with the same signature skips the per-resource validation walk (≈25 ms warm on hello-world).
  - **#4 — kernel**: persistent AJV validator cache. `SchemaValidator` writes compiled validators as standalone CJS modules under `<entry-dir>/.telo/manifests/__validators/<schema-hash>.cjs` and reloads them through a `createRequire` anchored at the kernel package so embedded `require("ajv/...")` / `require("ajv-formats/...")` calls keep resolving. Drops total `ajv.compile` calls during a warm hello-world from 9 to 1 (the remaining one is now lazy — only paid when a `Telo.Definition` document is actually validated). Also removes the unused `validateRuntimeResource` validator (10–15 ms of dead module-init compile time).

- 39aef08: `Telo.Application` accepts `variables:` / `secrets:` with per-field `env:` mapping; values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope before any controller or import initialises. `type:` supports `string | integer | number | boolean | object | array` — object and array values are JSON-decoded from a single env var. Coercion / schema / missing-required failures aggregate into one `ERR_MANIFEST_VALIDATION_FAILED` at load.

  `Telo.Library` variables / secrets remain pure JSON Schema property maps. An `env:` key on a Library entry is now rejected at load time with a `LIBRARY_ENV_KEY_REJECTED` diagnostic that explains importers must supply the value.

  The Telo editor's Deployment tab now renders the Application's declared environment contract above the free-form env vars list, so authors see exactly which env vars the manifest binds. The tab still drives the existing Run feature's env wiring — no manifest mutation.

  `Config.Env` is deprecated in favour of the new Application-level shape. The kind continues to work; the controller logs a deprecation notice at init and the docs page is marked deprecated. Migrating consumers is recommended but not forced.

  Diagnostics that target a missing child property now squiggle just the parent key identifier instead of the whole value block. `buildPositionIndex` additionally records map keys under the `@key:<path>` namespace, and the IDE range resolver prefers that key range when the leaf path isn't indexed.

- 849f57a: Add `provide:` template target to `Telo.Definition` and an optional typed `provide()` member to `Telo.Provider`.

  Manifest authors can now declare a `Telo.Provider` in pure YAML without a TypeScript controller:

  ```yaml
  kind: Telo.Definition
  metadata: { name: TokenProvider }
  capability: Telo.Provider
  extends: Auth.SessionProvider
  resources:
    - kind: Http.Request
      metadata: { name: "${{ self.name }}-read" }
      inputs: { url: "https://vault/v1/secret/${{ self.vaultPath }}" }
  provide:
    kind: Http.Request
    name: "${{ self.name }}-read"
  result:
    sessionId: "${{ result.body.data.session_id }}"
  ```

  The synthesized `provide()` spawns the dispatch target as an ephemeral, calls its `invoke()` with the top-level `inputs:` map (CEL-expanded against `{ self, variables, secrets, resources.* }`), optionally reshapes the result via the top-level `result:` map (CEL-expanded against `{ self, result }` where `result` is typed from the target's `outputType`), and tears the ephemeral down. No caching: each call re-runs the target.

  `Telo.Provider`'s `ProviderInstance` gains an optional `provide?(): Promise<T>` member, where `T` is JSON-schema-typed via the abstract's `outputType` when the definition `extends` one. Existing handle-shaped Providers (Sql.Connection, Http.Client, etc.) continue to work unchanged — they don't implement `provide()` and remain outside the typed value-flow contract.

  Analyzer coherence validators reject:

  - `PROVIDE_ON_NON_PROVIDER` — `provide:` on a non-`Telo.Provider` definition.
  - `PROVIDE_DISPATCHER_CONFLICT` — `provide:` co-existing with `invoke:` or `run:`.
  - `PROVIDE_TARGET_UNKNOWN` — `provide.name` not matching any `resources:` entry.
  - `PROVIDE_TARGET_NOT_INVOCABLE` — `provide:` target resolving to a non-`Telo.Invocable` kind.
  - `PROVIDER_MISSING_IMPLEMENTATION` — `Telo.Provider` definition lacking both `controllers:` and `provide:`.

  Top-level `result:` is a general post-call mapping: it works as a sibling of either `provide:` or `invoke:`. The kernel applies it after the inner invoke returns; the analyzer types `result` inside CEL from the dispatch target's `outputType` (looked up via `provide.kind` first, falling back to `invoke.kind`) and validates the produced mapping against the abstract's `outputType` when the definition `extends` one. `x-telo-context-from-ref-kind` now accepts either a single path or an array of fallback paths.

### Patch Changes

- 77c1c86: Fix diagnostic line attribution in multi-doc YAML files that start with `---`. The leading `---` is the start marker for doc 0, not a separator before an empty doc; treating it as a separator drifted every subsequent doc's `sourceLine` by one entry, so diagnostics for doc N landed inside doc N-1's text (e.g. an `Http.Server` error squiggling on a preceding `Telo.Import` block).
- Updated dependencies [7889023]

  - @telorun/templating@0.3.0

- e411584: Reference and schema diagnostics now resolve to the correct line in the editor. Two bugs were stacking to make `x-telo-ref` errors land on the resource's top line — or, for inline-extracted children, on the wrong document entirely:

  - `validateReferences` and the schema-from validator stored the field-map path (with `[]` wildcards, e.g. `routes[].handler`) in `data.path`, but `buildPositionIndex` keys on concrete indices (`routes[0].handler`). The lookup always missed and the diagnostic fell back to the resource's first line. `resolveFieldValues` now also yields the concrete dotted path for each value (new `resolveFieldEntries` API; old function kept as a value-only wrapper), and every ref / schema-from diagnostic emits that concrete path.
  - Synthetic manifests produced by `normalizeInlineResources` (e.g. an inline `{kind: JS.Script, code: ...}` in `routes[0].handler`) had no top-level YAML doc, so `findPositions(graph, …)` could not locate them and routed every diagnostic on a synthetic to the first manifest of the file. `normalizeInlineResources` now stamps each extracted manifest with `metadata.xTeloOrigin = { parentKind, parentName, pathFromParent }`, and a final analyzer pass (`rewriteSyntheticOrigins`) rewrites diagnostics on synthetics by walking the origin chain to the real root and concatenating the parent-relative paths. The IDE's existing lookup-by-resource flow then resolves to the parent doc, and the position-index lookup hits the concrete nested path.

  Telo.Definition template bodies (`resources` / `invoke` / `run` / `provide` on a Definition) are still not walked — that case has a separate CEL-context concern (synthetics extracted from a Definition need the parent's `self` / `inputs` typings during CEL validation) and will land in a follow-up.

- e411584: Completion now works inside `x-telo-ref` slots. Two missing pieces of context made VS Code silent (and the editor app, by extension) when the cursor was inside a slot like `routes[].handler` or `steps[].invoke`:

  - **`navigateSchema` didn't peel `anyOf` / `oneOf`.** Library schemas place the slot's object form inside a combinator branch (`anyOf: [{type: string}, {type: object, properties: {kind, name, inputs}}]`), so the navigated leaf had no `.properties` of its own and `propKeyCompletions` returned nothing. The walker now traverses combinator branches at every step and, at the leaf, unions every branch's `properties` into a synthetic node (intersecting `required`). `lookupRefConstraint` is exported alongside so callers can still see `x-telo-ref` declared next to the combinator.
  - **`detectContext` didn't recognize indented `kind:` lines.** The regex was anchored to column 0 and would only fire for top-level `kind:`. A nested `kind:` inside an inline-resource shape fell through to prop-key completion which suggested it as a key, not a value. Indented `kind:` now returns a `{type: "kind", docKind, yamlPath}` context, `buildYamlPath` descends transparently through `- ` list-item markers so the array's parent key joins the path, and `buildCompletions` calls a new `AnalysisRegistry.userFacingKindsForRef(refString)` to filter the kind list to the definitions that satisfy the slot's `x-telo-ref` (abstract: implementations; concrete: itself). Falls back to the unfiltered list when the slot has no constraint or the ref can't be resolved.
  - **Completion went silent when the cursor sat on an existing property name.** `|version:`, `ver|sion:`, and `version|:` all returned nothing because `isKeyLine` only matched lines that were a bare key (no value), and `extractKeysAtIndent` was self-filtering — `version` ended up in `existingKeys` and got removed from suggestions. The key-line check now fires whenever the cursor is on the key portion of `key: value` (cursor column ≤ colon position), and the existing-keys extractors take a `skipLine` parameter so the cursor's own line is excluded from the "already present" set. Sibling keys on other lines stay filtered as before.
  - **`kind:` line treated as a value slot even when the cursor was on the key.** The detection ignored cursor position and returned `{type: "kind"}` for any cursor column on a `kind: …` line, so `|kind: Sql.Query` and `ki|nd: Sql.Query` both showed resource-kind values instead of suggesting `kind` itself. The check now respects the colon: cursor at or before the `:` falls through to prop-key completion (key-editing); cursor past `: ` triggers value completion. Mirrors the rule used for the rest of the key-line logic.
  - **`kind` / `metadata` were filtered out of root-level prop-key completion unconditionally.** A blanket `if (yamlPath.length === 0 && (prop === "kind" || prop === "metadata")) continue;` hid these even when the cursor was on the very line that owned them — so cursoring on `|metadata:` gave no suggestion to autocomplete the key. The filter is now removed; deduplication is handled by `existingKeys` (which the previous bullet's `skipLine` already excludes the cursor's own line from), so fresh docs still see `kind` / `metadata` on a blank line and existing docs don't see duplicates of keys that live elsewhere.
  - **`buildYamlPath` lost descent through `- key:` list-item headers.** When the cursor sat inside e.g. `routes[].request.method`, the walker stopped at `routes:` and missed `request`, so completion drew from the array-item schema instead of `request`'s. The list-item branch now inspects the post-dash key: when the cursor's current target indent is greater than the key's column, the descent goes through that key (`request` joins the path); when the indents match, the key is a sibling of the cursor's branch (e.g. `handler:` peer of `request:`) and is correctly skipped. `inferIndentForBlankLine` also defers to `character` when the line has whitespace — VS Code parks the cursor at the end of the indent on Enter, so the cursor's column already tells us where the user means to type.

  `packages/ide-support` gained a vitest suite (`tests/completion-anyOf.test.ts`, `tests/completion-build.test.ts`) covering every fix end-to-end.

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0
  - @telorun/templating@0.3.0

## 0.11.0

### Minor Changes

- 0f80fc5: `Bench.Suite.scenarios[*]` and `Http.Server.notFoundHandler` follow the canonical sibling shape: `invoke:` describes the dispatch target only; `inputs:` carries the call-time arguments as a sibling. The previously-accepted nested `invoke.inputs` form is gone — the benchmark runtime now reads `scenario.inputs` and the http-server runtime now reads `notFoundHandler.inputs`. Five benchmark manifests, one example, and `apps/registry/telo.yaml` migrated to the sibling form.

  Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` / top-level `inputs:` / top-level `result:` fields, catching typos at load time instead of first invocation.

  Aligns Telo.Definition's template-body shape with how Run.Sequence steps factor dispatch from data: `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (provide-only post-call mapping) live as top-level siblings on the definition. The previous nested `invoke.inputs` shape is gone — the kernel template controller now reads `definition.inputs`, and `modules/sql-repository/Read` migrates to the sibling form.

  Inside top-level `result:`, the `result` CEL variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is also AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared. Mismatches surface as a new `TEMPLATE_TARGET_MISMATCH` diagnostic.

  Adds two reusable context-annotation forms used by the `Telo.Definition` builtin schema and available to any module that needs the same capabilities:

  - `x-telo-context-from-root: "<path>"` — root-anchored navigation (replace semantics), used to type variables sourced from a top-level field regardless of where the CEL appears.
  - `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema.

  Schema-extracted contexts are now sorted by scope specificity (longest first) so the first-match-wins resolver picks the most-specific context. No existing module relied on the previous ordering (no overlapping scopes), so this change is observably backward-compatible.

## 0.10.1

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/templating@0.2.3

## 0.10.0

### Minor Changes

- 65647e0: Phase 2 inline normalization and Phase 5 reference injection now follow `x-telo-schema-from` indirections, so refs nested inside a sub-schema (e.g. an encoder at `Server.notFoundHandler.returns[].content[mime].encoder`, declared by anchoring at `HttpDispatch.Outcomes/$defs/Returns`) are extracted and injected the same way as locally-declared refs. Previously such slots were silently skipped — inline `{kind: Octet.Encoder}` survived Phase 2 untouched and Phase 5 produced "Encoder ref … is not a live Invocable" 500s at request time. Only static absolute schema-from paths with a dotted alias anchor (the kind owner's import scope) are expanded; relative anchors keep their existing per-resource validation path and remain unchanged.

  - `@telorun/analyzer`: `DefinitionRegistry.expandedFieldMapForResource` resolves schema-from anchors through `aliasesByModule` and merges nested ref/scope entries into the iterated field map; `AnalysisRegistry.iterateFieldEntries` and `normalizeInlineResources` consume the expanded map. `normalizeInlineResources` now accepts an optional `aliasesByModule` parameter.
  - Releases also fix `scripts/publish-packages.mjs`: a single failing manifest push no longer aborts the loop, so every changed module in a release gets a push attempt before the script exits non-zero.

## 0.9.0

### Minor Changes

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

- 50ae578: Unify diagnostic position resolution so the Telo Editor and the VS Code extension report the same line/column for every analyzer diagnostic.

  Previously, the editor's in-memory YAML pipeline projected manifests via `doc.toJSON()` and never stamped `positionIndex` / `sourceLine` onto `metadata`. With those fallbacks missing, `normalizeDiagnostic` collapsed every analyzer diagnostic to `(0,0)` — every squiggle landed on line 1 of the file, regardless of the actual problem location. The VS Code extension didn't have this issue because it goes through `Loader.loadModuleForFile`, which stamps the metadata as a side effect of reading from disk.

  - `@telorun/analyzer`: extract the position-stamping helpers (`buildPositionIndex`, `documentLineOffsets`, `buildLineOffsets`, plus `buildDocumentPositions` / `attachPositionIndex` composers) out of the private bowels of `manifest-loader.ts` and export them. `Loader` itself now consumes the same exported helpers, so editor frontends that parse YAML in-memory can produce identically-stamped manifests without duplicating the offset / AST-walk logic.
  - `@telorun/ide-support`: `NormalizedDiagnostic` now carries the original `data` field through normalization. Editor UIs (popovers, "at &lt;path&gt;" hints, future CodeAction wiring) can read the analyzer's stamps from a single normalized shape instead of holding a raw `AnalysisDiagnostic` alongside.

### Patch Changes

- 07c881a: Fix: schema-from anchors that reference an imported library's alias now resolve correctly when validation runs through `StaticAnalyzer.prepare()` (the kernel-boot path), not just through `analyze()`.

  `AnalysisRegistry` now stores `aliasesByModule` (per-library alias scopes for `Telo.Import`s forwarded from inside imported libraries) alongside its existing `aliases` field, and exposes it via `_context()`. `StaticAnalyzer.analyze()` writes into the registry's map instead of a local one, so populations persist across the `analyze() → prepare()` sequence the kernel runs at boot. `prepare()`'s `validateReferences` call now sees both alias scopes and can resolve aliased `x-telo-schema-from` anchors like `"HttpDispatch.Outcomes/$defs/Returns"` (where `HttpDispatch` is an alias declared inside http-server's library, not the consumer's manifest).

  Before this fix, the schema-from anchor on `Server.notFoundHandler.returns` / `.catches` (added in the http-dispatch carrier POC) silently worked only when validating http-server's own `telo.yaml`. The same fields in user manifests that imported http-server would have failed with `SCHEMA_FROM_MISSING_PATH: cannot resolve alias 'HttpDispatch.Outcomes'` — but no test exercised that path because no test fixture used `notFoundHandler` with a carrier anchor. The bug surfaced when migrating `Api.routes[].request` to the same anchor pattern.

  No behavioural change for manifests that did not use forwarded-library schema-from anchors.

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.8.1

### Patch Changes

- 30bcfef: Catch references to nonexistent step results in Run.Sequence-shaped manifests at static-analysis time.

  Two analyzer gaps let a broken CEL chain like `steps.parseManifest.result.docs[?0].?kind` slip past `telo check` and only fail at runtime with `No such key: parseManifest`:

  - `@telorun/analyzer`: `buildStepContextSchema` registered every named step in the steps map, including control-flow wrappers (`try`, `if`, `while`, `switch`, `throw`) that never produce a result. With a permissive `result: { additionalProperties: true }` placeholder under each wrapper, the chain validator treated every typo or stale reference as valid. Now only steps that carry an `invoke` field register a result-producer entry; wrappers are still descended into via `x-telo-topology-role: branch`, so their inner invokes are unaffected.
  - `@telorun/templating`: `extractAccessChains` only descended into `node.args` when it was an array. cel-js represents unary operators (`!_`, `-_`) with a single `ASTNode` directly in `args`, so any chain inside `!(...)` or `-(...)` was dropped from validation. The walker now also descends when `args` is a single `ASTNode`.

  Both fixes are needed for the typical "negated optional-access chain in a try-wrapped step" pattern (e.g. an `if: "${{ !(steps.<wrapper>.result.docs[?0].?kind ...) }}"` predicate).

- Updated dependencies [30bcfef]
  - @telorun/templating@0.2.1

## 0.8.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.

### Patch Changes

- 88e5cb4: Schema validation now substitutes `!cel` / `!literal` tagged sentinels with type-appropriate placeholders, the same way it already does for untagged `${{ }}` strings. Previously a tagged scalar against a typed field (e.g. `instructions: !literal "..."` on `type: string`) emitted a spurious `SCHEMA_VIOLATION` because the parsed sentinel object didn't match the declared type.
- Updated dependencies [88e5cb4]
  - @telorun/templating@0.2.0

## 0.7.0

### Minor Changes

- 019c62a: Two additions to the shared CEL `Environment` used by the kernel runtime,
  the loader, and the static analyzer:

  **`json(value)` stdlib function.** Companion to the existing `sha256(string)`
  handler. Accepts any `dyn` value (primitives, lists, maps, nested structures
  sourced from step results) and returns a single-line JSON string. cel-js
  parses `int` / `uint` literals as BigInt; the handler coerces them with
  `Number(v)` unconditionally — values inside JS's safe range (±2^53)
  round-trip cleanly, larger values lose precision. Telo manifests never carry

  > 2^53 integer values in practice, so the simpler always-coerce contract
  > beats a value-dependent string fallback. Top-level `undefined` / function /
  > symbol values (which `JSON.stringify` would otherwise return as `undefined`,
  > violating the `json(dyn): string` signature) are coerced to `"null"`.

  The first consumer is the registry MCP server, whose tool result blocks
  need to package structured handler output into a single MCP `text` content
  slot — e.g. `text: "${{ json(steps.search.result) }}"`. The function is
  generally useful anywhere CEL needs to emit structured payloads as strings
  (logging, hashing, transmission, debug output).

  **`enableOptionalTypes: true` on the cel-js Environment.** Activates CEL's
  optional-types syntax in every site that goes through the shared environment
  (precompiled `${{ }}` template blocks). Available in any manifest from now
  on:

  - `value.?field` — optional field access; returns an `optional<T>` if the
    intermediate is missing instead of throwing.
  - `list[?index]` — optional indexing; same semantics for arrays.
  - `optional.orValue(default)` — unwrap with a fallback.
  - `optional.hasValue()` / `optional.value()` — explicit checks.

  This is a parser-level addition; the only existing-manifest hazard is using
  `optional` as a variable name (now reserved). The first consumer is the
  registry's `PublishHandler`, which uses
  `steps.parseManifest.result.docs[?0].?metadata.?description.orValue(null)`
  to safely extract the manifest's description across array indexing — a
  chain `has()` cannot express because cel-js's `has()` macro rejects array
  indexing in the path.

## 0.6.1

### Patch Changes

- 40ae3ea: Recurse into nested step arrays via `x-telo-topology-role` annotations (`branch` / `branch-list` / `case-map`) when building the `steps.<name>.result` CEL context for kinds that opt into `x-telo-step-context`. Previously the analyzer hardcoded a fixed set of `Run.Sequence` field names (`then` / `else` / `do` / `catch` / `finally` / `try` / `default` / `cases`) and never descended into `elseif` branches at all — so step names defined inside `elseif` were invisible to later `${{ steps.X }}` references, producing spurious `CEL_UNKNOWN_FIELD` diagnostics. The recursion is now schema-driven: `elseif` is covered, and any future composer that tags its branch fields with the same roles works without analyzer changes.
- 0335074: Surface a clear error when a `Telo.Import` target does not resolve to a `Telo.Library`. Previously the loader silently dropped the import when the fetched manifest contained no library doc, which produced misleading downstream `UNDEFINED_KIND` diagnostics on every kind the import was supposed to provide. Now the loader throws with the resolved URL and the kinds it actually found, so the failure points at the real cause. The built-in `RegistrySource` additionally detects S3/R2-style XML error bodies served with a `200` status and surfaces the upstream code/message rather than letting the body parse as YAML.

## 0.6.0

### Minor Changes

- b62e535: Streaming-Invocable convention, format-codec packages, and `Http.Api` `content:` map rewrite.

  **Breaking** (`@telorun/http-server`, `@telorun/ai`):

  - `Http.Api.routes[].returns[]` and `routes[].catches[]` (and the equivalent `Http.Server.notFoundHandler` lists) drop top-level `body` / `schema` in favour of a per-MIME `content:` map. Buffer-mode entries use `content[<mime>].body` / `content[<mime>].schema`; stream-mode entries use `content[<mime>].encoder` (ref to any `Codec.Encoder`). The map key is the canonical `Content-Type` — declaring `Content-Type` in `headers:` is rejected at load time. Multi-key `content:` maps are negotiated against the request's `Accept` header (RFC 9110 §12.5.1). Mismatch → `406 Not Acceptable`.
  - `mode: stream` is forbidden in `catches:` (catches fire pre-stream; no upstream iterable to feed an encoder).
  - Migration: every existing `returns: [..., body: ..., schema: ..., headers: { Content-Type: ... }]` rewrites mechanically to `returns: [..., content: { <mime>: { body, schema } }]`. In-tree manifests (`apps/registry`, `examples/*`, `tests/*`, `benchmarks/*`) migrated.
  - `Ai.TextStream`: `format` field removed; controller no longer encodes the wire — it returns `{ output: Stream<StreamPart> }`. Pair with a format-codec encoder (`Ndjson.Encoder`, `Sse.Encoder`, `PlainText.Encoder`) for HTTP responses or other byte transports. `text-stream-drain-controller.ts` removed (replaced by inline source → encoder → decoder steps).
  - `StreamPart.error` shape changed from native `Error` to `{ message, code?, data? }` so generic encoders can JSON-serialize error frames without bespoke translation.

  **New** (`@telorun/codec`, `@telorun/plain-text-codec`, `@telorun/ndjson-codec`, `@telorun/sse-codec`, `@telorun/octet-codec`):

  - `@telorun/codec` ships the `Encoder` and `Decoder` abstracts (no controllers — pure contracts).
  - Format-codec packages each carry one or both directions: `PlainText.Encoder/.Decoder` (UTF-8 collect + emit), `Ndjson.Encoder` (one JSON record per line), `Sse.Encoder` (Server-Sent Events frames), `Octet.Encoder/.Decoder` (raw bytes pass-through and collect).
  - All encoders implement `invoke({input}): Promise<{output: Stream<Uint8Array>}>` per the streaming-Invocable convention.

  **New** (`@telorun/sdk`):

  - `Stream<T>` class wrapping `AsyncIterable<T>`. Producers wrap their iterables in `new Stream(...)` so the value's constructor is recognized by CEL's runtime type-checker (which rejects unrecognized constructors like `AsyncGenerator` and Node `Readable`). The analyzer registers `Stream` as a CEL object type.

  **Annotation** (`@telorun/kernel`, `@telorun/analyzer`):

  - `x-telo-stream: true` schema annotation on input/output properties marks them as carrying a `Stream<T>`. CEL passes the value through by reference; analyzer's chain validator rejects `.field` / `[index]` access past a stream-marked property. Convention: streaming Invocables put the stream on `input` (inputs) and `output` (result).
  - `Self.<Abstract>` magic alias auto-registered for every Telo.Library/Application — lets concrete kinds in the same library use `extends: Self.<Abstract>` without a self-import that would loop the loader.
  - Analyzer's `buildReferenceFieldMap`, `resolveFieldValues`, `extractInlinesAtPath`, and `injectAtPath` (Phase 5) now recurse into `additionalProperties` via a `{}` path-segment marker. Required for refs nested inside open-keyed maps like `content[<mime>].encoder`.
  - `isInlineResource` widened: bare-kind refs (`{kind: X}` with no `name` and no extra config) are now treated as inline-singleton definitions and Phase 2 extracts them as fresh stateless resources. Previously `{kind: X}` raised `INVALID_REFERENCE` (treated as a malformed named ref). This matches the runtime-side `resolveChildren` semantics already documented for `Run.Throw`-style stateless inlines, and lets `encoder: {kind: Ndjson.Encoder}` work without boilerplate. Manifests that had `{kind: X}` with the (broken) intent of resolving to an existing named resource will now silently extract a fresh resource — extremely unlikely in practice (those refs were already failing analysis), but worth flagging for downstream consumers.

  **Behaviour changes worth flagging** (`@telorun/http-server`):

  - **Single-key `content:` maps now do `Accept` negotiation.** A route declaring only `content: { application/json: ... }` returns `406 Not Acceptable` for `Accept: image/png` — RFC 9110 §15.5.7 compliant. Pre-PR, the legacy top-level `body:` shape ignored `Accept` entirely. To preserve "always send" behaviour, declare `*/*` as an explicit key.
  - **Accept matching ignores media-type parameters** beyond the first `;`. `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }`. Q-values are still parsed for ranking; only the matching predicate ignores params. Authors needing parameter-level preference must declare distinct keys per parameter combo.
  - **Load-time validators reject misconfigured `content:` shapes.** `validateContentEntryShape` rejects `body+encoder` together (mutually exclusive), missing `encoder` under `mode: stream`, `body` under `mode: stream`, and `encoder` under `mode: buffer`. Previously some of these slipped through to runtime where they manifested as 500-on-negotiation.
  - **Mid-stream `pipeline()` failures emit `Http.Api.streamFailed` events.** Once `reply.hijack()` runs, mid-stream errors (encoder throws, broken pipe) bypass `catches:` by design (response is committed). They now emit a structured event with `path`, `method`, `status`, `mime`, and the error so operators can observe failures that would otherwise be silent.

  **Other** (`@telorun/http-client`, `@telorun/javascript`):

  - `HttpClient.Request` `mode: stream` returns `{ output: Stream<Uint8Array> }` instead of a bare `Readable` — fits the streaming-Invocable convention, pairs with `Octet.Encoder` for HTTP pass-through.
  - `JS.Script` injects `Stream` into every script's scope (via the second function argument, destructured at the top of the wrapper). User code can `new Stream(asyncGen)` directly.

  **Tests**:

  - New Layer 1 hermetic streaming-contract test (`modules/ai/tests/text-stream-streaming-contract.yaml`) — three sub-targets, byte-exact NDJSON / SSE / PlainText.
  - New Layer 2 live OpenAI streaming smoke (`modules/ai-openai/tests/openai-live-text-stream.yaml`) — env-gated; exercises `Ai.TextStream → Ndjson.Encoder → PlainText.Decoder` against the real provider.
  - New http-server integration test (`modules/http-server/tests/text-stream-via-http.yaml`) — exercises three single-format routes plus a four-format negotiated route with five Accept variants.

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.5.0

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

## 0.4.0

### Minor Changes

- f76dd0f: kernel/analyzer: library-declared Telo.Abstract + first-class `extends` + in-place invoke wrap.

  - Kernel: new runtime meta-controller for `kind: Telo.Abstract` so libraries can declare abstract contracts that importers resolve at runtime (not just in static analysis). Fixes the latent "No controller registered for kind 'Telo.Abstract'" failure when importing modules like `std/workflow` that declare an abstract.
  - Kernel: `_createInstance` now overrides `invoke` in-place on the controller's returned instance instead of wrapping it in a new object. The previous `{ ...instance, invoke }` shape (and a later prototype-preserving variant) split object identity: `init()` ran on the wrapper while the wrapper's `invoke` delegated back to the original instance, so any state `init` set on `this` was invisible at invocation time. Mutating in place keeps all lifecycle methods on the same object and incidentally preserves the prototype chain for class-based controllers.
  - Analyzer: `Telo.Definition` gains an `extends: "<Alias>.<Abstract>"` field (alias-form, resolved against the declaring file's `Telo.Import` declarations — same pattern as kind prefixes). This pins the target's module version through the import source. `DefinitionRegistry.extendedBy` is populated from both `extends` and `capability` (union-merged), so third-party modules using the legacy `capability: <UserAbstract>` overload keep working. A `CAPABILITY_SHADOWS_EXTENDS` warning prompts migration.
  - Analyzer: new `validateExtends` pass emits `EXTENDS_MALFORMED` / `EXTENDS_UNKNOWN_TARGET` / `EXTENDS_NON_ABSTRACT` / `CAPABILITY_SHADOWS_EXTENDS` diagnostics. The pass skips defs forwarded from imported libraries — those are validated in their own analysis context, where the source library's aliases are in scope.
  - Analyzer: Phase 1 registration loop now also registers `kind: Telo.Abstract` docs (previously only `Telo.Definition`), so cross-package `x-telo-ref` references to library-declared abstracts actually resolve.
  - Analyzer + kernel: the `Telo.Abstract` schema is now open (`additionalProperties: true`) — abstracts carry `schema` plus any forward-compatible fields (e.g. `inputType` / `outputType` from the typed-abstracts plan). `controllers` and `throws` remain forbidden on abstracts.
  - Loader: imported libraries' `Telo.Import` docs are now forwarded alongside their `Telo.Definition` / `Telo.Abstract` docs. Alias resolution remains the analyzer's responsibility — the loader just exposes the imports.
  - Analyzer: alias resolution is now per-scope. The consumer's aliases live in the main resolver; each imported library gets its own `AliasResolver` built from the `Telo.Import` docs forwarded under its `metadata.module`. Forwarded defs' `extends` and `capability` are normalized in their declaring library's scope, so `extendedBy` stays keyed by canonical kind even when a consumer imports the same dependency under a different alias name (or omits a transitive dependency it doesn't directly use).
  - SDK: `ResourceDefinition` type gains `extends?: string`.
  - Assert: `Assert.Manifest` supports `expect.warnings` alongside `expect.errors`.
  - Migration: `modules/workflow-temporal/telo.yaml` moves from `capability: Workflow.Backend` to canonical `capability: Telo.Provider, extends: Workflow.Backend`, and gains a self-referential `Telo.Import` (`name: Workflow, source: ../workflow`) so the alias on `extends` resolves against the library's own imports. No behavioural change for existing consumers.

### Patch Changes

- 80c3c03: Two follow-up fixes uncovered while building `@telorun/ai-openai` against the alias-form `extends` pattern from PR #37:

  - **Kernel:** `Telo.Import` controller now resolves relative `source` paths against the manifest's own stamped `metadata.source` instead of the parent module context's source. When a Telo.Library imports another library via a relative path, that path is written relative to the declaring library's file — not relative to whatever root manifest happens to load the chain. Without this fix, nested transitive imports would resolve against the wrong base directory at runtime (the analyzer was already correct).
  - **Analyzer:** `loadManifests` now forwards `Telo.Import` docs from imported libraries into the analysis manifest set, and re-stamps `resolvedModuleName` / `resolvedNamespace` on Telo.Import docs that re-encounter an already-loaded import URL through a different chain. Required so alias-form `extends` declarations inside imported libraries (e.g. `ai-openai/telo.yaml`'s `extends: Ai.Model`) resolve through the library's own `Telo.Import name: Ai`, even when the consumer doesn't import `Ai` directly.

  No behavioural change for existing modules — both fixes only affect cases that were already broken at runtime or that previously emitted spurious `EXTENDS_MALFORMED` diagnostics.

- fc4a562: Polyglot controller support — Rust controllers via N-API. See `modules/starlark/plans/polyglot-rust-poc.md` for the full design.

  **SDK additions (additive, non-breaking):**

  - `ControllerPolicy` type — resolved selection policy: an ordered list of PURL-type prefixes optionally containing a single wildcard sentinel `"*"`.
  - `ResourceContext.getControllerPolicy()` and `ModuleContext.getControllerPolicy()` / `setControllerPolicy()` — produced by `Telo.Import`, consumed by `Telo.Definition.init`.

  **Kernel:**

  - `controller-loader.ts` is now a scheme dispatcher that picks a per-PURL sub-loader: `controller-loaders/npm-loader.ts` (existing logic, extracted) and `controller-loaders/napi-loader.ts` (new). The dispatcher applies the resolved policy: candidates are filtered/ordered by PURL-type prefix and the wildcard tail, and env-missing failures (`ControllerEnvMissingError`) advance to the next candidate while user-code failures (`ERR_CONTROLLER_BUILD_FAILED`, `ERR_CONTROLLER_INVALID`) fail hard.
  - `NapiControllerLoader` (dev mode only): probes `rustc --version`, runs `cargo build --release --features napi` in `local_path`, locates the dylib via `cargo metadata`, copies to `<libname>.node`, loads via `createRequire`. Distribution mode (per-platform npm packages) is out of scope and reports env-missing.
  - `runtime-registry.ts` — new module: label-to-PURL mapping (`nodejs ↔ pkg:npm`, `rust ↔ pkg:cargo`), kernel-native label, and `normalizeRuntime(value)` that resolves the user-facing `runtime:` field (string or array) into a `ControllerPolicy`. Reserved tokens: `auto` (kernel-native + wildcard), `native` (kernel-native only), `any` (wildcard).
  - `Telo.Import` schema gains a `runtime` field (string or array of strings); `Telo.Import` controller normalizes and stamps the resolved policy on the spawned child `ModuleContext` only when `runtime:` is explicit.
  - `Telo.Definition.init` reads the policy via `ctx.getControllerPolicy()` and forwards it to `ControllerLoader.load`.
  - `ControllerRegistry` is now keyed by `(kind, runtimeFingerprint)`. Lookup falls through three tiers: exact fingerprint, then `"default"` (built-ins), then any registered entry for the kind (root-context resources that reference an imported kind). Two `Telo.Import`s of the same library with divergent runtime selections each get their own cached controller instance.

  **Analyzer:**

  - `Telo.Definition` for `Import` in `analyzer/nodejs/src/builtins.ts` accepts the `runtime` property so static analysis doesn't reject manifests using the new field.

  **Tests:**

  - `kernel/nodejs/tests/napi-echo/` — Rust crate fixture exercising the napi-rs build + `.node` load path.
  - `kernel/nodejs/tests/__fixtures__/napi-test/telo.yaml` — Telo.Library wrapper around napi-echo.
  - `kernel/nodejs/tests/napi-echo-loads.yaml` — proves the loader dispatches `pkg:cargo` correctly with default `auto` resolution.
  - `kernel/nodejs/tests/napi-echo-runtime-rust.yaml` — proves explicit `runtime: rust` selects the cargo PURL.

  Repo gains a workspace-level `Cargo.toml` listing all telorun Rust crates as members; the existing Tauri crate is unaffected.

  No user-facing change for manifests that don't use `runtime:` or `pkg:cargo` — the existing npm load path is preserved exactly.

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.3.0

### Minor Changes

- c97da42: Add `AnalysisRegistry.validUserFacingKinds()` and `AnalysisRegistry.suggestKind(badKind)` for editor hosts and diagnostic enrichment. The `UNDEFINED_KIND` diagnostic now appends a `Did you mean '…'?` hint when a close-by valid kind exists (Levenshtein over the alias-form kind list, case-sensitive) and stamps `data.suggestedKind` on the payload so editor hosts can wire CodeActions without re-running the search. The previous verbose `Known imports: … | kinds: …` suffix is removed; CLI users get the concrete suggestion instead.

### Patch Changes

- e35e2ee: Add `AnalysisRegistry.aliasesFor(moduleName)` (and the underlying `AliasResolver.aliasesFor`) so callers can convert a canonical kind key (e.g. `http-server.Server`) back into its user-facing import alias form (e.g. `Http.Server`). Used by the VS Code extension to stop suggesting invalid canonical kinds in `kind:` autocomplete.

## 0.2.1

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.2.0

### Minor Changes

- 353d7e5: feat: invocable errors — structured error channel end-to-end

  Invocables and runnables now have a first-class structured-error channel for domain failures (`InvokeError`), distinct from operational failures (plain `Error` / `RuntimeError`). Route handlers branch on named codes via `catches:`; sequences catch with `error.code` / `error.message` / `error.data` / `error.step` context.

  **SDK** (`@telorun/sdk`)

  - New `InvokeError` class + `isInvokeError` guard. Symbol-based discrimination (`Symbol.for("telo.InvokeError")`) is dual-realm-safe across pnpm hoist splits, registry modules, and future sandbox isolation.
  - `ResourceDefinition.throws`: declared-throw contract (`codes` map, `inherit: true`, `passthrough: true`).
  - `ResourceContext` / `EvaluationContext` gain `invokeResolved(kind, name, instance, inputs)` for callers that already hold a resolved instance.

  **Kernel** (`@telorun/kernel`)

  - Single emission point for invoke-level events: `Invoked` / `InvokeRejected` / `InvokeFailed` / `InvokeRejected.Undeclared`. All call paths (direct invoke, sequence scope path, HTTP route handler) route through the same wrapper.
  - `Telo.Definition.throws:` schema with per-capability restrictions (rule 8: only on Invocable / Runnable).
  - `resolveChildren` now auto-registers bare-kind inline refs when a resource name is supplied without an explicit name on the ref — lets stateless invocables like `Run.Throw` be used inline via `invoke: {kind: Run.Throw}`.

  **Analyzer** (`@telorun/analyzer`)

  - New dataflow resolver (`resolve-throws-union.ts`) for `inherit: true` / `passthrough: true` declarations. Walks `x-telo-step-context` arrays generically, applies `try`/`catch` subtraction, detects cycles, memoises per manifest.
  - New coverage validator (`validate-throws-coverage.ts`) — rules 1/2/4/7 for `catches:` lists. Coverage-proving CEL parser recognises `error.code == 'X'`, disjunctions, and `error.code in [...]`. Typed `error.data.<field>` access against per-code `data:` schemas, with intersection narrowing for disjunctive `when:` clauses.
  - New error codes: `UNDECLARED_THROW_CODE`, `UNCOVERED_THROW_CODE`, `UNBOUNDED_UNION_NEEDS_CATCHALL`, `CATCHALL_NOT_LAST`, `INHERIT_WITHOUT_STEP_CONTEXT`.

  **Run module** (`@telorun/run`)

  - `Run.Sequence` declares `throws: { inherit: true }`. Its effective union is resolved from step invocables at analysis time.
  - New `Run.Throw` invocable: takes `{code, message, data?}` and throws `InvokeError`. Declared with `throws: { passthrough: true }`; the analyzer resolves constant / `error.code`-inside-catch forms at each call site.
  - Sequence `try`/`catch` `error` context gains `data?: unknown` and now branches on `isInvokeError`.

  **HTTP server module** (`@telorun/http-server`) — **breaking**

  - Route-level `response:` is replaced by two channel lists: `returns:` (how to render handler results) and `catches:` (how to render `InvokeError` throws). Applies to both `Http.Api` routes and `Http.Server.notFoundHandler`.
  - Plain `Error` / `RuntimeError` throws skip `catches:` and fall through to Fastify's default 5xx renderer — operational vs. domain failures are now distinct on the wire.
  - `catches:` entries reject `mode: stream` at schema validation (structured errors always render as JSON).
  - Unmatched `returns:` dispatch now throws (surfaces via Fastify's error handler) instead of rendering a silent 500.
  - Every `response:` occurrence across the repo (apps, benchmarks, examples, tests) migrated to `returns:` — no manifest carries the old shape.

  See `sdk/nodejs/plans/invocable-errors.md` for the full design and rollout phasing.

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
  - @telorun/sdk@0.3.0

## 0.1.4

### Patch Changes

- Automated release.

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6
