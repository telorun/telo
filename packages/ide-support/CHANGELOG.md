# @telorun/ide-support

## 0.18.1

### Patch Changes

- 8dc6e35: Remove the Telo HTTP registry. Modules resolve over `oci://` and direct `https://` URLs only; the bare `<namespace>/<name>@<version>` ref form and the `registry.telo.run` origin are gone.

  **Breaking.** A manifest whose `imports:` names a bare ref no longer resolves — rewrite it to the module's `oci://` ref. `--registry-url` (run / check / install / upgrade / migrate / module), `--registry` (publish), `TELO_REGISTRY_URL` and `TELO_REGISTRY_TOKEN` are removed, as is `Kernel`'s `registryUrl` option; `defaultTransports` / `defaultTransportRegistry` / `defaultSources` take no argument. `RegistryTransport` becomes `HttpTransport` — it keeps direct `https://` module URLs and the `.telo/manifests/url/…` cache subtree, and enumerates no versions. `RegistrySource`, `parseModuleRef` and `isRegistryRef` are removed from `@telorun/analyzer`, and `withRefVersion` now accepts only `oci://` refs. The `registry/<host>/…` manifest-cache subtree is no longer written or read. `SessionConfig.registryUrl` leaves the runner `/v1` contract, `sessionConfigSchema` loses its `registryUrl` option, and the k8s chart drops `build.teloRegistryUrl` (which also changes every per-app image tag, since the registry URL was a digest input).

- Updated dependencies [7ddd502]
- Updated dependencies [8dc6e35]
  - @telorun/analyzer@0.69.0

## 0.18.0

### Minor Changes

- c15b198: `x-telo-sensitive` keeps auth material off the debug wire

  Invoke inputs and outputs ride the debug wire on every call under `--inspect` —
  which is every watch session — and nothing scrubbed them. The kernel's substring
  scrubbing has exactly one call site, the resource-Created event's properties;
  log attributes match on exact values; dispatch payloads were not covered at all.

  That was survivable while a credential was a held instance whose material never
  crossed a dispatch boundary. It stops being survivable the moment auth is a
  dispatched `Telo.Invocable`, because the token becomes an invoke **output**.

  A contract property may now be marked `x-telo-sensitive: true`, and the trace
  payload carries that value as `[redacted]` instead of verbatim. `Http.Credential`
  marks its own output, so every implementation — including OAuth's, which was
  already on the wire unmarked — inherits it.

  Declared by the kind that OWNS the contract, read generically: the kernel names
  no kind, and any module opts in, the same shape `x-telo-eval` has. Exempting "an
  `Http.Credential` result" directly would have been kind-knowledge in the kernel,
  and would have stopped at that one kind while the same token surfaces wherever
  else a contract carries it.

  The key is kept and only the value replaced, per the logging spec §14 — a payload
  that silently loses a key reads as a value that was never produced. Where the
  contract cannot be resolved the payload is withheld whole rather than guessed at;
  the dispatch that follows raises that same failure with its own code, so nothing
  is swallowed.

  Completion follows the same split. The annotation vocabulary was offered only
  where the fragment is `KindSchema` — a kind's CONFIGURATION — so the editor
  suggested `x-telo-sensitive` on the one schema the kernel never reads it from and
  withheld it from the two where it is the whole mechanism. It now lives in its own
  `TELO_DATA_SCHEMA_ANNOTATIONS` set, offered for `JsonSchema7`.

  Bounded by the schema, like the default-fill and scalar-normalization walks
  beside it: a contract marking nothing walks nothing at dispatch, and the paths
  are resolved lazily so a contract is still compiled on first dispatch rather than
  at create time.

### Patch Changes

- Updated dependencies [d887374]
- Updated dependencies [c15b198]
  - @telorun/analyzer@0.68.0

## 0.17.1

### Patch Changes

- Updated dependencies [7d49da2]
- Updated dependencies [46295b2]
- Updated dependencies [46295b2]
- Updated dependencies [46295b2]
  - @telorun/analyzer@0.67.0

## 0.17.0

### Minor Changes

- cbc2a4d: "Where is CEL evaluated" is one reader, and `!literal` declares that it produces
  a string.

  The rule had two halves in two places: `x-telo-eval` paths in `eval-paths.ts`,
  and the regions that cover their contents (`x-telo-context` /
  `x-telo-step-context` / `x-telo-error-context`, and a step body) in
  `validate-cel-context.ts`. Every consumer needed both and combined them itself —
  including the editor, whose answer is a claim that `telo check` will accept what
  it writes. It read the annotation half alone, so a predicate sitting inside a
  region (`Run.Choice`'s rows, an `Http.Api` route's `returns:` entries) offered no
  way to write the expression the field exists to hold. The region half moves
  beside the annotation half, re-exported from its old home, and both are read
  through `celEvalSites` / `mergeCelEvalSites` / `celEvalModeAt` — which the
  analyzer's own `CEL_IN_NON_EVAL_FIELD` and `OBSERVED_STATE_IN_STARTUP_FIELD`
  checks now ask instead of combining the pieces themselves.

  Three CEL mistakes that reached the runtime unreported now fail `telo check`.

  An **undeclared root identifier** (`!cel "fff"`): cel-js types an unknown name
  as `dyn` and accepts it, so the one CEL mistake with no static report at all was
  the simplest one. Member access on a KNOWN root was already covered, which is
  why a typo one level in was an error and a typo at the root was not. Reported as
  `CEL_UNKNOWN_IDENTIFIER`, and only where the environment is complete: a kind
  document's `examples:` and rule conditions are written for the scope of whoever
  instantiates the kind, and CEL below a nested inline `{ kind }` belongs to that
  kind — the two boundaries the non-eval-field check already draws.

  **`variables` / `secrets` typed per declaring module**, as `ports` and `module`
  already were. A resource document does not carry those blocks, so typing them
  from the analyzed manifest alone left every ordinary resource with an open map
  and no check, while `ports.<typo>` one line away was an error. They are read
  from the resource's own block, then its `metadata.moduleGlobals` stamp (a
  library's own, which must win over the consuming application's), then the entry
  module's doc.

  **The expression's type against the field's** — this check already existed and
  could not fire, because an untyped `variables` made every expression over it
  `dyn`. `when: !cel "variables.env"` now reports that it returns a string where
  the field expects a boolean.

  Also modelled: `inputs` is in scope beside `steps` wherever a step body runs.
  The step engine always provided it and nothing declared it, which went unnoticed
  while the step context stayed open. Left OPEN rather than typed from the kind's
  `inputType`: closing it would newly reject reads of arguments a contract does
  not spell out, which is a separate decision.

  `celCompletions` joins `buildCompletions` on `@telorun/ide-support`'s surface.
  The document-plus-cursor entry point is the wrong shape for a host that edits a
  CEL body directly in a field and therefore knows the site's address already;
  without it that host would model the scope itself, which is the thing the
  completion list is supposed to be a claim about.

  `!literal` declared no `producedType`, which put it in `!cel`'s category —
  produces whatever the slot says. It does not: it returns its source verbatim, so
  its type is a constant of the tag, exactly like an embed's. Declaring it keeps
  the tag off slots text cannot satisfy and makes a `!literal` at one a static
  failure through the ordinary schema check, where it previously passed
  `telo check` and failed at runtime.

### Patch Changes

- b9c0dbe: Doc and comment updates for the Telo Editor -> Telo Studio rename. Prose only —
  no behaviour, no API surface, and no shipped code path changes in any of these
  packages.
- Updated dependencies [cbc2a4d]
- Updated dependencies [68aa6dc]
- Updated dependencies [c829d25]
- Updated dependencies [c829d25]
- Updated dependencies [b9c0dbe]
- Updated dependencies [c829d25]
- Updated dependencies [c829d25]
  - @telorun/analyzer@0.66.0

## 0.16.1

### Patch Changes

- 67cafc0: Export the CEL-tree walk (`walkCel`, `flattenChain`, `chainAt`) from the package root.

  They were already the package's single answer to "walk this expression" — rename is built on them — but only reachable inside it, so a host asking the same question had to write a second `celChildren` and would answer differently the first time the CEL node union grew a case. The editor asks it before deleting a resource: a provider is reached through `resources.<name>` in CEL rather than through a reference slot, so a delete that consulted only the reference walk would report no references and silently break every expression reading it.

