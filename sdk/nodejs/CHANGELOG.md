# @telorun/sdk

## 0.67.0

### Minor Changes

- 8a9b494: Execution zones — a resource can declare that it must be reached through
  another resource's body (a transaction, a durable run, a batch), checked
  statically and enforced at dispatch. Normative contract in
  `kernel/specs/execution-zones.md`.

  **SDK.** `ZoneEntry` and `InvokeContext.zones` (the ambient zone stack, ordered
  outermost first); `deriveContext(base, overrides)`, the one way to build a
  context from another — a fresh object literal at a rebuild site drops every
  field it does not restate, which for `zones` would mean the stack surviving with
  tracing off and vanishing under `--debug`. `ResourceInstanceId` /
  `ResourceHandle` / `sameResource`: a kernel-minted per-instance identity that is
  a compared string rather than an object reference, so an entry crosses the ABI
  and no controller can read another module's instance off the stack. New
  `ResourceContext` members: `self`, `withZone(slot, fn)`, `requireZone(field)`,
  `findZone(field)`, `zonesFor(instance)`, `rootContext(opts?)`.

  **Kernel.** The handle is minted at `create()`, the single instance-production
  site, so an instance is never observable unbound; the instance → handle map has
  no reverse direction. `withZone` derives every field of the entry from the
  slot's `x-telo-provides-zone` annotation (resolved in the kind's _declaring_
  scope) — a controller names its own annotation site, never a kind, because it
  has no alias scope of its own. Clearing is the default state rather than a list
  of sites: `runDetached` already replaces the ambient context and a
  `Telo.Service`'s `run()` establishes none, so the only residue is a
  `trigger.inbound` registered from inside an invocation by a non-Service, which
  `rootContext()` names as a conformance obligation. `Http.Api`, `Mcp` tools and
  `Schedule.Cron` / `Interval` dispatch through it.

  **Analyzer.** `resolve-zone-requirements.ts`, a consumer of the call-graph
  service with no traversal of its own: requirements propagate along `call` edges,
  discharge at providing slots under the correlation rule (`extends`-aware), and
  fire at edges the runtime guarantees are cleared. `zone-slot.ts` is the single
  reader of both annotations, the `ref-slot.ts` precedent. Per-library export
  derivation runs as its own stage in `analyze()` over each library's full
  documents, cached in a host-lifetime cache the caller owns, keyed
  `(source identity, content signature)`. `validate-zone-slots.ts` is the strict half of the same accessor split
  `validate-ref-slots.ts` has, and is not optional: the two annotations fail in
  opposite directions (an unreadable requirement is silently unenforced, an
  unreadable provision invents failures), and a correlation key written as a bare
  field name would be read by the kernel's pointer walk but skipped by the
  checker — the two halves disagreeing about what a manifest means. New
  diagnostics: `ZONE_REQUIREMENT_UNSATISFIED` (error),
  `ZONE_REQUIREMENT_DEFERRED` (warning), `ZONE_EXPORT_UNSATISFIABLE` (error, at
  the exporting library only), `ZONE_PROVIDER_UNRESOLVED` (error),
  `ZONE_ANNOTATION_INVALID` (error).

  `ResourceContext.invoke`'s fourth parameter is now a typed
  `InvokeByNameOptions` bag (`{ ctx?, retry? }`) rather than `any`. It always
  carried `retry`; `ctx` joins it so an inbound registrant can seed the
  invocation context, which a positional parameter could not do safely —
  `ResourceContext` satisfies `InvokeStepContext` structurally, so a positional
  context would silently receive a step's retry options.

  Also fixes a latent bug in `buildCallGraph`: it resolved a resource's definition
  by raw kind, but a manifest carries the kind as authored (`Run.Sequence`) while
  the registry is keyed canonically (`run.Sequence`). Every alias-form kind — that
  is, every kind in a real manifest — missed silently, so step collection found no
  step list and a step's declared `use` never reached its edge, and a case map's
  selector found no schema `default`. Definitions now resolve in the scope of the
  module that declared the resource, matching `expandedFieldMapForResource`.

## 0.65.0

### Minor Changes

- 0bbbc3f: Named CEL bindings: a kind can declare a `bindings:` map whose names are in scope inside its own expressions.

  A kind opts in with `x-telo-bindings-from: "<field>"` on the `x-telo-context` node of every field that sees the names — the same annotation family as `x-telo-context-from` / `x-telo-context-element-from`, so no kind is named in analyzer code. `analyzer/nodejs/src/cel-bindings.ts` (exported as `resolveBindingOrder` / `findBindingSites` / `bindingContextProperties` / `bindingPathChain` / `schemaAtChain`) derives each binding's dependencies from the **root of every member-access chain its expression parses to** — never from a token scan, which would read `inputs.total` as depending on a sibling binding named `total` and reject a correct manifest — merges the names into the CEL context so they type-check, and reports `BINDING_CYCLE`, `BINDING_NAME_RESERVED` (any name `buildCelEnvironment` already binds at that site, kernel globals included, plus CEL's keywords, which can never be read as a reference) and `BINDING_FIELD_AMBIGUOUS` (a kind whose contexts point the annotation at two different fields).

  The kernel adds `ctx.bindScope(bindings, scope)` (`ControllerContext` / `EvaluationContext`), which extends a scope with accessor properties evaluated lazily and memoised per returned scope, so a binding nothing reads is never evaluated and one read repeatedly is computed once. `expandWith` merges such a scope by property descriptor rather than by value — copying the values would force every getter at merge time — so the returned scope must reach `expandValue` by identity. A name already in scope is skipped, the caller's own and the **ambient globals on the context** alike, which bounds a reserved name the static check did not foresee to a dead binding rather than a hijacked global. A binding that reaches itself raises `ERR_BINDING_CYCLE`.

  `x-telo-step-context` accepts an optional `value` field naming the step key that produces a result without dispatching. Such a step registers `steps.<name>.result` typed from its expression when that expression is a plain chain into something already typed (an earlier step's result, the kind's `inputType`), and permissively otherwise.

## 0.64.0

### Patch Changes

- 642b057: Fix the broken `structured-errors.md` link in the README. It was a relative path
  into `modules/run/docs/`, which resolves from a repo checkout but not from the
  published package or the docs site; it now points at the file on GitHub. README
  text only — no API change.

## 0.63.0

### Minor Changes

- e52a2bf: Add `ctx.runtime` — the host's own manifest machinery, exposed to controllers as a versioned SDK contract.

  `ctx.runtime.run(source, { env })` loads and starts a child manifest isolated from the caller's, resolving as soon as it has **started** with `{ stdout, stderr, exitCode, cancel }`: the two streams are `Stream<string>`, `exitCode` settles at completion, and `cancel()` stops the child and resolves once it has torn down. `ctx.runtime.check(source, { desugarImports })` runs the static-analysis pass and resolves to plain-data diagnostics plus a `loadError`.

  This exists so a module that needs either — `test` runs child manifests, `assert`'s `Manifest` kind analyzes one — stops importing `@telorun/kernel` / `@telorun/analyzer`. Importing them made kernel internals an unversioned ABI between a published artifact and whatever kernel loaded it, with a mismatch surfacing as a `TypeError` inside a controller. Every shape crossing the seam is serializable data or a `Stream`, so a kernel in any language can implement it, and isolation stays the kernel's choice (an in-process child kernel today, a subprocess later).

  Output is a stream rather than captured text because forwarding it live and retaining it to print on failure are both the caller's to choose, and a value produced at the end forecloses one of them. A stream does not by itself bound the host's memory — an unread one still accumulates — which is why `cancel()` is on the contract from the start rather than added later: it is both the way to stop an open-ended sub-manifest and the only real bound on its output.

  `RecordBuffer` — the bounded sink buffer of logging spec §10.3 — moves from `@telorun/kernel` to `@telorun/sdk`, beside the sink contract it composes with. A third-party sink is an ordinary module, so the piece it needs to honour `on_full` belongs on the module-author surface. The kernel re-exports it through `logging/log-sink.ts`, so its own sinks keep one spelling.

  The bundled-controller loader learns a `local_path` qualifier naming the TypeScript source `path=` was built from. When the declaring module carries **no artifact handle**, that source resolves on disk, and esbuild is available, the kernel builds it and imports the result — so a checkout runs with no build step, and editing a controller and re-running picks the edit up. The guard is the absence of an artifact rather than the shape of the base URI: a published module served from the on-disk manifest cache also has a local base, and its payload is still its layer.

  esbuild is checked at resolve time, so an install that skipped optional dependencies selects the prebuilt `path=` file instead of failing — the fallback belongs to this same PURL, and a candidate list could not supply it. A build _failure_ still surfaces; only a missing bundler falls back.

  Workspace TS libraries are inlined from their `source` export condition rather than their `dist/`, so building a controller does not depend on having built every library it inlines. Builds are cached under `<entry-dir>/.telo/controller-src/`, keyed on a signature over every input esbuild reported plus the build options, so a changed input is a different key rather than something to invalidate, and concurrent kernel processes write identical bytes to identical paths. Each build prunes the bundle it replaced. `telo run --watch` takes its watch set from that same input list, so an edit to a shared library one directory over restarts the run.

