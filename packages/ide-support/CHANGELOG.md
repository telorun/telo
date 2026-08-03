# @telorun/ide-support

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