- 6dd29e6: `init()` and `run()` now RETURN what undoes them, and `teardown()` is removed.

  An effect is a forward action paired with its inverse. `ctx.effect(reason, body)`
  returns a lazy chain, `.effect(...)` extends it — threading each step's result
  into the next body, which is how an inverse gets the handle it has to close — and
  a controller hands the chain back for the kernel to execute:

  ```ts
  init(ctx) {
    return ctx.effect("pool", async () => {
      const pool = await openPool(url);
      return { result: pool, inverse: () => pool.end() };
    });
  }
  ```

  The signature is the point. An optional `teardown()` is one an author can forget,
  and so was an opt-in `ctx.effect` beside it; returning the chain asks "what undoes
  this" at the one place every controller already writes. A subclass extends its
  parent's chain (`super.init(ctx).effect(…)`) and unwinds in reverse construction
  order automatically.

  The chain is lazy — nothing runs until the kernel executes it, so sequencing and
  recovery are the kernel's — and deliberately not a thenable, since an `async`
  function would unwrap it and hand the kernel a result instead of a chain. Execute
  one in place with `.perform()` for an allocation whose lifetime is an _operation_
  rather than the resource (a hold taken per durable run inside `invoke()`); it
  returns an idempotent, unordered `dispose()`.

  Inverses live on frames — one per `create()`, `init()`, `run()` — and unwind
  last-in-first-out. A failed `init()` unwinds and the instance is DISCARDED, so the
  multi-pass loop's retry constructs a fresh one; a controller no longer needs
  resumability bookkeeping to survive a second `init()` call. A deferral
  (`ERR_LOCAL_REF_PENDING` / `ERR_CROSS_MODULE_REF_PENDING`) is not a failure and
  keeps the instance. An inverse that refuses during recovery withholds the
  resource; one that refuses at teardown aggregates into
  `ERR_EFFECT_RECOVERY_FAILED` and the cascade continues.

  `inverse` is optional: a step that allocated nothing returns its result alone,
  since a chain also sequences lifecycle work and a required no-op closure would
  read the same as a forgotten undo.

  `acquireHold` keeps its signature and now registers nothing — which frame owns a
  hold is the caller's fact, so it returns the raw inverse to place in a chain
  (`inverse: ctx.acquireHold()`), and a per-operation hold taken inside `invoke()`
  is performed and disposed when that operation ends. The detached-task drain is no
  longer folded into `instance.teardown` — it waits for in-flight work rather than
  undoing anything, so the cascade calls it after the frames unwind.

  A module whose controllers return chains must declare `requires: telo: ">=0.82.0"`:
  an older kernel calls `init()`, discards the chain, and allocates nothing.

  A scope that has fully unwound is closed: an effect registered after teardown is
  refused (`ERR_EFFECT_SCOPE_CLOSED`) before its body runs, rather than recording an
  inverse nothing will ever execute.

  `@telorun/ide-support` carries only the capability hover text for `Telo.Service`,
  which described the retired `teardown()`.

  Normative contract: `kernel/specs/revertible-effects.md`. No manifest surface
  changes.

- Updated dependencies [ffe8ca5]
- Updated dependencies [ffe8ca5]
  - @telorun/analyzer@0.65.0

## 0.16.0

### Minor Changes

- 839fb45: Make the CEL scope a QUERY, and give CEL expressions completion, hover and
  go-to-declaration on top of it.

  What an expression is typed against — the CEL environment plus the resolved
  `x-telo-context` schema — used to be assembled inline inside the analysis pass,
  built for one `engine.analyze` call and discarded. Nothing outside that loop
  could obtain it, so an IDE wanting to say what a cursor sees had only two
  options: re-implement the rule, or read a map keyed by paths the last analysis
  happened to visit. The first drifts silently the day the scope gains a name
  (`x-telo-bindings-from` did, value-type parameters did), because no test can
  hold two implementations of an open rule in agreement; the second cannot answer
  mid-token, which is exactly when the question is asked.

  `CelScopeResolver` (`cel-scope.ts`) is now the one answer, and the pass is one of
  its callers. `CelScopeQuery` (reached through `AnalysisRegistry.analysisOf(manifests)`) is the
  way in from outside: it resolves for an ADDRESS — a manifest and a concrete path,
  indices and all — recomputing the `x-telo-context` match exactly as the manifest
  visitor does, so a site the last analysis never walked still types. A completion
  list is therefore a claim that what it offers will pass `telo check`, rather than
  a second model of what CEL sees.

  On that: `buildCompletions` now completes inside a `${{ }}` / `!cel` body — the
  scope's root names and a context property's members, plus the global functions
  the environment declares — and offers nothing where the scope declares no shape,
  rather than guessing. `buildHover` gained a CEL branch it never had, reporting an
  identifier's type and description. `buildDefinition` gained `steps.<name>`
  navigation, the one CEL scope whose members are written in the manifest but
  reached through no reference slot; it is found through the declaring kind's own
  step-body annotation and the shared nesting walk, so a step inside a branch
  resolves and no resource kind is named.

  It also navigates CEL CONTEXT BINDINGS — `request.query` to the route's own
  `request.schema.query`, `self.<field>` to the definition's `schema`,
  `result.<field>` to the INVOKED resource's `outputType`. These are the same
  category one level out: a binding exists because an `x-telo-context-*`
  annotation derived it, so the site is found by re-walking that annotation, and
  one walk covers every transport and every kind that declares one. `scopeAt`
  resolves the annotation into a schema and loses the provenance, so the
  declaration side is its own method (`contextDeclarationSite`) rather than an
  origin field on `CelScope` that every type consumer would ignore. Each candidate
  path is checked against the manifest before it is returned, so a binding the
  author never declared — an annotation's static fallback properties — resolves to
  nothing rather than to a guessed node or to a dependency's schema.

  `telo check` validates a call made through a REFERENCE SLOT, not only one made
  from a step. The step driver found its argument map through the step grammar
  plus a sibling `x-telo-topology-role: inputs`, so an HTTP route's `handler:` +
  `inputs:` pair — which is neither — went unchecked: a misspelled key or a missing
  required input surfaced at dispatch inside the callee. Discovery is now driven by
  the same `x-telo-ref` `inputs:` pointer the editor reads, with the step case as
  one caller of one check, so every kind that names its argument slot is checked
  without the analyzer learning about routes or steps.

  Completion offers the keys an invoked target declares. A slot that transfers
  control names its argument slot on its own `x-telo-ref` (`inputs: /inputs`, a
  pointer relative to the enclosing object) — the only thing tying an `inputs:` map
  to the resource it holds arguments FOR, since the map is an open object and the
  reference sits in a sibling whose name no walker may assume. Reading that pointer
  means the keys offered are the ones the shared contract resolver produces, so
  they are what `telo check` validates the call against and what the kernel binds
  at dispatch, instance declaration winning over the kind's.

  The queries that need BOTH this registry and a manifest set now hang off one
  object, `ManifestAnalysis` (`AnalysisRegistry.analysisOf(manifests)`), replacing
  `celScopeQuery`. Four such questions arrived in short order — CEL scope, step
  declarations, context-binding declarations, invocation contracts — and each was
  otherwise another factory on the registry and another optional parameter on every
  IDE entry point. Naming the pairing once stops that accretion; each facet keeps
  its own honest name rather than piling onto whichever one existed first. Nothing
  re-implements an answer: `contractFor` IS the shared `resolveContract`, given the
  scope to run in. `analyzerContractScope` moved beside that resolver, where it
  belongs, rather than living in the CEL scope module.

  Completion offers the values a schema says a slot may take, in the two positions
  where a schema says so, and the open/closed distinction is the KEYWORD rather
  than a flag: `enum` constrains, `examples` only suggests. For a NAME-KEYED map —
  an HTTP `content:` block, whose keys are media types the author chooses —
  `propertyNames` is JSON Schema's own vocabulary for what a key may be, so
  `propertyNames: { examples: [...] }` is an open list of known keys with no
  validation footprint. For an ordinary field, `enum` / `examples` on the field
  itself. Both are stock JSON Schema, so nothing in the analyzer learns what a
  media type is and any name-keyed field gains the behaviour by declaring one.
  Value-slot completion did not exist at all before this — a field with a declared
  `enum` offered nothing, though hover already reported the allowed set.

  Completion and hover now follow `x-telo-schema-from`. A slot annotated with it
  declares no `properties` of its own — an `Http.Api` route's `request:` is exactly
  this, deriving its shape from `HttpDispatch.Request/$defs/Matcher` — so the
  schema walk landed on an empty node and offered nothing at all under it. Silent,
  and it made a whole field of the standard library behave like an unknown one.
  `AnalysisRegistry.resolveSchemaFrom` resolves the annotation in the DECLARING
  kind's module scope (anchors are alias-qualified), sharing one rule with the
  field-map expansion that already resolved it for Phase-5 injection; only the
  static dotted-anchor form resolves, since a relative anchor names a sibling
  property whose value is known per resource.

  Function candidates are one per FUNCTION, not one per overload. The CEL registry
  declares a signature per accepted argument list — `double` has four — so mapping
  each to its own item produced four identical labels an author cannot choose
  between; the overloads are now folded into one entry, counted on its detail line
  and listed in its documentation. A CEL type name is separately registered both as
  a variable of type `type` and as the conversion function of the same name, which
  is a second way one label arrived twice: the callable form wins the slot and its
  documentation records the other reading.

  `buildSemanticTokens` now colours the inside of a CEL body, which under a stock
  YAML grammar is painted as the string it is not. Doing it in the semantic layer
  rather than in a grammar is what makes one implementation serve both hosts — they
  already share this function, while a Monarch tokenizer beside the VS Code
  TextMate one would be a second CEL lexer to keep in agreement. It is also the
  only layer that can be right about names: a grammar knows the roots someone
  hardcoded into it (which is why `request` and `steps` went uncoloured), while the
  scope query knows what is in scope at that exact site. So a name the scope
  confirms is coloured and one it cannot is left alone — the quiet signal an
  unresolved `kind:` already gives. With no query, names are coloured
  syntactically instead, so a CEL body never reads as a plain string.

  The ROOT of a chain is a `namespace` and its members are uniformly `property`,
  so `request.params.turnId` reads as scope · path rather than one undifferentiated
  run. Colour encodes what a symbol IS — the invariant every language holds to —
  and a CEL root is not data the author declared, it is a scope the runtime
  injects. Colouring by the SHAPE of the value behind a name (object vs scalar) was
  considered and rejected: it is type-directed highlighting, so the palette becomes
  a type legend, a name changes colour as analysis resolves, and it says nothing
  exactly where the scope declares no shape.

  `SemanticTokenType` gains `property`, `function`, `number`, `string`, `keyword`,
  `operator` and `namespace`, appended to `SEMANTIC_TOKEN_LEGEND` — never inserted,
  since a host registers the legend once at activation and an insert would repaint
  every existing token as something else. All seven are stock LSP names, so themes
  colour them with no extra configuration.

  Each of these takes an optional `CelScopeQuery`; without one, CEL support is
  silent (or, for colouring, syntactic) and every existing behaviour is unchanged. Structural traversal (`resolveLocalRef`,
  `gatherPropertySchemas`, `walkStepArray`) moved to `schema-walk.ts` so the scope
  rule and the analysis pass can both reach it without either importing the other;
  all three are re-exported from `analyzer.js` unchanged.