## 0.62.0

### Patch Changes

- 89ffea7: `telo run` points a manifest error at its line again, exactly as `telo check` does.

  A failure the kernel raises from static analysis converted the analyzer's diagnostics into `RuntimeDiagnostic`s while dropping their `data` — the file, the field path within it, and the owning resource. That is precisely what `findPositions` resolves a position from, so the CLI had nothing left to locate and printed the message alone. The same manifest checked with `telo check` still named the line, which made the two commands disagree about the same error.

  `RuntimeDiagnostic` gains `origin` (`DiagnosticOrigin`: `filePath`, field `path`, `resource`, and the diagnostic's own `range`), carried through verbatim so a renderer resolves `file:line:col` against the loaded graph rather than re-parsing a rendered message. `range` is what locates a failure with no field path to look up: a YAML parse error knows where the syntax broke but has no parsed tree to index.

  All four raise sites now go through one mapper (`static-analysis-diagnostics.ts`, sibling of the init-failure one): the pre-flight validation pass, Phase-3 reference resolution, YAML parse failures, and major-version conflicts. The last two used to flatten their diagnostics into a joined message string, so a syntax error and a bad `imports:` pin were the two failures `run` could not locate at all. Their `error.message` is unchanged for consumers that only read it. The loaded graph is now recorded before the parse-failure throw, since that is the failure that most needs to name a line.

  The position itself comes from `resolveRange`, the rule the VS Code extension already uses, rather than a third copy of it in the CLI: it walks parent paths when the exact field path is absent from the index (an `imports.<alias>` conflict lands on the import entry) and prefers an entry's key over its value. `resolveRange` now takes just the position half of a `DiagnosticContext`, so a caller holding only a located file does not have to invent an `AnalysisRegistry` to reuse it. A located static failure renders byte-identically under `run` and `check`. A diagnostic nothing can locate falls back to naming the resource rather than pointing at line 1 — a wrong line sends the reader somewhere the error is not. Runtime failures are unchanged: they are pinned to a resource, not to a spot in the YAML, and keep the kind + name form.

## 0.61.0

### Minor Changes

- bf324d2: Init failures now report the root cause instead of the whole cascade.

  When a resource fails to initialize, every resource downstream of it is unfinished too, and the multi-pass init loop used to report all of them flat — shadows first, since a resource that never got created was listed before one whose `init()` threw. A ten-resource chain printed one actionable line buried under nine repetitions of it.

  The kernel now classifies the failure set before raising `ERR_RESOURCE_INITIALIZATION_FAILED`. An entry is **derived** — collapsible — only when it carries `ERR_LOCAL_REF_PENDING` or `ERR_CROSS_MODULE_REF_PENDING`: a deferral, which says the resource never ran and so has nothing of its own to report. A reference edge into the failure set is **attribution only**, never grounds for collapsing: it proves an edge exists, not that this entry's failure came from it, so a resource that references a failed dependency _and_ fails its own validation keeps its line. `RuntimeDiagnostic` gains `derived` and `blockedBy` — the **root** of the chain, not the immediate blocker, since that is the name to go fix. If no entry survives as a root, the whole set is reported unclassified rather than collapsed to nothing.

  A nested context's failures — an import initializing its library's resources — are attached to the importing entry as `RuntimeDiagnostic.children` instead of being flattened into its message, so the child's own root causes stay distinguishable from the child's cascade and the CLI's error count reflects the real leaves rather than one `Telo.Import`. They are reported even when the wrapping entry is itself collapsed.

  `ModuleContext.getInstance` no longer reports a declared-but-uninitialized resource as `Resource 'X' not found in module context. Available resources: …`. That message listed the module's imports and read as a typo in a name that was in fact declared right there. While the context is still initializing the name now defers with `ERR_LOCAL_REF_PENDING`, exactly as Phase-5 injection does, so the loop retries and the failure is attributed to the dependency. **After** init — at dispatch, where no later pass is coming — it raises `ERR_RESOURCE_NOT_FOUND` saying the resource was declared but never initialized, rather than promising a retry that will never happen. An unknown name still gets the original message.

  The CLI prints root causes in full and collapses each blocked chain to a single line (`3 resources blocked by GrantDb: GrantStore, GuardedWork, OnceWork`); `--verbose` prints every entry.

- 2ee3598: A resource's declared invocation contract is now enforced.

  `inputType` / `outputType` were declared all over the standard library and read almost nowhere: a declared `default:` never applied, a misspelled input, a wrong-typed value and a misread result field were all silent, and three modules of roughly forty validated anything at all — each re-deciding it for itself. Underneath was a naming collision: `inputs:` meant _a schema_ on the six `modules/run` kinds and _values_ at every call site, so the run kinds' whole declared contract was inert.

  One invariant now holds everywhere: **`inputs`/`outputs` are values; `inputType`/`outputType` are schemas.** The normative rules are in `kernel/specs/invocation-contract.md`.

  **Resolution.** A shared resolver answers "what is this target's contract" for both halves — `telo check` and the runtime — layering the instance's own declaration over the kind's. A kind's contract resolves to the **nearest declaration along `extends`** and **replaces** rather than merges: config and observed state merge because construction and reported state are additive, but a call signature is not, and merging a child's required inputs into its parent's yields a union no caller can satisfy. This also fixes multi-level chains, which previously resolved to nothing.

  A child that inherits its controller and declares its own contract must bridge it — `inputType` needs `inputs:`, `outputType` needs `result:` — because the inherited controller understands only the shape it was written for. That combination used to pass `telo check`, run, exit 0 and do nothing at all.

  **Enforcement.** The kernel binds the resolved contract to the instance at creation, so **an instance is never observable unbound**. Enforcing at a handoff would have meant enforcing at every handoff — injection, explicit resolution, scope handles, template dispatch, the chokepoint — and the dominant path is injection: a consumer reads the reference off its own config and invokes it directly. `invoke` and `provide` are bound; `run()` is parameterless and void, so a resource whose contract requires inputs is rejected statically at a run site. Defaults are filled and both directions validated on every call, skipping `x-telo-stream` properties in **both** directions.

  Violations raise the ambient `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` as structured errors: catchable and typo-checked by name in a `catches:` block, never counted toward a kind's own declared union. `JS.Script`, `Starlark.Script` and `Run.Choice` drop their controller-side validators, and `Run.Choice`'s duplicate `ERR_OUTPUT_INVALID` declaration goes with them; `Image.Blank`, `Image.Overlay`, `Pdf.Rasterizer` and `Pdf.FormFields` drop the input guards that duplicated their own declared bounds, keeping only what a schema cannot express (a CSS colour's validity, a PDF's decodability, a page against the document's real page count).

  **`Telo.JsonSchema` is now a kernel built-in.** Declaring a data shape stopped being optional once any kind can carry a contract: writing `inputType:` should not require an import, and a library declaring its own contract should not import a module purely to describe itself — the same reasoning that keeps the mandatory log sinks in the kernel. `modules/type` is deprecated and unchanged, so `Type.JsonSchema` and every published manifest importing it keep working; the standard library, examples and templates now write the built-in and have dropped the import.

  The six `modules/run` kinds declare `inputType:` / `outputType:` in place of the `inputs:` property map, and each result slot is annotated `x-telo-value-schema-from: outputType` so every branch is checked statically — including ones no input selects. Consumers in this repo are migrated; a manifest pinning a published `run` by digest keeps the old spelling and keeps working.

  A `Telo.JsonSchema` rule's declared `code:` now reaches a `catch` block. Rules raise an error that carries a code but not the marker a catch matches on, so `error.code` was the generic plain-failure code and every `catches:` entry naming a rule code silently never matched — the behaviour `modules/type` has always documented was never the behaviour. Contract enforcement re-raises a rule failure structurally, preserving the author's code; only a structural schema failure becomes the ambient contract code.

  CEL evaluates an integer literal to a BigInt, which a JSON Schema validator does not accept as `integer` — so with enforcement on, every computed integer reaching a declared integer input would have been rejected for a reason no author could act on. Validation runs against a view where those read as ordinary numbers while the callee still receives the original values, and `Assert.Equals` no longer throws while rendering one.

  `Type.JsonSchema` is now a controller-less `extends: Telo.JsonSchema` alias rather than a second copy of the same controller, so the deprecated module has no implementation left to drift.

  **Statically**, `telo check` now validates each call site's `inputs:` against the target's contract, rejects an unmapped contract replacement, rejects a contract-requiring resource wired where the caller cannot supply arguments, and rejects a contract naming a type that is not declared in scope — which the runtime would otherwise only discover at the first dispatch through it, and which was invisible on a KIND because `Telo.Definition` is excluded from ordinary reference validation.

  Several latent bugs surfaced and are fixed. A wrapped `invoke` dropped every argument after the first, discarding the InvokeContext — so a detached body never observed cancellation and anything holding a resource across it was never released. `base:` validation demanded `metadata` and then rejected it, making any `base:` child of `JS.Script` impossible. The canonical type-schema id carried a URI authority (`telo://<module>/<Type>`), which no JSON Schema validator can resolve, so a `$ref`-based contract was uncompilable; the internal id is now authority-free, with the authored form unchanged.

  CEL placeholder substitution — how the checker avoids judging a value it cannot know — gained the same discipline: bounds it ignored (`exclusiveMinimum`, `minLength`, `minItems`, `required`, `allOf`-inherited constraints) are now honoured, a `oneOf` / `anyOf` is resolved to the single branch a value is written against so leaves underneath are typed rather than nulled, and a finding located AT a substituted path is dropped outright — a `pattern`-constrained string cannot be satisfied by any stand-in, so the checker declines to judge it. Structural findings survive, because they are located at the container.

### Patch Changes

- bf324d2: Fix `with:`-scoped resources in an imported library resolving their kinds against the **application's** import aliases.

  A `Run.Sequence` declared in a library can open a scope over kinds the library imports:

  ```yaml
  kind: Run.Sequence
  metadata: { name: Authorize }
  with:
    - kind: OAuth.RedirectListener # `OAuth` is an alias of THIS library
      metadata: { name: SignInListener }
  ```

  Phase-5 injection built the scope handle with `this.rootContext.createScopeHandle(...)` — the root context, unconditionally — so when the scope opened, its inline declarations resolved their kinds through the **root Application's** aliases. A library kind the app does not import failed with `Kind 'OAuth.RedirectListener': no module imported with alias 'OAuth'. Known aliases: Telo, SheetRows, Console, Run`, naming aliases from a file that never declared the resource. Only an app that happened to import the same modules under the same alias spellings worked.

  The scope handle now hangs off the context that OWNS the resource, matching the rule the rest of the kernel already follows ("a controller's `ctx` is scoped to the context that owns its resource"). `PreInitHook` gains a fourth `owner: EvaluationContext` argument carrying it; a scope nested inside a scoped resource forwards its opening scope's context rather than replacing it, so kinds keep resolving through the declaring module at any depth.

  `PreInitHook` is a kernel-internal contract — only the kernel installs one — so the added argument affects no module author.

## 0.60.0

### Minor Changes

- d23de89: Layered module artifacts: a published module is now one artifact of several layers instead of one tarball, and each layer is materialized only when something needs it.

  `telo.yaml` gets its own layer, so reading a manifest no longer downloads (and discards) the whole payload. The rest of `files:` is partitioned into one layer per bundled-controller selector — `format` plus optional `os`/`arch`/`libc` PURL qualifiers — plus an `assets` layer for what the new optional `assets:` list claims and a `common` layer for everything else. A Node kernel never fetches a `napi` layer, a `linux/amd64` host never fetches the `darwin/arm64` binary, and an app that imports a module for its API alone never fetches its frontend.

  This fixes a cold-start failure: bundled controllers used to resolve against an `oci://` base URI that was read as a filesystem path, because the payload was written to disk by a CLI hook running _after_ `kernel.load()`. The first run of any OCI-imported module with bundled controllers failed and the second succeeded. Controller layers now materialize at resolve time through a module-scoped `ModuleArtifact`, built during load where the pinned import ref and the verified manifest are both available — so verification stays anchored to the importer's `#sha256-` pin rather than to whatever is in the cache.

  `ctx.resolveModuleFile(relative)` is the new, URI-returning way to reach a file that ships with a module; it materializes the asset layer on first use. `Http.Static`, `mcp-client`, `assert`'s manifest loader and `Test.Suite` all use it, which also fixes a silent bug where a non-`file://` module resolved a relative root against the process working directory and served the wrong directory instead of failing.

  Also: `telo install --platform os/arch[/libc]` pre-fetches layers for a platform other than the build machine's, the layer index and selector grammar are specified normatively in `kernel/specs/module-artifact.md`, and the cross-process cache lock is shared between the npm loader and layer materialization instead of duplicated.

  Modules published before layers keep resolving: the manifest read path still accepts a single-blob artifact, which contains `telo.yaml` — so nothing that ships no payload needs anything done to it, and npm-backed modules are entirely unaffected. What such an artifact cannot supply is a layer index, so a module that _does_ ship a payload resolves its manifest and then fails at the controller with an actionable "republish" error. That is the six modules shipping `files:` — `oauth-client`, `scheduler`, `kv-store-memory`, `kv-store-redis`, `kv-store-sql`, `idempotency` — which must be republished, with consumers bumping to the new versions.

## 0.59.0

### Minor Changes

- 6376a66: Authenticate HTTP requests through the client, and resolve `!ref` inside a scope.

  `http-client` gains an `Http.Credential` abstract and a `credential` slot on
  `Http.Client`. A credential is consulted once per request and receives the request
  about to be sent — method, URL, headers, query — so a scheme that signs the request
  satisfies the same contract as one that adds a bearer token; what it returns is
  merged into the outgoing request. A `401` re-invokes it with `forceRefresh: true`
  and retries the call once, so every credential type inherits that behaviour rather
  than re-expressing it.

  The analyzer now types a route's `result` from the referenced handler's **kind**
  when the handler instance declares no `outputType`, the same layering
  `steps.<name>.result` already applies. A kind with one fixed output shape declares
  it once on its `Telo.Definition` and every `returns[].when` reading it is
  checked — previously such a handler fell back to an open schema and typos passed.

  `ctx.resolveRef` and `resolveInvocableDispatcher` both resolve a `!ref` that
  reaches a controller unrewritten inside an `x-telo-scope` array, and resolve a bare
  name scope-local first with the enclosing module as the fallback — matching
  `ScopeContext.getInstance` and the CEL `resources` layering, so a `with:`-scoped
  resource can reference a scoped sibling. `RefResolveContext` gains an optional
  `resolveLocalInstance` hook and `DispatchContext` an optional `ensureKindRef`, so
  neither resolution path is rescued while the other is not.

  The analyzer now applies that same precedence, in both the reference diagnostics
  and the Phase 2.5 sentinel rewrite. Previously it resolved a scoped bare name
  against the module-level resource while the runtime bound the scope-local one, so a
  shadowed name could type-check against a resource that never runs (or be reported
  as a kind mismatch naming one).

## 0.58.0

### Minor Changes

- 8353d0e: Resources can now declare and report **observed state** — what they learn while running, as opposed to what their author configured. A kind declares it with a `status:` JSON Schema block on its `Telo.Definition` (or `Telo.Abstract`, so a contract can mandate what its implementations report); a controller returns it under the reserved `status` key of `snapshot()`; the kernel publishes it at `resources.<name>.status.<field>`. The flat half — `resources.<name>.<field>` — keeps whatever meaning it has today and is neither typed nor changed. Documented in `kernel/docs/observed-state.md`.

  Configured state is pulled, observed state is pushed, and they never share a payload. `snapshot()` returns what the author configured and the kernel pulls it whenever it needs it — it is a function of the manifest, so re-deriving it is always correct. What a resource LEARNS goes the other way: `ResourceContext.setStatus(...)` reports it at the moment it is known, because nothing but the controller knows when that is. Splitting the two is what keeps each shape described in one place — a controller never rebuilds observed state inside `snapshot()` from a field it stashed only for that purpose, and with two channels there is no reserved key to collide over. Reporting replaces rather than merges, is AJV-checked against `status:` at the call that made it, and is an error before the resource has started (`ERR_OBSERVED_STATE_BEFORE_START`) — `init()` performs no I/O, so nothing is observed there. The reading is sticky: the kernel holds it until teardown, so a dispatch that reports nothing leaves a listener's bound address in place rather than blanking it. A kind that declares `status:` may not also return a flat `status` field (`ERR_OBSERVED_STATE_KEY_COLLISION`); one that declares none may use the name freely. A publication is now a reading rather than a live window: the published value is detached from what the controller returned (plain objects and arrays are rebuilt; class instances and functions pass through, since copying one would break it), so a controller that mutates the structure it reported cannot rewrite an already-published value. Previously the only mechanism for reporting anything learned at runtime was that aliasing accident — the kernel stored the props object by reference, and no schema check could catch a value rewritten behind CEL's back because the shape never changed.

  The segment exists only once the resource reports. Defaulting every field in `snapshot()` (`?? ""` / `?? 0`) is the prevailing controller style, and a pull-based design would publish that from `init()` as placeholders indistinguishable from a real report — the exact failure this replaces. With reporting pushed, there is nothing to withhold: no call, no segment.

  The `status:` chain is folded in the scope that DECLARED each definition, never the consumer's — an `extends` alias belongs to the file it was written in. The kernel stamps the folded block onto the definition at registration (in the defining module context, beside the existing `effectiveAuthorSchema` stamping); the analyzer re-scopes per declaring module. Without that, an abstract's `status:` would vanish for any consumer importing only the implementation — the sanctioned "one import instead of two" — and the reserved-key check, which keys off exactly that, would then reject a correct manifest. Stamping also makes the folded schema a stable object, so the publication path's AJV validator cache hits instead of recompiling on every snapshot.

  Reads are checked statically. `OBSERVED_STATE_IN_STARTUP_FIELD` rejects any path through `.status` in a field that resolves at startup (`x-telo-eval: compile`, or implied by `Telo.Provider`) — a purely syntactic rule, so it covers kinds that declare nothing. `OBSERVED_STATE_NEVER_RUN` rejects a read of a resource nothing can start: reachability is computed from every slot that can reach `run()` — a `targets:` entry and a step's `invoke:`, both keyed on the declared `Telo.Runnable` / `Telo.Service` contract rather than on any field name or kind. Fields under `.status` are type-checked — including cross-module, where an import's exported instances are indexed under `resources.<Alias>.<name>` so a typo fails exactly where a local one does — so a typo is `CEL_UNKNOWN_FIELD` instead of resolving to nothing; the `resources` root and every resource node stay permissive, so no read that validates today can begin to fail. `required:` inside `status:` is `OBSERVED_STATE_REQUIRED_FORBIDDEN`, a dedicated diagnostic naming the rule and the fix rather than an AJV `not:` that could only say "must NOT be valid" — every declared field is mandatory once the resource has run, and a sometimes-absent one is declared with a nullable type, which `CEL_NULLABLE_ACCESS` already guards.

  What genuine ordering leaves is three runtime errors rather than one hedge, because each needs a different action and only the kernel can tell them apart: a resource that has not started names the `targets:` to fix; one that started but whose `run()` has not returned raced a service still coming up; and one whose `run()` returned while a declared field is still missing is a defect in the producing module, which the message names. That last case is unreachable for a long-lived Service, whose `run()` never returns — so a slow bind is never blamed on someone else's code. None yields an empty value or a bare `No such key`.

  `with:`-scoped resources now publish like any other. Each `ScopeHandle.run()` gets its own map of the scope's resources, layered at read time over the enclosing module's — read time, not scope entry, because `setResource` replaces the module's map wholesale on every publish, so a copy would go stale the moment an outer resource republished — with scope-local names winning — matching `ScopeContext.getInstance`'s resolution order, so CEL and `!ref` never disagree, and two concurrent runs of the same sequence never observe each other. `ScopeContext` gains `run(name)`, which dispatches a scope target through the kernel's chokepoint (traced, records that it started, publishes its snapshot) instead of calling `instance.run()` directly, and `resources`, the map itself. `Run.Sequence` uses both. Previously `resources.<scopedName>` resolved to nothing at all.

  Fix a controller's `ctx` targeting the wrong context for a `with:`-scoped resource. `ResourceContextImpl` resolved everything through the enclosing MODULE context, but a scoped resource is owned by the per-run scope child — so registering a manifest, resolving a sibling by name, expanding CEL, spawning a child context and dispatching all went to the wrong place. Registration was the visible one: an inline definition a scoped resource resolves during `init()` landed in the module's pending queue, which the module's init loop had already drained at boot, so the resource was never created and the dispatch failed with `ERR_RESOURCE_NOT_FOUND`. Those members now go through the owning context; `ctx.moduleContext` keeps its meaning and is reserved for what genuinely belongs to the module — imports, the controller policy, and the logging scope, all of which a scope child inherits rather than owns. By-NAME lookup (dispatch, `getResourcesByName`, kind resolution) resolves scope-local first and falls back to the enclosing module, the order `ScopeContext.getInstance` and the CEL `resources` layering already use — a scoped `Http.Server` whose `notFoundHandler` targets a module-level invocable still finds it. Registration deliberately does not fall back: a new manifest belongs to the context that owns the resource creating it.

## 0.56.0

### Minor Changes

- f3b044d: Remove `metadata.namespace` as a structural field. Five subsystems read it;
  each now uses something the module already has.

  `x-telo-ref` names its target as an **alias-qualified kind** — the same grammar
  `kind:` and `extends:` use: `KvStore.Store` for a module in this file's
  `imports:` map, `Self.Store` for a kind in this library, `Telo.Invocable` for a
  built-in. The analyzer canonicalizes each constraint in the _declaring_ module's
  scope before registration, so the definition registry answers ref queries with
  no module context and a constraint stays correct whatever alias a consumer
  picks. The legacy `"<namespace>/<module>#<Kind>"` identity form still resolves
  for already-published module versions and now warns as
  `X_TELO_REF_LEGACY_IDENTITY`; `metadata.namespace` feeds nothing else.

  A constraint whose prefix names no alias is now `X_TELO_REF_UNRESOLVED` (or
  `KIND_NOT_EXPORTED` when the alias is known but the target gates the kind),
  quoting the slot's path and the aliases in scope. Previously — and for the old
  identity form before it — an unresolvable constraint made the reference check
  treat the slot as partial context and skip it, so a typo silently let the slot
  accept any resource. All three diagnostics are scoped to the modules the author
  can edit, so a published dependency never reports against its consumers.

  Definition schema `$id`s move onto `telo://<module>/<Name>`, the scheme named
  `Telo.Type`s already register under. One id space per module means a kind and a
  named type may no longer share a name; that collision is reported as
  `DUPLICATE_SCHEMA_ID` rather than silently dropping the type's schema.

  Version reconciliation keys on the **import ref minus its version** rather than
  `<namespace>/<name>`, so OCI and `https://` modules are hoisted for the first
  time and two same-named modules published to different origins are no longer
  conflated. A relative path addresses one file on disk, not a published
  location, and is not reconciled.

  `Transport.cacheLocation` is replaced by `Transport.cacheCoords`, returning the
  `{ transport, host, path, version }` coordinates that `manifestCacheKey`
  renders. The local manifest cache therefore uses the same layout as the
  discovery hub's static bucket:
  `.telo/manifests/<transport>/<host>/<path…>/<version>/<file>`. Registry entries
  now carry the registry host, so two registries' copies of one path and version
  no longer share a cache entry. **Existing `.telo/manifests` trees are orphaned
  by the new layout and are re-downloaded on the next `telo install`.**

  `telo publish` derives a relative sibling import's ref from the publish
  destination — the destination's last segment is the module's own directory, so
  `../bar` under `oci://ghcr.io/acme/foo` resolves to `oci://ghcr.io/acme/bar` —
  and reads only the sibling's version from its manifest. `SiblingIdentity` is
  gone.

## 0.54.0

### Minor Changes

- 942c176: Rename `ctx.resolveChildren` to `ctx.ensureKindRef`. The old name stays as a
  deprecated delegate.

  The method never resolved anything: it takes a nested slot value — an inline
  `{ kind, …config }` definition, a `{ kind, name }` ref, or a `!ref` sentinel —
  and produces a `KindRef`, registering the inline case as a manifest (under a
  supplied or generated name) on the way. `ensure` carries that create-if-needed
  side effect; `KindRef` is what comes back.

  It also reads correctly next to `ctx.resolveRef`, which runs the other direction
  — ref to live instance. Two `resolve*` methods on one interface returning
  opposite categories was the ambiguity; this fixes it at the source rather than
  lengthening the name of the method that was right.

- adc8459: Add `encodeJsonValue` / `decodeJsonValue` — JSON encoding for values that cross
  a persistence boundary.

  `JSON.stringify` throws on a BigInt, and CEL integers surface as BigInt in this
  runtime, so any controller persisting a CEL-computed result hits it. BigInt is
  encoded as a tagged object rather than a string or a Number: a string comes back
  a different type than went in, and Number is lossy past 2^53 — a replayed value
  must equal the freshly-produced one.

- adc8459: Add `ctx.resolveRef<T>(value, guard, describe, expects?)` on `ResourceContext` —
  resolve a `!ref` config field to a live instance. The standalone
  `resolveRefInstance(value, ctx, guard, describe, expects?)` remains exported for
  callers that hold only a `{ moduleContext }` slice; the method delegates to it,
  and `resolveInvocableDispatcher` now resolves through it too, so alias semantics
  live in exactly one place.

  Failures are coded and name the contract: `ERR_REF_REQUIRED` for an unset slot,
  `ERR_REF_UNRESOLVED` for one that is set but does not resolve — e.g.
  `` Cache.Entry "page": 'store' reference 'Redis.store' did not resolve to a
resource satisfying `std/cache#Store`  ``.

  Phase 5 injection normally replaces the slot with the live instance (local and
  cross-module refs alike), so the common path is the guard short-circuit. A raw
  `KindRef` still reaches a controller where injection does not reach the slot — a
  kind whose definition yields no field map, or a ref obtained via
  `ctx.resolveChildren`. Both are gaps worth closing in the kernel; until they are,
  this helper is the single place that handles the fallback.

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

## 0.49.0

### Minor Changes

- 2395a4a: Make network failures actionable instead of `fetch failed`.

  `fetch` rejects with an opaque `TypeError: fetch failed` for DNS, connection
  refusal, and TLS alike; the real cause (`ENOTFOUND`, `ECONNREFUSED`, …) sits on
  `error.cause`, which nothing in the repo read. A misconfigured host surfaced as
  `INTERNAL_ERROR: fetch failed` with nothing to act on — no host, no reason, no
  indication of which manifest field was wrong.

  `fetchOrThrow` in `@telorun/sdk` wraps a transport failure as an `InvokeError`
  with code `ERR_NETWORK_UNREACHABLE`, carrying structured `data` — `operation`,
  `url`, `host`, `port`, `cause`, the underlying `detail`, and the `resource` +
  `setting` to change — plus a default message composed from them. A non-OK
  response is returned untouched — a status code is a reply the caller interprets,
  often from the provider's own error body — so it drops into existing call sites
  without changing status handling. Cancellation is re-thrown as-is.

  Every part is structured, including the actionable one: a call site passes
  `resource` (the instance's `metadata.name`) and `setting` (`baseUrl`) as bare
  identifiers, and the sentence is composed in one place. Prose at the call site
  would be exactly what another language's SDK has to retype and keep in sync,
  whereas `cause: "ENOTFOUND"` and `setting: "baseUrl"` are the same symbols
  everywhere — so a kernel-side renderer can later format from `data` without any
  SDK changing.

  Wrapping never loses what was thrown: the original error is preserved as
  `cause` (`InvokeError` gained an optional `{ cause }`), its message is kept in
  `data.detail`, and for a code the mapping does not recognise that message is
  appended to the rendered text — so an unmapped code reads as strictly more than
  the raw `fetch failed` it replaces, never less.

  Also fixes a live misclassification in `Http.Request`: `mapNetworkError`
  selected its error kind by substring-matching the message, but the message is
  always the literal `"fetch failed"`, so `enotfound`/`ssl` never matched and every
  network failure — DNS and TLS included — was reported as `CONNECTION_REFUSED`.
  It now classifies on the cause chain's code, via the exported `networkCauseCode`.
  `Mcp.Client` had the same opaque-message problem in its transport error and is
  fixed the same way.

## 0.48.0

### Minor Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

## 0.47.0

### Minor Changes

- ec524cd: Enforce the `exports.kinds` gate statically. The analyzer's gate was dead code — it read `exports.kinds` off the `Telo.Import` doc, which has no such field, so the list was always empty and no unexported kind was ever rejected. `flattenForAnalyzer` now stamps the target library's resolved `exports.kinds` (re-exports included) onto each `Telo.Import` as `metadata.exportedKinds`, and the analyzer registers it, so `telo check` agrees with the kernel instead of being silently more permissive.

  An unexported kind now reports `KIND_NOT_EXPORTED` naming the module and its exported kinds, rather than an `UNDEFINED_KIND` whose "did you mean" echoed back the kind just rejected.

  `registerImport` / `registerModuleImport` take `kinds?: readonly string[]`, separating cases the previous empty array conflated: a declared gate (`["A"]`), a gate that exports nothing (`[]`), and a target declaring no `exports.kinds` at all (`undefined`, the legacy permissive default). This is the groundwork for making kinds private by default; that default is unchanged for now, since already-published module versions cannot gain the block retroactively.

  The gate is consulted before any definition-registry lookup. The registry is keyed `<module>.<Kind>`, so a library whose `metadata.name` equals the alias it is imported under made the raw kind string a valid key — the definition resolved directly and an unexported kind was accepted, while the kernel threw at boot.

  `resolveExportedKinds` distinguishes a module that declares no `exports.kinds` from one that declares an empty list, so a re-export (`exports.kinds: [Alias.Kind]`) whose source module is ungated still resolves, matching the kernel instead of rejecting a manifest that runs.

  `registerUngatedAlias` replaces the ungated form of `registerImport` for `Self` and the `Telo` built-ins. Those cross no import boundary and must never be gated; keeping them on a separate method leaves the legacy permissive import as the only remaining ungated `registerImport` call, so making kinds private by default is a single greppable site.

  `AnalysisRegistry.registerImport` takes the gate as optional too, and gains `registerUngatedAlias`, so IDE/editor consumers express the same three intents as the kernel.

## 0.44.0

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

## 0.41.0

### Minor Changes

- 721a241: `Lease.Critical` learns `op: cancel`: a running **detached** body can be ended
  early by invoking the lease with `{ op: cancel, key, holder? }`. The body runs
  under a lease-owned cancellation scope, so the cancel trips its cancellation
  token — every honoring leaf (a model call, a `Timer.Delay`, a fetch) aborts —
  and the lease releases on the body's terminal. The `holder` guard refuses a
  stale cancel aimed at a newer occupant of the key, and a body ending because it
  was cancelled is treated as an expected terminal, not a detached failure.

  SDK: `resolveInvocableDispatcher`'s returned thunk accepts an optional
  `InvokeContext` second argument, letting a decorator seed the dispatch's
  cancellation scope (backwards compatible — omitted means the ambient context
  applies unchanged).

## 0.38.0

### Minor Changes

- a9ac4ba: Resolve `Type.JsonSchema` `extends` into a single self-contained object schema (a deep-merge of the parent schemas and the own schema) instead of an `allOf` wrapper, and expose the resolved schema as readable `schema` state on the Type instance.

  The merge is now a single shared function, `mergeTypeSchemas` in `@telorun/sdk`, called by both the runtime `type` controller and the analyzer — so static analysis and runtime validation can never disagree on a type's effective shape. This fixes a false `CEL_UNKNOWN_FIELD` the analyzer raised when CEL accessed a field inherited through `extends` (it previously saw only a child type's own properties).

  The merged form carries no `$ref`s, so a named type's effective shape is directly usable as a validation schema (e.g. an HTTP request body) without bundling, and it removes the `allOf` + `additionalProperties: false` footgun where each branch independently rejects the other branch's properties. `required` is unioned across all levels and child properties win on a key conflict. Composition keywords (`allOf` / `oneOf` / `anyOf`) declared on a parent or own schema are preserved as intersected `allOf` branches — never silently dropped — so an inherited constraint still applies.

- a125804: Give resources spawned by a templated kind a hierarchical identity, so the debug graph nests them under their parent and stops collapsing collisions.

  A `Telo.Definition` with a `resources:` block (e.g. `std/crud`'s `Crud.Resource`) expands into child resources whose `kind` + `name` are identical across every instance of the kind — two `Crud.Resource`s both spawn `SqlRepo.Read.reader`. The debug stream keyed nodes by name, so those children collided and only one appeared, with no link back to the owning resource.

  - **Kernel / SDK**: every resource now carries a full hierarchical `id` (`<owner.id>/<kind>.<name>`, or `<kind>.<name>` at the top level). A template controller stamps the owning resource onto the child context it registers its `resources:` into (`EvaluationContext.owner`), so the children's `Created` / `Initialized` / `Teardown` and dispatch events carry that `owner` and a unique `id`; dependency edges are id-qualified too. `ResourceContext.ownerPrefix` exposes the composing prefix so the identity stays unique when templates nest. The dependency-edge collector also skips `schema` for the system kinds whose `schema:` is definitionally a JSON-Schema contract (`Telo.Definition` / `Telo.Abstract` / `Telo.Type`): a `{kind, name}`-shaped value in a schema `examples` block is documentation data, not a `!ref`, and previously surfaced as a phantom dependency edge (e.g. every `Telo.Definition` wiring itself to a resource named in its example). Other kinds' `schema` fields are still walked, so a genuine `schema: !ref X` resolves.
  - **Resolved properties**: each `Created` event now also carries `properties` — the resource's config "after templating", with compile-time `${{ }}` / `!cel` reduced to concrete values, resolved `!ref`s (and injected live instances) shown as `{kind,name}`, deferred runtime expressions as their `${{ source }}` text, and known secret values scrubbed to `[secret]`. The node detail panel renders it as a **Properties** section above Inputs/Outputs.
  - **Wire** (`@telorun/debug-wire`): lifecycle and dispatch payloads gain `id` on the resource `ref` and an optional `owner` pointer (`WireOwner`, `WireResourceRef`, `LifecyclePayload`); `Created` adds `properties`. Additive — a legacy producer that omits `id` falls back to name-keyed identity.
  - **Debug UI**: the Graph view keys nodes by `id` and renders a templated resource as one node with an "n internal" badge. Clicking it opens a drill-down panel showing that resource plus the children it spawned (`subtreeGraph`), wired into a tree — the children connected by their own dependency edges, and the parent linked by a dashed ownership edge only to children not already reached through a sibling (so a handler reached via the Http.Api isn't also tied directly to the parent). Drilling into a child pushes another panel onto a cascading stack (recursive to any depth); panels beneath peek out on the left and click to pop back, so the main canvas never reflows. The node-detail aside now scrolls as one unit — previously its flex body collapsed each inputs/outputs payload into a tiny nested scrollbar.

## 0.36.0

### Minor Changes

- dded615: Templated definitions can now produce a mountable HTTP surface, and their dispatch targets are created once instead of per call.

  - **`mount:` template dispatch** — a `Telo.Definition` with `capability: Telo.Mount` may declare `mount: <child>` (sibling to `invoke:` / `run:` / `provide:`) naming a `resources:` entry that is itself a `Telo.Mount` (e.g. an `Http.Api`). The template instance's `register()` delegates to that persistent child, so a library can ship a self-contained, declarative HTTP resource. The analyzer validates the new field (`MOUNT_ON_NON_MOUNT`, `MOUNT_DISPATCHER_CONFLICT`, `MOUNT_TARGET_UNKNOWN`, `MOUNT_TARGET_NOT_MOUNTABLE`).
  - **Persistent dispatch targets** — the template controller no longer re-creates its `invoke:` / `run:` / `provide:` target on every call (`withEphemeral` is removed). Every `resources:` entry is created once at `init()` and reused; per-call data flows exclusively through the top-level `inputs:` sibling. A resource body may reference only `self`; `${{ inputs.* }}` inside a target body is no longer supported (move it to the top-level `inputs:`).
  - **Library-scoped child resolution** — a template's `resources:` are spawned in a child context rooted on the _defining_ library's module context (new `EvaluationContext.spawnChildContext()`), so their internal kind aliases and `!ref`s resolve against the library's own imports rather than the consumer's.
  - **http-server** — a route declared at `/` now sits at the mount root (`/todos` + `/` → `/todos`) instead of a trailing-slash variant Fastify treats as a distinct, unmatched URL, so collection-style mounts respond at the mount path itself.

## 0.34.0

### Minor Changes

- d7fda97: Add module-scoped JSON Schema `$ref`s for named `Telo.Type` resources. A `Type.JsonSchema` now registers its schema under a canonical URI `$id` of `telo://<module>/<name>`, so any `inputType` / `outputType` / config `schema` can reference it with a standard JSON Schema `$ref`. Authors write the reference through an import — `telo://Self/<name>` for the declaring module's own type, `telo://<Alias>/<name>` for an imported module's — and the loader resolves the authority to the module name (the version is carried by the `imports:` entry, never the URI).

  - `@telorun/sdk` exports `canonicalTypeSchemaId`, `parseTeloTypeRef`, and `TELO_TYPE_SCHEME`.
  - `@telorun/analyzer` rewrites `telo://Self|Alias/Type` schema refs to their canonical id in both `analyze` and `normalize` (so the kernel runtime, import loads, and static analysis agree), registers named-type schemas in its AJV, and emits `SCHEMA_TYPE_REF_UNRESOLVED` / `SCHEMA_TYPE_REF_UNKNOWN_ALIAS` diagnostics for refs that resolve to nothing.
  - `@telorun/type` registers each `Type.JsonSchema` under its canonical `telo://` id in the runtime schema registry.

  This lets a module declare a shared schema fragment once (e.g. a filter grammar) and reference it from several definitions without duplicating it, while keeping references statically analyzable and version-pinned through the import.

## 0.33.0

### Minor Changes

- 95f168e: Cache, rate-limit, and background-task primitives, plus a comprehensive URL-shortener example.

  - New `cache` family: the backend-pluggable `Cache.Store` abstract with `Cache.Lookup` / `Cache.Entry` (freshness-aware: `ttl` fresh window + optional `staleTtl` grace window, `state` of `miss`/`fresh`/`stale`) and the `Cache.View` read-through decorator (single-flight background revalidation). Backends ship as `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`, with observable degrade-to-`fallback`).
  - New `rate-limit` module: `RateLimit.Guard`, a non-throwing sliding-window limiter whose counters live in any `Cache.Store`.
  - `run` gains `Run.Detach` (generic, zero-config fire-and-forget).
  - SDK + kernel: `ResourceContext.runDetached(fn)` runs a function detached from the caller's cancellation/trace scope; the kernel tracks each detached task against its owning resource and drains it (bounded) when that resource tears down, routing failures to the EventBus. Used by `Run.Detach` and `Cache.View`'s background revalidation.
  - `http-server`: `Http.Server.trustProxy` and a derived `request.ip` in the handler CEL context (canonical client address for rate-limit keys).

### Patch Changes

- 95f168e: Fix `ERR_RESOURCE_NOT_INVOKABLE` when mounting an imported library's `Http.Api` whose route handler is a library-internal resource.

  Phase-5 dependency injection now defers a resource whose **local** (`!ref name`) reference points at another resource that is registered in the same context but not yet initialized, mirroring the existing cross-module (`!ref Alias.name`) deferral. Previously such a local ref was silently left unresolved when create-success order diverged from init order — e.g. an importer that preloads the `Http.Api` controller lets the API create and inject before its internal handler's controller has loaded — leaving the handler slot as a raw `{kind, name}` sentinel that failed at request time. `PreInitHook` gains an `isPending` predicate so the injection walk can tell a pending dependency apart from a genuinely absent reference.

## 0.32.0

### Minor Changes

- a8c99ab: Generic dispatch tracing: trace every capability dispatch (invoke and run) through one instrumented chokepoint and carry trace data in a structured event payload instead of the event name.

  - Dispatch events drop the kind from the name (`<name>.Invoked` / `.Run`, plus error/cancel variants). The payload now carries `{ spanId, parentSpanId, capability, phase, outcome, ref: { kind, name }, … }`; consumers read the payload and never parse the dotted name. Lifecycle events (`Kind.name.Created` / `.Initialized` / `.Teardown`) are unchanged.
  - `run()` is now span-instrumented like `invoke()`: it mints and propagates a trace id, so Runnables (e.g. a `Run.Sequence` boot target) appear in the trace and their nested invokes re-parent correctly instead of detaching as false roots. Long-lived Services emit a `<name>.Running` start span. Run failures emit `<name>.RunFailed` (rethrown, never swallowed).
  - Invoke/run emit a `<name>.Invoking` / `.Running` start span when tracing is on.
  - SDK: new `REF_IDENTITY` / `stampRefIdentity` / `getRefIdentity`. The kernel stamps a resolved `!ref`'s kind+name onto the injected instance so `executeInvokeStep` routes pre-injected live instances through the traced chokepoint instead of calling `.invoke()` directly and escaping instrumentation.
  - The boot `targets` run is wrapped in an application span (`<appName>.Run`, `ref.kind: "Telo.Application"`), so the application is the trace root with its targets nested beneath. Pre-resolved `!ref` boot targets now dispatch through a new `EvaluationContext.runResolved` (the `run()` analog of `invokeResolved`) instead of calling `instance.run()` directly, so they emit their own run spans nested under the app.
  - A `Telo.Service`'s long-lived `run()` no longer establishes the cancellation/trace ALS scope (its token is delivered via the explicit `run(invokeCtx)` argument instead). This stops the boot scope leaking onto async resources the service creates — e.g. an HTTP server's socket — so inbound work (each request) starts as its own root trace with no inherited boot cancellation token, instead of nesting under the bootstrap trace. Runnables keep the ALS scope so their steps still nest and inherit cancellation.
  - `EventBus.emit` short-circuits in O(1) when there are no subscribers, keeping the always-through-the-chokepoint dispatch effectively free when nobody is listening.
  - OpenTelemetry-ready trace model: every span carries a `traceId` (OTel-compatible 16-byte hex), minted at the root and inherited by descendants, so an exporter groups a trace without walking the parent chain. New generic `ctx.openSpan(base, { ref, label, attributes, inbound? })` primitive opens an inbound-boundary span (capability `"request"`) that roots its own trace; `inbound` allows continuing an upstream distributed trace later. The `TracePayload` gains `traceId`, `label`, and `attributes`.
  - `http-server`: each inbound request opens a request span attributed to the `Http.Api` and labelled with the route (`"POST /feedback"`, attributes `{ method, path }`); the handler invoke and its subtree nest under it, as a trace separate from the bootstrap.
  - Trace context capture: a trace's root span carries `payload.context` — a redacted snapshot of the CEL root scope available to the trace (`variables`, `resources` snapshots, `ports`, and `secrets` with values masked to `"[secret]"`; host `env` omitted). Lets a debug consumer see what data an execution could reference beyond its own inputs/outputs. The UI renders it as an "Available context" section on the root node.

## 0.31.0

### Minor Changes

- b41012f: sdk: `InvokeContext` gains optional `invocationId` + `parentInvocationId` (the trace correlation a controller can read while a debug consumer is attached). `EmitEvent` gains an optional `metadata` argument, and a new `Tracer` type + `EvaluationContext.tracer` slot expose the kernel's invocation tracer. All additive — existing call sites are unaffected.

## 0.26.0

### Minor Changes

- 1ddd803: Add a single, threaded cache-root resolution and a read-only cache mode for ephemeral runs.

  - **`TELO_CACHE_DIR` reinstated** as the override for the `.telo` cache root, resolved once per load via the new `resolveCacheRoot(entryUrl)` and threaded to the manifest cache, compiled validators, analysis stamp, and npm install root — no consumer re-derives it or reads the env independently. `Kernel.load` gains a `cacheDir` option so a CLI caller resolves it once and the kernel reads no env.
  - **`telo run --no-cache-write`** (kernel `writeCache: false`) keeps the cache read-only: baked validators/manifests are still loaded, anything uncached validates in-memory, and nothing is persisted — so a read-only, ephemeral session rootfs validates without touching (or failing to write) the cache. Validation errors still surface normally.
  - **SDK**: `ResourceContext` gains `getInstallRoot()`, the threaded npm install root, so controllers honour a relocated cache root.

## 0.23.0

### Minor Changes

- 8586b39: Resolve resource references uniformly across import boundaries and execution scopes.

  - **http-server**: `mounts[].type` is now an injected `Telo.Mount` reference (`!ref <name>`, or `!ref <Alias>.<name>` for a mount exported by an imported library) instead of a dotted kind-string. The server consumes the live injected instance, so an `Http.Api` / `Mcp.HttpEndpoint` defined in another library can be mounted across the boundary. The bare `Kind.Name` string form is removed.
  - **s3**: `bucketRef` is now an `x-telo-ref: "std/s3#Bucket"` slot (`!ref <bucket>` / `!ref <Alias>.<bucket>`); controllers consume the injected `S3.Bucket` instance, so S3 operations can reference a bucket exported by another library. The `{ name }` form is removed.
  - **analyzer**: `resolveRefSentinels` recurses into `x-telo-scope` resources, so a `!ref` inside a scoped resource (e.g. a `Run.Sequence` `with:` server's mount) is canonicalized to `{kind, name}` like any top-level slot.
  - **kernel**: Phase-5 dependency injection targets the (compile-CEL-expanded) resource the controller actually receives, so injected instances reach reference fields that also carry `x-telo-eval: compile` (e.g. `Http.Server.mounts`).
  - **sdk**: `CreatedResource` gains an optional `resource`, letting a factory return the expanded manifest the controller was created with.

## 0.21.0

### Minor Changes

- 64debb5: Add the `!sql` templating engine for safe, dialect-neutral SQL interpolation. A `!sql "… ${{ expr }} …"` scalar evaluates to a parameterized value — literal fragments plus the separately-evaluated value of each interpolation — instead of a joined string, so consumers can emit driver-native placeholders and bind the values rather than splicing them into the SQL text.

  Supporting additions: `@telorun/sdk` gains an optional `parts` field on `CompiledValue` (an interpolated template's segments before they are joined) plus the shared `ParameterizedSql` type and `isParameterizedSql` guard (the marker contract producers and consumers single-source). `@telorun/templating` adds `toParameterized(value, ctx)`, which splits a value into `{ fragments, values }` and backs the new engine.

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

## 0.18.0

### Minor Changes

- d2294de: Type `inputType` / `outputType` on `ResourceDefinition` (they were read through an untyped cast). Add `AnalysisRegistry.refFieldsForResource()`, `capabilityForRef()`, and `inputTypeForKind()`. `refFieldsForResource` returns every `x-telo-ref` field a resource's definition declares — path, arity (`isArray`), accepted constraints, and the capabilities each slot may target — derived purely from the schema field map, so it lists slots even when the manifest leaves them empty. `capabilityForRef` resolves an `x-telo-ref` constraint to the base capability it targets (a user-defined abstract's declared `capability`, not its kind). `inputTypeForKind` resolves a kind's `invoke()` input schema (own `inputType`, falling back to the `extends`-declared abstract's). Together they let editor hosts render reference fields as node ports (drag-to-wire for node-capability targets, inline picker for ambient ones) and edit an edge's invocation `inputs` as a typed form — without hardcoding any resource kind.

## 0.17.0

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

## 0.16.0

### Minor Changes

- 55b4ec5: Add exported resource instances: a `Telo.Library` can declare a resource and export it as a ready-made singleton via `exports.resources`, and consumers reference it across the import boundary with `!ref Alias.name` (and read value-flow exports in CEL as `${{ resources.Alias.name }}`). `std/console` now exports `writeLine` / `readLine` singletons, so a consumer can `!ref Console.writeLine` instead of declaring its own `Console.WriteLine` instance.

  Reference grammar: every `!ref` is `<Alias>.<name>`, split on the first dot — a bare name (or `Self.`-qualified) resolves locally; a non-`Self` alias resolves into that import's `exports.resources`. A resource name may no longer contain a dot (new `INVALID_RESOURCE_NAME` diagnostic), since the dot separates alias from name.

  `Self` now resolves a library's own kinds **ungated** (no longer bound to `exports.kinds`) — `exports` gates importers, not internal use — and the kernel registers `Self` in each import's child context, so a library can declare an instance of a kind it doesn't export (`kind: Self.WriteLine`).

  `std/assert` likewise exports its config-free assertions (`equals`, `matches`, `contains`) as singletons, so a test can `!ref Assert.equals` — including inside a `Run.Sequence` step — instead of declaring an `Assert.Equals` instance.

  Mechanics: the analyzer forwards a library's exported instances across the import boundary (gate = what's forwarded), and the kernel injects/boots them from the import's child context. Cross-module refs resolve on every consumption surface — Phase 5 injection (threads the alias; an unresolved ref defers to a later init pass), flat boot targets, `Run.Sequence` step invokes (via `resolveChildren` + `executeInvokeStep`), and CEL `${{ resources.Alias.name }}`. Lifecycle is unchanged — an exported instance is the import child context's existing singleton.

## 0.13.0

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

## 0.12.0

### Minor Changes

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

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

## 0.11.1

### Patch Changes

- 58362c4: Make `Stream` a `globalThis`-keyed singleton so its constructor identity survives multiple `@telorun/sdk` copies in a single process. cel-js identifies CEL object types by constructor identity, and the kernel + an npm-loaded controller (e.g. `S3.Get`) routinely resolve to different sdk installs (workspace vs `.telo/npm/<hash>/...`). Before this change, a `Stream` value produced by a controller threw `Unsupported type: Stream` at runtime whenever it flowed through a CEL expression like `${{ steps.fetch.result.output }}` — even though both copies declared the same `Stream` class — because the registered constructor on the kernel side wasn't the constructor that produced the value. The fix is contained in the sdk's `stream.ts`: the first copy to load registers its `Stream` class on `globalThis` under `Symbol.for("@telorun/sdk:Stream")`; later copies discard their local class declaration at export time and re-export the registered one. No build artifact, `file:` symlink, or kernel-side realm-collapse install is required for class identity to hold.

## 0.10.0

### Minor Changes

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

## 0.7.0

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

## 0.6.0

### Minor Changes

- dccd3a6: Kernel quick-wins cleanup plus per-module import isolation.

  **Per-module import isolation.** `Telo.Import` aliases now register on the declaring module's own `ModuleContext` instead of all collapsing into the root context's alias table. Sibling modules that declare the same alias name no longer overwrite each other; runtime kind dispatch resolves through the resource's owning module and walks up the parent chain so children still inherit root-level built-ins like `Telo`. This was a latent isolation bug — visible as wrong-target alias resolution whenever two modules used the same alias name.

  **SDK breaking changes.**

  - `ModuleContext.importAliases: Map<string, string>` is removed from the public interface; replaced with `hasImport(alias: string): boolean`. Callers that need to test alias presence should use `hasImport`; the underlying map is now `private` on the kernel implementation.
  - `ResourceContext.getResources(kind)` and `ResourceContext.teardownResource(kind, name)` are removed. They were always stubs that threw `"not implemented"`.
  - `ControllerContext.once(event, handler)` and `ControllerContext.off(event, handler)` are removed. Same reason — stubs that threw on call.
  - `ResourceContext.registerModuleImport(alias, target, kinds)` is unchanged in shape but now writes to the caller's own `ctx.moduleContext` rather than going through the kernel's discarded `_declaringModule` indirection.

  **Kernel internals.**

  - `kernel.getModuleContext`, `kernel.resolveModuleAlias`, `kernel.registerModuleImport` and `kernel.registerImportAlias(alias, target, kinds)` deleted. Runtime alias storage lives on `ModuleContext` itself.
  - `kernel._createInstance` resolves kinds via the resource's enclosing `ModuleContext` (walking parents) instead of always going through the root.
  - `EvaluationContext` no longer swallows `instance.snapshot()` errors with `.catch(() => ({}))` — failures now propagate into the existing init-loop diagnostics. Previously a provider whose snapshot threw silently produced an empty `${{ resources.X.* }}` namespace downstream.
  - Spurious `console.log("Registering resource:", kind, name)` in `ManifestRegistry.register()` removed.

  **Removed packages.** `@telorun/tracing` is deleted. The module's controllers depended exclusively on the now-removed `getResources`/`off` stubs, was wired into no tests, and had no external consumers in the workspace.

  **Assert.ModuleContext controller** was the only user of the removed `(ctx as any).resolveModuleAlias(...)` shim; it now calls `ctx.moduleContext.hasImport(alias)`.

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

## 0.5.0

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

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.

## 0.3.0

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

## 0.2.8

### Patch Changes

- Automated release.

## 0.2.7

### Patch Changes

- Automated release.

## 0.2.6

### Patch Changes

- Automated release.

## 0.2.5

### Patch Changes

- Automated release.

## 0.2.4

### Patch Changes

- Automated release.

## 0.2.3

### Patch Changes

- Automated release.

## 0.2.2

### Patch Changes

- Automated release.