### Patch Changes

- Updated dependencies [839fb45]
  - @telorun/analyzer@0.64.0

## 0.15.0

### Minor Changes

- 18a5d61: An unusable import is reported as itself, and an upgrade only offers a version this telo can run.

  **One shape for every unusable import.** Loading no longer distinguishes _how_ an
  import is broken. Unreachable, malformed, resolving to an application, resolving
  to something that is not a library, resolving to a library that names no module —
  each records a failure against that import, registers no dependency edge, and
  lets the rest of the graph load. The check now runs per import declaration rather
  than once per distinct target, which closes the case where an import pointing at a
  module something else already reached (the entry application above all) skipped it
  entirely. An application target used to abort the whole load; it is now a
  diagnostic on its own line, and still fatal at run time because the runtime
  refuses to start on any of these.

  Three codes, because three different people fix them: `INVALID_IMPORT_SOURCE`
  (not a module reference), `IMPORT_UNRESOLVED` (well-formed but not obtainable) and
  the new `INVALID_IMPORT_TARGET` (obtained, but not importable).

  **No guessing about module identity.** The analyzer used to derive a module name
  from an import's source string whenever the loader had stamped none. For a pinned
  ref that produced a canonical kind no registry can hold —
  `http-dispatch@0.11.1#sha256-….Outcomes` — and every consumer of the alias then
  failed in its own vocabulary, reporting a _dependency_ as schemaless when the real
  fact was that the import never resolved. The fallback is gone: an import with no
  resolved identity registers no alias, and uses of it say `cannot resolve alias
'<X>'`, which names the import the author can fix.

  **Upgrade affordances filter by `requires.telo`.** `manifestCompatibility` moves
  the verdict (`yes` / `too-new` / `unreadable` / `unknown`) into the analyzer, where
  the `requires:` grammar already has its single reader; `telo upgrade` now calls it
  rather than carrying its own copy. `@telorun/ide-support` gains the selection rule
  on top — walk candidates newest-first, stop at the first hostable one, report what
  was held back and why — so the editor's Imports view and the VS Code lenses answer
  "which version does this move to" identically. `buildImportUpgrades` takes an
  environment (`listVersions` + `isCompatible`) instead of a bare lookup, so a host
  cannot silently skip the check; one that genuinely cannot read candidate manifests
  passes `uncheckedVersionCompatibility`, which says so. A version that cannot be
  read or reached is never treated as incompatible, and only the telo axis is checked
  in an IDE — an IDE is not the host that will run the manifest.

### Patch Changes

- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [321f153]
- Updated dependencies [18a5d61]
- Updated dependencies [7463386]
- Updated dependencies [c7fdbd9]
- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [9ac2b8a]
- Updated dependencies [321f153]
  - @telorun/analyzer@0.63.0

## 0.14.1

### Patch Changes

- Updated dependencies [afb2b05]
  - @telorun/analyzer@0.62.1

## 0.14.0

### Minor Changes

- 17584a7: Rename, as an editor operation: `prepareRename` resolves the symbol under the
  cursor, `buildRename` returns the edit set for it across every file in the
  module. The VS Code extension wires both to <kbd>F2</kbd>.

  **A rename is a refactor, not a fix**, which is why it lives here rather than
  behind a `DiagnosticFix`. A fix is a whole-value replacement for ONE node,
  verified by the diagnostic that produced it; a rename is only correct when every
  reference moves with it, so its unit is the reference graph. Rewriting
  `metadata.name` alone leaves every `!ref`, `resources.<name>` and
  `steps.<name>.result` pointing at a name that no longer exists — a rename offered
  as a quick fix would break the file it claimed to repair.

  Edits are precise sub-spans, not whole scalars. A `!ref` scalar's own AST range
  is its value (the tag excluded), and a CEL identifier's span comes from
  `CelNode.propertyRange` — which the analyzer's node model has carried since it
  was written, commented "for a future rename". So renaming a step inside
  `output: "Username: ${{ steps.readUsername.result.value }}, Password: ${{ … }}"`
  rewrites that one identifier and leaves the rest of the string, including a
  second interpolation, untouched.

  Three renameable surfaces, chosen because their reference set is enumerable from
  the workspace: a resource instance, a `Run` step name, and a `variables:` /
  `secrets:` / `ports:` key. Everything else is an explicit refusal carrying its
  reason, never an empty result — a refusal here usually means the name has too
  many references, which is the opposite of what "nothing to rename" says:

  - An instance in `exports.resources`, or a `Telo.Library`'s declared config key.
    These are the module's public surface, referenced from files the workspace may
    not contain and, for a published consumer, cannot. That is a breaking change to
    version, not an edit to apply, and a rename box that silently shipped one would
    be the worst available framing.
  - A name declared twice in reach — a `with:`-scoped resource shadowing a
    module-level one, two steps in one resource sharing a spelling. References
    resolve to different declarations and no edit set is right for both.
  - A kind name, a module name or an import alias: their references are
    alias-qualified halves of `kind:` / `extends:` / `x-telo-ref` / `exports.kinds`
    values, a materially larger surface that wants its own pass.

  The new name is checked through the analyzer's own `checkName`, so a rename
  cannot introduce a name `telo check` would then reject. A step's edit set is
  document-scoped, because `steps.<name>.result` is readable only inside the
  resource whose body declares the step and a resource is one YAML document — which
  is also what makes two same-named steps in one document the ambiguity to refuse.
  The live buffer always stands in for the current file's snapshot: the graph is
  taken at the last analysis, so edits computed against it would otherwise write
  stale offsets into a file the author has since changed.

  `chainAt` / `flattenChain` / `celChildren` moved out of
  `definition/resolve-cel-target.ts` into a shared `cel-chain.ts` rather than being
  copied. The exhaustive `celChildren` switch is the reason: an unhandled `CelNode`
  variant fails the build there, and a second copy would mean the failure is caught
  for go-to-definition (a missed jump) but not for rename (a reference left
  pointing at the old name).

- 987decd: A slot that holds author-written JSON Schema now says so, instead of being
  declared `type: object` and nothing more. `telo://manifest#/$defs/JsonSchema7`
  (plain data — an `inputType:`, a `status:` block, an API route's
  `request.schema`) and `#/$defs/KindSchema` (a kind's own `schema:`, where the
  `x-telo-*` vocabulary belongs) join the shared fragment set, and the built-in
  `Telo.Definition` / `Telo.Abstract` / `Telo.JsonSchema` slots point at them.

  The gain is that every surface reading a kind schema now knows what lives there:
  completion offers the keyword set from the first key down and recurses into a
  property's own schema, hover has titles and descriptions to show, and a `status:`
  block is checked as a schema at `telo check` — anchored on the offending
  keyword's line — rather than at dispatch. Which vocabulary a slot admits is the
  fragment NAME, read off the derived `x-telo-fragment` stamp: the annotations are
  offered inside a kind's schema and withheld inside a data schema, where they
  would configure a slot that does not exist.

  Wired at the built-in slots only — `Telo.Definition` / `Telo.Abstract`'s
  `schema:` and `status:`, and `Telo.JsonSchema.schema`. A module's own
  schema-valued slots still declare `type: object`: `inputType:` / `outputType:`
  are `x-telo-ref` slots accepting four forms and need an `anyOf` branch rather
  than a replacement, and a slot reached through `x-telo-schema-from` is
  transplanted into the consumer's schema, where a document-local pointer resolves
  against a root that has no such entry.

  These two are the first RECURSIVE fragments, so they are not expanded in place
  like the others — a shape containing itself has no expanded form. A reference is
  rewritten to the document-local `#/$defs/telo:<Name>` pointer with one copy
  hoisted to the root of the schema a validator compiles, which is the only
  reference form the editor's resolver accepts and the one AJV resolves natively.
  The key is reserved rather than plain, so a kind declaring its own
  `$defs: { KindSchema: … }` cannot silently become what every slot pointing at the
  fragment validates against; for the same reason `mergeTypeSchemas` now merges
  `$defs` key-wise like `properties`, since an `extends` child declaring any would
  otherwise erase the parent's hoisted entry. Siblings written beside the `$ref`
  reach the human surfaces but not AJV, which draft-07 makes exclusive; a slot may
  add a title, not narrow the shape.

  Landing the check surfaced an abort that predates it: AJV's `addSchema`
  meta-validates and THROWS, and the throw escaped the whole analyze pass, so one
  author schema carrying `minimum: "3"` ended the run with AJV's unanchored text
  and took every other diagnostic in the file with it. A schema AJV refuses is now
  left unregistered — a `$ref` lookup entry that could not have resolved anyway —
  and reported by the anchored checks that run afterwards.

  The fragment body stays open (`additionalProperties: true`) and carries no
  literal `x-telo-*` property names. Both are load-bearing rather than incidental:
  closing it would reject the next annotation a module invents, and a `properties`
  map holding a key spelled `x-telo-ref` reads to the annotation walkers as an
  annotated node, inventing diagnostics about a slot nobody wrote. The vocabulary
  completion offers therefore lives in the analyzer (`schema-keywords.ts`), on the
  side of the boundary no manifest walk reaches.

### Patch Changes

- Updated dependencies [17584a7]
- Updated dependencies [987decd]
- Updated dependencies [d08c3bd]
  - @telorun/analyzer@0.62.0

## 0.13.3

### Patch Changes

- Updated dependencies [f4efb4b]
  - @telorun/analyzer@0.61.0

## 0.13.2

### Patch Changes

- Updated dependencies [831c0c4]
- Updated dependencies [58bc988]
  - @telorun/analyzer@0.60.0

## 0.13.1

### Patch Changes

- Updated dependencies [ccf56f5]
- Updated dependencies [35e1a58]
  - @telorun/analyzer@0.59.0

## 0.13.0

### Minor Changes

- a434722: Manifest migrations: one registry and one driver for rewriting a legacy
  spelling to the current one.

  Telo rewrote a manifest between parsing it and analyzing it in six places, and
  two different things were tangled there. Most are **normalizations** — sugar
  folded into the internal form, never written back, correctly invisible. A
  growing minority are **migrations**: an old spelling rewritten because published
  artifacts carry it and cannot be edited. Each re-invented the same four things by
  hand — where to walk, how to report without blaming a dependency the author
  cannot fix, how an author is meant to _act_ on the warning, and when the code may
  be deleted. The last two were usually skipped: a deprecation warning told an
  author something was wrong and offered no repair but hand editing.

  Adding a migration is now one JSON file in `analyzer/migrations/`. **An entry
  contains no code** — both what a rule matches and what it patches are data, so
  one file is read identically by every kernel; a predicate expressed in one
  language would mean one artifact is read two ways, invisibly, since a migration
  that succeeds is silent. JSON rather than YAML because it is the only format all
  three runtimes embed with no generation step (Rust `include_str!`, Go
  `//go:embed`, TypeScript `resolveJsonModule` and nothing else).

  - **The patch names what it targets**: `rename-key`, `set-value`, `set-tag`,
    `insert-item`, `remove-entry`. Every operation has a known YAML edit form,
    which is what makes a migration applicable to a _file_ and what lets the driver
    **derive** whether a quick fix exists — read off the verb, never declared, so a
    missing repair is stated rather than silent. A lone `set-value` yields a
    `DiagnosticFix`; anything else says `no quick fix (removes an entry) — run
\`telo migrate\``instead of offering one that would corrupt the file. A
written value must be a scalar, refused when the entry is *read*: the file
applier re-quotes a value in the author's own style at the node's own span,
which has no meaning for a mapping, so accepting one would hide the limitation
until a user ran`telo migrate` and was told, permanently, to fix it by hand.
  - **The matcher's containment is positive and required**: `inKind` names the
    document kinds a rule may touch and `under` the region within them it may
    reach; nothing outside is reachable. `under` is **anchored at the document
    root** — it names top-level keys — which is what makes that claim true rather
    than decorative: a `Telo.Definition`'s `resources:` template body carries other
    kinds' configuration, so a rule matching "any path segment spelled `schema`"
    would reach the very user JSON blob the positive form exists to keep out.
    Walking everything and subtracting cannot be made sound — the set to subtract
    is unbounded, since any kind whose config carries a user JSON blob can hold
    something shaped like the node a rule looks for — and it cannot express the
    guarantee the module surface is promised to carry. Both halves are closed
    vocabularies at every level; an unknown token is refused, `$comment` aside.
    Both gates bound the _walk_ rather than filter its output, so a document no
    rule targets is never walked and a region no rule names is never descended
    into — this runs on the kernel's boot path for every file in the graph.
  - **The phase runs in the loader**, after parse and before both the CEL
    precompile and import desugaring, so a rule only ever matches author-written
    nodes — a synthetic import manifest has no YAML document to edit, would record
    a path the file never had, and shares `variables` / `secrets` by reference with
    the module doc.
  - **Composition is the driver's guarantee**: one pass with the match set frozen
    against the pre-migration tree, rules ordered within an entry, entries
    independent. Idempotency follows from that rather than from every author
    getting it right. A patch that cannot apply in full applies not at all. A
    frozen match reaches through a sequence by index, and an index is not an
    identity, so a match under an array a sibling patch resized is refused rather
    than rewriting the element that patch produced.
  - **Rewrite always, report locally.** Every file in the graph is rewritten, so a
    module published years ago keeps loading; only the entry module's own files
    report, because a published dependency is not the consumer's to fix.
    `LoadedGraph` gains `migrationDiagnostics`, `LoadedFile` gains `migrations`.
  - **Path provenance is in the driver's contract.** Each rewrite records the path
    it matched beside the migrated one, and every downstream diagnostic is mapped
    back through it before its position is resolved — without which a key rename
    would silently downgrade every squiggle on that node to a parent squiggle, and
    let a fix among them write across a parent's span. The general index is by
    FILE, so a diagnostic that names only its file (as many do) and a rewrite in a
    document with no `metadata.name` (every `Telo.Import`) are both reachable;
    resource identity narrows within a file rather than being the only key.
  - **A migration is reported everywhere the manifest is read.** `telo run` warns
    through the kernel logger, alongside the version-hoist warning it already
    emitted — otherwise the one command an author actually uses would be the only
    surface that rewrote their manifest silently. The SDK's `check` seam remaps
    paths like every other consumer, so a module acting on `path` and an editor
    rendering a squiggle never disagree about what a manifest says.
  - **`LoadOptions.migrate`** is a new, opt-in third cache axis beside `compile`
    and `desugarImports`. Every resolved consumer passes it; a round-trip view must
    not, since the editor writes its manifest/YAML pair back on save.
    `ctx.loadModule`'s `LoadOptions` (SDK) gains the same flag.
  - **`telo migrate <paths..>`** applies pending migrations to a file, through
    byte-level splices — comments, indentation, block scalars and quote style are
    preserved, exactly as `telo upgrade`'s rewrite already is. Imported modules are
    left alone. A location whose YAML cannot carry the edit is reported rather than
    silently skipped, since the diagnostic that sent the author here says to run
    this command. Removing a mapping entry that _opens_ a sequence item
    (`- type: string`, the shape a legacy `anyOf` branch takes) splices out to the
    following key instead of deleting the line, which would take the `- ` with it.

  - **The scalar re-quoting rule and the byte-splice loop are one primitive**
    (`yaml-source-edit.ts` in `@telorun/analyzer`, browser-safe), read by the
    migration applier, `@telorun/ide-support`'s quick fix and `telo upgrade`'s pin
    rewrite. Three surfaces now write repairs into the same files; two copies of a
    subtle quoting rule would eventually quote one value two ways and nothing would
    catch it. `@telorun/ide-support` re-exports `renderFixReplacement`,
    `quoteStyleOf` and `isPlainSafe` unchanged.

  **Breaking:** `normalizeRefSlots` is removed from `@telorun/templating`. It
  dropped the legacy scalar `type:` at an `x-telo-ref` slot at every
  schema-compile site, which the shipped `ref-slot-scalar-type` entry now does once
  at load. Keeping both would have left one rewrite with two traversals that match
  different node sets, and it falsified the design's own safety property — a
  consumer who forgot `migrate` behaved identically apart from the missing warning,
  so the entry could not prove the mechanism it demonstrates. Nothing outside this
  repo is known to call it; a manifest still carrying that spelling is repaired by
  the migration on every load, and `telo migrate` fixes the file.

### Patch Changes

- Updated dependencies [a434722]
- Updated dependencies [c8d457b]
  - @telorun/analyzer@0.58.0

## 0.12.0

### Minor Changes

- 55a7bef: Make CEL diagnostics actionable, and let an instant leave an expression.

  cel-js reports one sentence for three unrelated mistakes, and two of the three
  readings actively mislead: `no matching overload for 'startsWith(dyn, string)'`
  names argument types, so the repair looks like a cast when the real fix is
  `key.startsWith('x')`; `no matching overload for 'now()'` reads as wrong arity
  when the function does not exist. Each wrong repair cost a full check cycle and
  landed back on the same message.

  Every call is now classified against the CEL function registry
  (`Environment.getDefinitions()`), which reports call form and parameters for
  cel-js built-ins and Telo's catalog alike. Name existence, call form and arity
  are decided by lookup, so nothing parses cel-js's message text and a cel-js
  version bump cannot silently degrade the classification. New codes:
  `CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`, and
  `CEL_NONDETERMINISTIC_IN_COMPILE_FIELD` (a warning: `nowIso()` in an
  `x-telo-eval: compile` field bakes once at load).

  - **Breaking:** `TemplatingEngine.analyze` returns `AnalyzeResult`
    (`{ diagnostics, type?, calls }`) instead of `EngineDiagnostic[]`. The engine
    now owns the type-check, so one expression produces one verdict against one
    environment — previously two passes with two environments let the opaque
    residual survive beside the diagnostic that explained it, and left `${{ }}`
    interpolations chain-validated but never type-checked.
  - **Breaking:** CEL failures no longer report as `SCHEMA_VIOLATION`; the
    residual type error is `CEL_TYPE_ERROR`.
  - **Breaking:** `NormalizedDiagnostic.suggestions` entries are
    `kind: "replace"` (was `"replace-kind"`).
    Diagnostics with a decidable repair stamp a generic `fix` (`{ replacement }`
    — the whole corrected value, with no sub-range) that flows unchanged to CLI
    JSON and IDE CodeActions; `UNDEFINED_KIND`'s suggestion collapses into it.
  - The VS Code extension offers those repairs as quick fixes. `ide-support`
    gains `renderFixReplacement`, which re-quotes a replacement in the style the
    author used: the span a fix replaces is the value node as written, so it
    includes the scalar's quotes (the YAML tag sits outside it), and writing a
    bare CEL expression into a quoted span would unquote text that a `: ` or a
    trailing `#` stops parsing as one scalar. Shared with the Tauri editor so
    both surfaces write a repaired scalar identically. It refuses a multi-line
    span: a block scalar's span covers its `|`/`>-` indicator and its trailing
    newline, so a single-line replacement would delete the break that ended the
    mapping entry and glue the next key onto the value — the quick fix is simply
    not offered there.
  - `telo check -o json` diagnostics gain `resource`, `path` and `fix`.
  - `telo cel functions` lists CEL's own built-ins alongside Telo's catalog,
    grouped by receiver type (appended to the `--json` array as
    `category: "builtin"`, so an existing consumer keeps working). They were
    absent entirely — which is why an author could read that command end to end
    and still call a method as a global, and why every new diagnostic pointing at
    it would otherwise have pointed at a list missing the functions it was about.
  - `CheckDiagnostic` (the SDK's static-analysis seam, `ctx.runtime.check()`) gains
    `resource`, `path` and `fix`, so a module can act on a repair instead of
    recovering it from prose. `path` travels with `fix` because the repair
    replaces the value AT that path — a consumer holding only `line`/`column`
    could not apply it to a parsed manifest.
  - CEL gains `string(timestamp)` (RFC 3339) and `int(timestamp)` (epoch
    seconds), the two conversions cel-go defines and cel-js omits. Without them
    an expiry could be computed and not stored, which is also why three parallel
    encodings of "now" exist.
  - `UNCOVERED_THROW_CODE` reports one diagnostic per `catches:` block naming
    every uncovered code and the handler, instead of one per code.

### Patch Changes

- Updated dependencies [55a7bef]
- Updated dependencies [e801bd2]
  - @telorun/analyzer@0.57.0

## 0.11.3

### Patch Changes

- Updated dependencies [0ea1b8b]
  - @telorun/analyzer@0.56.1

## 0.11.2

### Patch Changes

- Updated dependencies [8cede51]
  - @telorun/analyzer@0.56.0

## 0.11.1

### Patch Changes

- Updated dependencies [2373398]
  - @telorun/analyzer@0.55.0

## 0.11.0

### Minor Changes

- 0938ed4: A reference slot now declares what the declaring resource does with its target,
  and one shared graph answers "what calls what" for every analysis that needs it.

  `x-telo-ref` gains a structured form — `{kind, use, inputs?}` — alongside the
  bare string. `kind` takes one alias-qualified kind or a list of them, replacing
  the `anyOf` wrapping that multi-kind slots used; a schema branch per acceptable
  kind would let `use` disagree with itself, and which kinds are acceptable is a
  property of the target while `use` is a fact about the slot. `use` names when
  control reaches the target relative to the declaring resource's own invocation:
  `schema` (no instance exists), `dependency` (held and read), `call`, `detached`,
  `trigger.inbound`, `trigger.consumer`. It is a set, because one slot can
  dispatch its target more than one way in a single invocation — `Cache.View`
  calls inline on a miss and detached on a background revalidation — and a slot
  whose mode is chosen by configuration declares a map keyed on a sibling field
  (`Lease.Critical` is `call` or `detached` by its `detach:` value), whose
  selector must be statically resolvable.

  A new `Telo.Executable` built-in abstract is the parent of `Telo.Invocable` and
  `Telo.Runnable` — "control can be transferred to this" — collapsing every slot
  that spelled `Invocable | Runnable`. It is a slot constraint, never a lifecycle
  role, so `capability: Telo.Executable` remains invalid; and it never
  cross-constrains `use`, because `Ai.Model` declares `Telo.Provider` while
  exposing entry points by convention, so a nominal rule would reject a correct
  `use: call`. `Telo.Service` stays outside it: a service's `run()` is a lifecycle
  start the kernel dispatches without an ambient scope, and admitting it would
  make every step's `invoke:` accept a service.

  `buildCallGraph` builds one typed graph over two node kinds. Resource nodes
  carry declaration-site identity; step nodes carry name, lexical order, enclosing
  array and nesting parent, and only optionally an edge — a pure `value:` step
  produces a result while referencing nothing, so a graph of reference edges alone
  could not see it. Edges are `(from, slot, to, use)` and the graph is a
  multigraph: the slot path is part of an edge's identity, so `Cache.View` holding
  its `store:` as a dependency and calling its `invoke:` are two distinct edges
  even when both name the same resource. The init-order consumer projects down to
  unique pairs itself, since it is the only one for which that distinction does
  not matter.

  The dependency graph, run-reachability, and the step-invoke check now read that
  graph instead of building private walkers. Two unsound inferences go with them:
  run-reachability had been two independent over-approximations that had to agree
  by coincidence, and the step-invoke check maintained a set of capabilities it
  believed could never be invoked — a set listing `Telo.Provider`, which rejected
  the shipped `Ai.Model` wiring. Capability now decides what a resource can do; it
  no longer decides whether a slot transfers control.

  One accessor reads the annotation for every surface — the analyzer, the kernel's
  Phase-5 injection, the GUI editor's reference picker, and `ide-support`'s
  completions, hover and go-to-definition — because making the annotation
  structured changes how a slot is _recognised_, and four surfaces recognised it
  by string-matching. That fixes two pre-existing divergences: hover never peeled
  `anyOf` branches, so a multi-kind slot showed no reference at all, and
  completion stopped at the first branch, offering only an `Invocable | Runnable`
  slot's invocables.

  The annotation's own validity is enforced (`validate-ref-slots.ts`): an
  unrecognized `use` token, a structured annotation missing `kind` or `use`,
  `anyOf` branches whose uses disagree, and a case-map selector written in CEL
  are diagnostics — a typo would otherwise silently degrade a slot to the legacy
  unannotated reading, and a call graph known only at runtime is not statically
  analyzable. A case-map selector that is omitted takes its schema `default:`,
  so the common spelling (`Lease.Critical` with no `detach:`) resolves statically.

  The graph also discovers refs by value-tree scan (a `!ref` in a structure no
  annotation anticipated is an edge, read conservatively) and descends
  `x-telo-scope` arrays (a `with:`-scoped resource is a node whose own slots are
  walked, scope-local names resolving first). Init order keys on whether a site
  is a Phase-5 injection site — never on node kind — so an Application's inline
  `targets[].invoke` and gated `{ref, when}` entries order boot exactly as
  before.

  `@telorun/templating`'s `normalizeRefSlots` recognises the structured
  annotation (a presence test instead of `typeof === "string"`), so a structured
  slot's stale scalar `type` is dropped the same way a bare-string slot's is.

  The kernel rejects `capability: Telo.Executable` on a definition — it is an
  `x-telo-ref` slot constraint (the parent Telo.Invocable and Telo.Runnable
  extend), not a lifecycle role — with a named error at `create()` instead of an
  anonymous `oneOf` failure; the analyzer reports the same mistake statically as
  `CAPABILITY_NOT_DECLARABLE`.

### Patch Changes

- Updated dependencies [8a9b494]
- Updated dependencies [0938ed4]
  - @telorun/analyzer@0.54.0

## 0.10.1

### Patch Changes

- Updated dependencies [3bd2de9]
  - @telorun/analyzer@0.53.0

## 0.10.0

### Minor Changes

- bd6398e: Upgrading an import from an editor now writes the new version's integrity pin
  instead of dropping it.

  `telo module manifest --json` emits an `integrity` field — the owning
  transport's `manifestHash`, never a hash re-derived from the manifest text,
  since only the transport knows what its own reads verify against. The hub stores
  it per version and serves it from `/module/versions`, so an editor gets the pin
  in the request it already makes and no browser has to speak OCI to produce one.

  In `@telorun/ide-support`, `ModuleVersionLookup` now returns
  `{version, integrity?}` entries, and `buildImportUpgrades` reports two
  categories: imports that are behind (bumped and re-pinned in one edit) and
  imports at the newest version carrying no pin (pinned in place, matching
  `telo upgrade`'s `ensurePinned`). Pins are written in the shape the author
  wrote — a scalar shorthand takes a `#sha256-…` fragment, an object-form
  `integrity:` has its value replaced — which also lets a flow-style
  `{source: …, integrity: …}` entry be re-pointed instead of skipped. With no pin
  available for the target version the previous behaviour is unchanged: the
  version is bumped, the stale pin removed, and the host told to say so.

  A pin arriving over the network is spliced into the author's YAML, so it is
  validated before it is written: `@telorun/analyzer` exports
  `isCanonicalIntegrity`, and a value that is not `sha256-<43 base64url chars>`
  is treated as no pin rather than written through — a malformed one would
  corrupt the manifest, which is the one failure install-time verification cannot
  catch. `parseModuleVersions` (also new, in `@telorun/ide-support`) is the single
  reader for the route's body, so a host no longer hand-rolls the parse.

### Patch Changes

- Updated dependencies [bd6398e]
- Updated dependencies [f94ff85]
- Updated dependencies [0bbbc3f]
  - @telorun/analyzer@0.52.0

## 0.9.0

### Minor Changes

- c28ee72: Present OCI as the primary module ref form in CLI help and docs. `telo module`'s
  `<ref>` help text now leads with `oci://host/repo@1.2.0` instead of a `std/`
  registry ref; the bare `<namespace>/<name>@<version>` form still resolves and is
  still listed. No behavioural change — help and comment text only.
- 424aacf: Go to definition now covers kinds and CEL scope variables, not just `!ref`.

  `buildDefinition` dispatches on what the cursor sits in rather than on the field
  it happens to be under, so three symbol classes navigate:

  - **Alias-qualified kinds** (`kind: Http.Server`, `extends:`, `x-telo-ref`) jump
    to the `Telo.Definition` / `Telo.Abstract` that registers the kind, following
    `exports.kinds` re-exports to the owning module the way the kernel resolves
    the kind at runtime. `Self.<Kind>` stays in the declaring module; a
    `Telo.<Kind>` built-in has no manifest and resolves to nothing.
  - **CEL identifiers** — `variables` / `secrets` / `ports` jump to their block on
    the module doc and their member to that block's entry (`variables.port` →
    `variables:` then `port:`); `resources.<name>` and `resources.<Alias>.<name>`
    go through the same instance lookup a `!ref` uses. A chain nested inside a
    call or operand resolves too.
  - The **alias half** of any qualified value — a kind's or a `!ref`'s — jumps to
    the `imports:` entry that declares it, so `Http` and `Server` in
    `kind: Http.Server` are separately navigable.

  Signature and return shape are unchanged, so hosts pick this up without edits.

  The export gate is resolved through the analyzer's own `resolveExportedKinds`
  fixpoint and `parseExportEntry` rather than a local walk, so navigation cannot
  disagree with `telo check` about what an import exposes: `exports.kinds: []`
  gates everything while an absent block gates nothing, a kind re-exported from an
  ungated module resolves straight to it, and `exports.resources` is strict — it
  has no permissive default, so an instance the target does not export navigates
  nowhere instead of pointing at wiring the kernel refuses to resolve.

  `@telorun/analyzer` gains `CelParseError`, thrown by `CelSegment.ast()` when a
  CEL body doesn't parse. A consumer that wants to be lenient about an expression
  the author is still writing can now catch that specifically, rather than a bare
  `catch` that would also hide a defect in the AST wrapper. The third-party
  parser's own error type stays internal, exactly as its AST type does.

### Patch Changes

- Updated dependencies [424aacf]
  - @telorun/analyzer@0.51.0

## 0.8.0

### Minor Changes

- 3e9f802: Surface outdated `imports:` entries in the IDE, the way the telo editor's Imports view already does.

  `@telorun/analyzer` gains `newestModuleVersion(versions, { includePrerelease })` beside `isNewerModuleVersion`. Both halves of an upgrade check have to come from one rule: a host that decides "behind" through the shared ordering but reads "latest" off the head of a version list is answering with whatever order its index happened to return. For a module whose newest tag is a prerelease, list-order said the import was behind while the ordering rule said it was current — the same manifest against the same hub, two answers. Unparseable tags (an OCI digest, a moving `latest`) are dropped rather than ordered, and prereleases are excluded unless asked for, matching `telo upgrade`'s default. The editor's Imports view now derives its "latest" through it, so its badge no longer offers `-rc` builds as automatic upgrade targets; the per-import dropdown still lists every version for a deliberate pick.

  `@telorun/ide-support` gains `buildImportUpgrades(text, listVersions, docs?)` — a host-neutral builder that locates every `imports:` entry of a module document, asks a caller-supplied `ModuleVersionLookup` for each distinct base ref's versions, and returns the source edits that re-point the ones that are behind. Both authored shapes are handled: for the object form the now-stale `integrity:` line is deleted alongside the source rewrite, because the pin hashes the `telo.yaml` of the version being replaced and carrying it forward would turn the next install into a tamper error. An entry whose pin shares a line with other fields is reported as a skip — carrying its anchor and versions, so a host renders it in place of the upgrade affordance rather than showing nothing for an import that is behind.

  The VS Code extension renders it as CodeLenses: a summary lens on the `imports:` key (`2 imports outdated · Upgrade all`), a per-entry lens (`↑ 0.9.0 → 1.0.0`), and a warning lens for a skip. Version lists come from the hub, memoized so lens resolution stays off the keystroke path — failures are memoized too, on a shorter clock, or an unreachable hub would fire a request per base ref on every keystroke. A click that changes nothing now says which of the three reasons applied: a lookup that failed, a skip that named a reason, or genuinely current. Hub failures go to a new `Telo` output channel, reachable from the failure notification. New setting `telo.importUpgrades.enabled` turns the feature and its hub traffic off; new command `Telo: Check Imports for Updates` drops the memo and re-checks.

  `@telorun/cli` drops its private copy of the module-kind list in favour of the analyzer's `isModuleKind`.

### Patch Changes

- Updated dependencies [e52a2bf]
- Updated dependencies [3e9f802]
  - @telorun/analyzer@0.50.0

## 0.7.10

### Patch Changes

- 89ffea7: `telo run` points a manifest error at its line again, exactly as `telo check` does.

  A failure the kernel raises from static analysis converted the analyzer's diagnostics into `RuntimeDiagnostic`s while dropping their `data` — the file, the field path within it, and the owning resource. That is precisely what `findPositions` resolves a position from, so the CLI had nothing left to locate and printed the message alone. The same manifest checked with `telo check` still named the line, which made the two commands disagree about the same error.

  `RuntimeDiagnostic` gains `origin` (`DiagnosticOrigin`: `filePath`, field `path`, `resource`, and the diagnostic's own `range`), carried through verbatim so a renderer resolves `file:line:col` against the loaded graph rather than re-parsing a rendered message. `range` is what locates a failure with no field path to look up: a YAML parse error knows where the syntax broke but has no parsed tree to index.

  All four raise sites now go through one mapper (`static-analysis-diagnostics.ts`, sibling of the init-failure one): the pre-flight validation pass, Phase-3 reference resolution, YAML parse failures, and major-version conflicts. The last two used to flatten their diagnostics into a joined message string, so a syntax error and a bad `imports:` pin were the two failures `run` could not locate at all. Their `error.message` is unchanged for consumers that only read it. The loaded graph is now recorded before the parse-failure throw, since that is the failure that most needs to name a line.

  The position itself comes from `resolveRange`, the rule the VS Code extension already uses, rather than a third copy of it in the CLI: it walks parent paths when the exact field path is absent from the index (an `imports.<alias>` conflict lands on the import entry) and prefers an entry's key over its value. `resolveRange` now takes just the position half of a `DiagnosticContext`, so a caller holding only a located file does not have to invent an `AnalysisRegistry` to reuse it. A located static failure renders byte-identically under `run` and `check`. A diagnostic nothing can locate falls back to naming the resource rather than pointing at line 1 — a wrong line sends the reader somewhere the error is not. Runtime failures are unchanged: they are pinned to a resource, not to a spot in the YAML, and keep the kind + name form.

- Updated dependencies [15acf14]
  - @telorun/analyzer@0.49.1

## 0.7.9

### Patch Changes

- Updated dependencies [2ee3598]
  - @telorun/analyzer@0.49.0

## 0.7.8

### Patch Changes

- Updated dependencies [d23de89]
  - @telorun/analyzer@0.48.0

## 0.7.7

### Patch Changes

- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
  - @telorun/analyzer@0.47.0

## 0.7.6

### Patch Changes

- Updated dependencies [8353d0e]
  - @telorun/analyzer@0.46.0

## 0.7.5

### Patch Changes

- Updated dependencies [3729559]
  - @telorun/analyzer@0.45.0

## 0.7.4

### Patch Changes

- Updated dependencies [f3b044d]
  - @telorun/analyzer@0.44.0

## 0.7.3

### Patch Changes

- Updated dependencies [adc8459]
  - @telorun/analyzer@0.43.0

## 0.7.2

### Patch Changes

- Updated dependencies [de6c2aa]
  - @telorun/analyzer@0.42.0

## 0.7.1

### Patch Changes

- @telorun/analyzer@0.41.1

## 0.7.0

### Minor Changes

- 0c1c8fd: IDE completion is now driven by a read-only AST instead of line/regex/indent
  heuristics, and accepting a completion replaces the whole existing node.

  **Analyzer — read-only AST substrate.** The analyzer owns its own `yaml`-free
  node model (`AstNode` / `AstMap` / `AstSeq` / `AstScalar` / `AstPair` /
  `AstDocument`, via `parseToAst` / `documentToAst`) and a matching read-only CEL
  tree (`CelNode`, `CelSegment`, `wrapCelAst`, `buildCelSegments`), so no
  third-party AST type leaks through the public surface. `buildPositionIndex` /
  `buildDocumentPositions` now take `AstDocument` (was `yaml.Document`), and
  `LoadedFile` gains `astDocuments` — the read-only view built from the same
  parse — while `documents` stays `yaml.Document[]` for the editor's mutable
  model. `celSegments()` locates `${{ }}` / `!cel` regions in document offsets and
  parses CEL lazily; open (unclosed `${{`) regions are recovered too.

  **ide-support — AST-driven context + whole-node replacement.** `detectContext`
  resolves the cursor against the AST (`resolveNodeAtPosition`): structure comes
  from the parsed tree, and the cursor column only places empty-space key
  positions. `CompletionResult.replaceFromColumn` is replaced by `replaceRange`
  (the full source span of the value), so `kind: Sql.Co|nnection` + accept
  overwrites the whole `Sql.Connection` scalar instead of leaving a `nnection`
  suffix. Prop-key completion now works inside inline resources: a key position inside
  `mount: { kind: Crud.Resource, … }` is completed against `Crud.Resource`'s own
  schema (nearest enclosing `kind:`, path made relative to it) instead of the
  outer ref slot's `{kind, name}` shape.

  `buildCompletions` / `detectContext` accept an optional pre-parsed
  `AstDocument[]`; hosts thread the analyzer's parse in (guarded by text
  identity), falling back to a local parse otherwise.

- 2e1bb5c: Add `buildHover`, `buildSemanticTokens`, and `buildDefinition` to the
  host-agnostic IDE surface, mirroring `buildCompletions`.

  **Hover.** `buildHover(text, line, character, registry, docs?)` resolves the
  cursor with the same `resolveNodeAtPosition` machinery as completion and returns
  a `HoverResult` (markdown + source range): a `kind:` value renders the
  definition's module, capability, schema title/description, and input/output
  types; a prop key or field value renders that field's schema `description`,
  `type`, `enum`, `default`, and `x-telo-ref` constraint; a structural root key
  (`imports`, `targets`, `variables`, …) falls back to built-in docs.

  **Semantic tokens.** `buildSemanticTokens(text, registry, docs?)` returns
  registry-aware `SemanticToken`s — a `kind:` value that resolves to a known
  definition is a `type`, a `capability:` value is an `interface`, and a `!ref`
  target is a `variable` (colored from the AST because a `!ref` after a `key:` is
  claimed by the bundled YAML grammar before a TextMate pattern can reach it); an
  unresolved kind gets no token, pairing with the analyzer's `UNDEFINED_KIND`
  diagnostic. `SEMANTIC_TOKEN_LEGEND` is exported for hosts to register against a
  stock legend.

  **Go to definition.** `buildDefinition(text, line, character, graph, currentFilePath, docs?)`
  resolves the `!ref` under the cursor to its target resource's definition,
  returning a `DefinitionResult` (`{ uri, range }` at the target's `metadata.name`).
  It mirrors the `resolveRefSentinels` grammar — a bare name or `Self.name` is a
  local resource in the current module; `Alias.name` is an exported instance of the
  module the import points at, resolved through the graph's `importEdges`. The VS
  Code extension registers a `DefinitionProvider` (ctrl/cmd-click) backed by it,
  caching the `LoadedGraph` per file for the cross-module lookup.

### Patch Changes

- Updated dependencies [0c1c8fd]
  - @telorun/analyzer@0.41.0

## 0.6.0

### Minor Changes

- bdc21e9: Import-source autocomplete is now federated and ref-keyed: the
  `IdeEnvironmentAdapter` speaks the telo hub's `/refs` (fuzzy ref search) and
  `/module/versions` verbs instead of a single registry's `namespace/name` API.

  `searchRegistry` / `listRegistryVersions` are replaced by `searchRefs(query)`
  (returning `HubRef { ref, latestVersion, description? }`) and
  `listVersionsForRef(ref)` — an OCI module has no addressable `namespace/name`,
  so completion is keyed on the location ref. `importSourceCompletions` routes a
  bare word or an `oci://…` prefix to hub ref search (passing the whole prefix as
  the query, which fixes the prior `oci://` fall-through that mangled `//ghcr.io/…`
  into the registry query) and a `<ref>@<partial>` prefix to the ref's version
  list. `RegistryModule` is removed from the public types.

  Hosts (`@telorun/editor`, `@telorun/vscode-extension`) implement the ref-keyed
  adapter against their configured hub, mirroring the CLI's
  `TELO_HUB_URL` / `--hub-url` convention (default `https://telo.sh`).

  Completion labels show the `org/name@version` tail (`telorun/console@1.2.3`)
  rather than the full `oci://ghcr.io/…` ref, so the interesting part isn't
  truncated behind the transport/host boilerplate; the full ref moves to the item
  detail and is still what gets inserted. Version completions show just the
  version.

## 0.5.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [6418e2a]
  - @telorun/analyzer@0.40.0

## 0.4.45

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/analyzer@0.39.0

## 0.4.44

### Patch Changes

- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/analyzer@0.38.0

## 0.4.43

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0

## 0.4.42

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/analyzer@0.36.0

## 0.4.41

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0

## 0.4.40

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1

## 0.4.39

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/analyzer@0.34.0

## 0.4.38

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0

## 0.4.37

### Patch Changes

- Updated dependencies [2ff9027]
  - @telorun/analyzer@0.32.0

## 0.4.36

### Patch Changes

- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0

## 0.4.35

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1

## 0.4.34

### Patch Changes

- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/analyzer@0.30.0

## 0.4.33

### Patch Changes

- Updated dependencies [ebca26a]
  - @telorun/analyzer@0.29.0

## 0.4.32

### Patch Changes

- Updated dependencies [a9ac4ba]
  - @telorun/analyzer@0.28.1

## 0.4.31

### Patch Changes

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0

## 0.4.30

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/analyzer@0.27.0

## 0.4.29

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0

## 0.4.28

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/analyzer@0.25.0

## 0.4.27

### Patch Changes

- @telorun/analyzer@0.24.1

## 0.4.26

### Patch Changes

- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0

## 0.4.25

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2

## 0.4.24

### Patch Changes

- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1

## 0.4.23

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0

## 0.4.22

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/analyzer@0.22.0

## 0.4.21

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0

## 0.4.20

### Patch Changes

- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0

## 0.4.19

### Patch Changes

- @telorun/analyzer@0.19.1

## 0.4.18

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0

## 0.4.17

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0

## 0.4.16

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0

## 0.4.15

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

## 0.4.14

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1

## 0.4.13

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0

## 0.4.12

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0

## 0.4.11

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/analyzer@1.0.0

## 0.4.10

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0

## 0.4.9

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1

## 0.4.8

### Patch Changes

- Updated dependencies [c0129c0]
  - @telorun/analyzer@1.5.0

## 0.4.7

### Patch Changes

- Updated dependencies [0331069]
  - @telorun/analyzer@1.4.0

## 0.4.6

### Patch Changes

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]
  - @telorun/analyzer@1.3.0

## 0.4.5

### Patch Changes

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]
  - @telorun/analyzer@1.2.0

## 0.4.4

### Patch Changes

- 39aef08: `Telo.Application` accepts `variables:` / `secrets:` with per-field `env:` mapping; values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope before any controller or import initialises. `type:` supports `string | integer | number | boolean | object | array` — object and array values are JSON-decoded from a single env var. Coercion / schema / missing-required failures aggregate into one `ERR_MANIFEST_VALIDATION_FAILED` at load.

  `Telo.Library` variables / secrets remain pure JSON Schema property maps. An `env:` key on a Library entry is now rejected at load time with a `LIBRARY_ENV_KEY_REJECTED` diagnostic that explains importers must supply the value.

  The Telo editor's Deployment tab now renders the Application's declared environment contract above the free-form env vars list, so authors see exactly which env vars the manifest binds. The tab still drives the existing Run feature's env wiring — no manifest mutation.

  `Config.Env` is deprecated in favour of the new Application-level shape. The kind continues to work; the controller logs a deprecation notice at init and the docs page is marked deprecated. Migrating consumers is recommended but not forced.

  Diagnostics that target a missing child property now squiggle just the parent key identifier instead of the whole value block. `buildPositionIndex` additionally records map keys under the `@key:<path>` namespace, and the IDE range resolver prefers that key range when the leaf path isn't indexed.

- Updated dependencies [39aef08]
  - @telorun/analyzer@1.1.0

## 0.4.3

### Patch Changes

- e411584: Completion now works inside `x-telo-ref` slots. Two missing pieces of context made VS Code silent (and the editor app, by extension) when the cursor was inside a slot like `routes[].handler` or `steps[].invoke`:

  - **`navigateSchema` didn't peel `anyOf` / `oneOf`.** Library schemas place the slot's object form inside a combinator branch (`anyOf: [{type: string}, {type: object, properties: {kind, name, inputs}}]`), so the navigated leaf had no `.properties` of its own and `propKeyCompletions` returned nothing. The walker now traverses combinator branches at every step and, at the leaf, unions every branch's `properties` into a synthetic node (intersecting `required`). `lookupRefConstraint` is exported alongside so callers can still see `x-telo-ref` declared next to the combinator.
  - **`detectContext` didn't recognize indented `kind:` lines.** The regex was anchored to column 0 and would only fire for top-level `kind:`. A nested `kind:` inside an inline-resource shape fell through to prop-key completion which suggested it as a key, not a value. Indented `kind:` now returns a `{type: "kind", docKind, yamlPath}` context, `buildYamlPath` descends transparently through `- ` list-item markers so the array's parent key joins the path, and `buildCompletions` calls a new `AnalysisRegistry.userFacingKindsForRef(refString)` to filter the kind list to the definitions that satisfy the slot's `x-telo-ref` (abstract: implementations; concrete: itself). Falls back to the unfiltered list when the slot has no constraint or the ref can't be resolved.
  - **Completion went silent when the cursor sat on an existing property name.** `|version:`, `ver|sion:`, and `version|:` all returned nothing because `isKeyLine` only matched lines that were a bare key (no value), and `extractKeysAtIndent` was self-filtering — `version` ended up in `existingKeys` and got removed from suggestions. The key-line check now fires whenever the cursor is on the key portion of `key: value` (cursor column ≤ colon position), and the existing-keys extractors take a `skipLine` parameter so the cursor's own line is excluded from the "already present" set. Sibling keys on other lines stay filtered as before.
  - **`kind:` line treated as a value slot even when the cursor was on the key.** The detection ignored cursor position and returned `{type: "kind"}` for any cursor column on a `kind: …` line, so `|kind: Sql.Query` and `ki|nd: Sql.Query` both showed resource-kind values instead of suggesting `kind` itself. The check now respects the colon: cursor at or before the `:` falls through to prop-key completion (key-editing); cursor past `: ` triggers value completion. Mirrors the rule used for the rest of the key-line logic.
  - **`kind` / `metadata` were filtered out of root-level prop-key completion unconditionally.** A blanket `if (yamlPath.length === 0 && (prop === "kind" || prop === "metadata")) continue;` hid these even when the cursor was on the very line that owned them — so cursoring on `|metadata:` gave no suggestion to autocomplete the key. The filter is now removed; deduplication is handled by `existingKeys` (which the previous bullet's `skipLine` already excludes the cursor's own line from), so fresh docs still see `kind` / `metadata` on a blank line and existing docs don't see duplicates of keys that live elsewhere.
  - **`buildYamlPath` lost descent through `- key:` list-item headers.** When the cursor sat inside e.g. `routes[].request.method`, the walker stopped at `routes:` and missed `request`, so completion drew from the array-item schema instead of `request`'s. The list-item branch now inspects the post-dash key: when the cursor's current target indent is greater than the key's column, the descent goes through that key (`request` joins the path); when the indents match, the key is a sibling of the cursor's branch (e.g. `handler:` peer of `request:`) and is correctly skipped. `inferIndentForBlankLine` also defers to `character` when the line has whitespace — VS Code parks the cursor at the end of the indent on Enter, so the cursor's column already tells us where the user means to type.

  `packages/ide-support` gained a vitest suite (`tests/completion-anyOf.test.ts`, `tests/completion-build.test.ts`) covering every fix end-to-end.

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/analyzer@1.0.0

## 0.4.2

### Patch Changes

- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0

## 0.4.1

### Patch Changes

- @telorun/analyzer@0.10.1

## 0.4.0

### Minor Changes

- d9df589: Add autocomplete for the `source:` field of `Telo.Import`. Hosts implement a new `IdeEnvironmentAdapter` interface to supply filesystem reads and registry HTTP calls; `buildCompletions` is now async and routes a new `field-value` context to a path/registry/version branch. Completions carry an optional `replaceFromColumn` and `filterText` so hosts can replace the full typed value (paths and `namespace/name@version` ids contain `/` and `@`, which the editor's default word boundary won't cross).

### Patch Changes

- Updated dependencies [65647e0]
  - @telorun/analyzer@0.10.0

## 0.3.0

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

### Patch Changes

- 50ae578: Unify diagnostic position resolution so the Telo Editor and the VS Code extension report the same line/column for every analyzer diagnostic.

  Previously, the editor's in-memory YAML pipeline projected manifests via `doc.toJSON()` and never stamped `positionIndex` / `sourceLine` onto `metadata`. With those fallbacks missing, `normalizeDiagnostic` collapsed every analyzer diagnostic to `(0,0)` — every squiggle landed on line 1 of the file, regardless of the actual problem location. The VS Code extension didn't have this issue because it goes through `Loader.loadModuleForFile`, which stamps the metadata as a side effect of reading from disk.

  - `@telorun/analyzer`: extract the position-stamping helpers (`buildPositionIndex`, `documentLineOffsets`, `buildLineOffsets`, plus `buildDocumentPositions` / `attachPositionIndex` composers) out of the private bowels of `manifest-loader.ts` and export them. `Loader` itself now consumes the same exported helpers, so editor frontends that parse YAML in-memory can produce identically-stamped manifests without duplicating the offset / AST-walk logic.
  - `@telorun/ide-support`: `NormalizedDiagnostic` now carries the original `data` field through normalization. Editor UIs (popovers, "at &lt;path&gt;" hints, future CodeAction wiring) can read the analyzer's stamps from a single normalized shape instead of holding a raw `AnalysisDiagnostic` alongside.

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
  - @telorun/analyzer@0.9.0

## 0.2.7

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1

## 0.2.6

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0

## 0.2.4

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1

## 0.2.3

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/analyzer@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies [2e0ad31]
  - @telorun/analyzer@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0

## 0.2.0

### Minor Changes

- c97da42: New package. Editor-host-agnostic IDE support for Telo manifests: `buildCompletions(text, line, character, registry)` for completion providers and `normalizeDiagnostic(diag, ctx)` for converting analyzer diagnostics into a host-ready shape with resolved range, severity, and structured `{ kind: "replace-kind", replacement }` suggestions derived from `data.suggestedKind`. Intended to be consumed by both the VS Code extension and the telo-editor Monaco source tab.

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
