# @telorun/templating

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

## 0.16.0

### Minor Changes

- 831c0c4: A step's `retry:` is implemented in the step leaf, where all four dispatch
  branches pass through. It was previously handed to `ctx.invoke` on one branch and
  read by nothing, so a `!ref` step — the dominant shape — silently got a single
  attempt however many it asked for. It takes `Http.Request`'s field names
  (`attempts`, `initialDelay`, `factor`, `maxDelay`, `jitter`), because two
  spellings of backoff in one standard library make the word change meaning with
  where it is written; `delay` survives as the older duration-string spelling, and
  a malformed one throws instead of falling back to a silently different backoff.
  A domain failure is retried; a cancellation and a contract violation
  (`ERR_INPUT_INVALID` and its siblings) are not — the latter is a property of the
  manifest, so every re-attempt fails identically and the budget is spent between
  a typo and the message naming it. `InvokeByNameOptions.retry` is removed: the
  leaf owns the policy now, and a key nothing reads is a second inert way to ask
  for it.

  A resolution failure — `ERR_RESOURCE_NOT_FOUND`, `ERR_RESOURCE_NOT_INVOKABLE` —
  joins the contract errors as unretryable: a misspelled target does not become
  spelled correctly after eight seconds of backoff.

  `InvokeStepState` gains `invokeCtx`, so the wait between attempts is cancellable.
  Every other point in a sequence already was — the kernel refuses a dispatch
  reached after the tree was cancelled — but a backoff is time inside the leaf,
  where that gate cannot see it and the ambient context store is deliberately not
  on the SDK surface, being one runtime's mechanism. The failure that caused the
  wait rides on the cancellation as `data.pendingFailure` rather than being lost
  to it.

  A dispatch site is now one shape the analyzer owns —
  `telo://manifest#/$defs/InvokeStep`, `{ invoke, inputs, when, retry, name? }` —
  referenced by every `Run` step array and by an Application's `targets:` instead
  of being hand-restated by each composer. The runtime always had exactly one
  (`InvokeStep` / `executeInvokeStep`); only the schema half was duplicated, and it
  had drifted, which is why `retry:` worked in a sequence step and was a schema
  error one line away at boot. Boot targets now accept it, and the boot runner
  forwards the whole entry rather than rebuilding it field by field, which is what
  had been dropping the field it did not know about.

  The fragments live in `@telorun/analyzer` because the editor validates in a
  browser through it and the analyzer cannot depend on the kernel; they moved off
  `@telorun/templating`, which no longer exports `ResourceRefSchema`,
  `ManifestRootSchema` or `MANIFEST_SCHEMA_URI` — import them from
  `@telorun/analyzer` (or the kernel's re-export). They are expanded in place at
  load — for every consumer, ungated: they are the analyzer's own closed set
  rather than authoring sugar, and the editor's schema resolver handles
  document-local refs only and throws on anything else. They are merged with their
  siblings so a `$ref` composes on draft-07, stamped with the fragment they came
  from, and the set is deep-frozen so an embedder cannot rewrite it in place.
  `builtins.ts` embeds an expanded copy, since it is not a manifest and never meets
  the loader.

  That stamp replaced `x-telo-retry`, which is removed: the analyzer reports
  `LIVE_VALUE_RETRIED` where a `live` value is passed to a
  dispatch that may repeat — a stream is consumed by reading, so a re-attempt would
  pass nothing. Neither half names a kind: the value's liveness comes from its
  value type, and the re-attempt from the shape the field was declared with, which
  also says where the budget is — a policy object's `attempts` or a bare count —
  so the deprecated scalar spelling is covered with no special case. Read on the
  step and on the invoked target alike, and only when the budget is a statically
  known non-zero. The chain root resolves against the enclosing kind's own
  `inputType` as well as the step map: the shape a live value takes when it was
  produced outside the resource forwarding it.

  CEL's `slice` is overloaded by parameter type, so a wrong receiver is rejected.
  It returns `dyn`: cel-js refuses a `dyn` parameter variant alongside concrete
  ones, and concrete returns would resolve an untyped receiver to whichever
  overload registered first and mistype it — slicing an untyped byte buffer came
  back `string`.

## 0.15.0

### Minor Changes

- ccf56f5: Value types can declare which of their type parameters is the **element** — what
  iterating a value of that type yields. `Telo.Stream`'s `of` is the first entry to
  carry it, and the Rust reader accepts the key so both runtimes keep reading the
  identical vocabulary.

  The analyzer consumes that rather than naming a type: `x-telo-context-element-from`
  resolves an element as an array's `items`, else the argument bound to whichever
  parameter the resolved value type declares as its element. It also resolves the
  collection chain through a kind's declared `inputType`, not just the legacy
  `inputs:` property map — without which `item` was silently untyped in every kind
  that declares a contract. A new `x-telo-context-collection-from` types a binding
  that names the collection itself and withholds it when the resolved type is
  `live`, since re-exposing a cursor a consumer is draining is unsafe.

  `checkSchemaCompatibility` and `celTypeSatisfiesJsonSchema` now distribute over
  union branches instead of returning compatible the moment either side is one — a
  mismatch is reported only when no source-branch/target-branch pair agrees. A
  union used to switch both checks off by construction, which is exactly what a
  slot admitting several shapes needs them for.

  A union-typed slot can now hold a whole-field CEL expression at all. Both
  placeholder paths — `celPlaceholderForSchema` and the kernel's twin in
  `schema-compiled-values.ts` — handed such a leaf a stand-in no branch accepts,
  so a field declared `anyOf: [array, boolean]` was statically and dynamically
  unwritable as an expression; a slot whose union happened to contain a `live`
  branch escaped only by accident. Both now take the first branch that yields a
  placeholder, and the kernel resolves which branch a value was written against
  through the analyzer's newly exported `selectUnionBranch`, so the static and
  dispatch halves cannot disagree.

  CEL gains `slice(sequence, start, end)` over strings, bytes and lists, plus
  `bytesFromBase64` / `bytesToBase64`. The existing `base64Encode` / `base64Decode`
  keep their UTF-8 string-to-string meaning and are documented as text-only.

## 0.14.0

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

- c8d457b: One value-type annotation: `x-telo-type` says what a value IS, and the
  vocabulary is data both runtimes read.

  Three annotations answered one question — _what is the value at this slot, beyond
  what JSON Schema's `type` vocabulary can say?_ — and each answered it
  differently: `x-telo-type: TcpPort` (a nominal brand from a closed kernel table),
  `x-telo-binary: true` (raw bytes, the one annotation that emitted validation
  code), `x-telo-stream: true` (a live handle, exempt from schema walks). They
  differ in _posture_ toward the JSON Schema layer — refine, replace, exempt — not
  in kind, so a fourth cost eleven files across four packages, and three defects
  followed from the spread: an unrecognized brand degraded silently, a byte slot's
  expression typed as `dyn` because nothing consulted `x-telo-binary`, and a module
  string-matched the keyword because a module may import `@telorun/sdk` and there
  was nothing there to read.

  - **The vocabulary is DATA; the binding to a language is not.** A type is one
    JSON file under `sdk/value-types/`, copied into the SDK by its `prepare` and
    embedded by Rust with `include_str!` — the `analyzer/migrations/` arrangement,
    for the same reason. An entry declares `name`, `representation` (`json` + a
    `base`, or `instance` + a symbolic `binding`), `live`, `parameters` and a
    `description`, and nothing about any runtime. Each runtime carries its own
    table mapping `binding` to its own identity; a binding with **no row is a hard
    startup error**, never a skipped assertion, because a type that cannot be
    asserted would silently exempt every slot declaring it.
  - **`registerTeloKeywords`** replaces five drifted AJV registration sites — the
    analyzer's `createAjv` and the kernel's `schema-validator`, `resource-context`,
    `observed-state` and `manifest-schemas`, which registered overlapping lists of
    twelve, four, one and one. Drift there is not cosmetic: a keyword that emits
    code was simply missing from any instance that forgot it, so one schema
    validated two ways depending on which AJV saw it.
  - **Exemption is a property of the TYPE, not of a position.** The old walk
    neutralized only a key it found in a `properties` map, so an array-of-streams
    element was reached and left constrained even though it descended into `items`.
    Reading liveness off the declared type makes an item, a union branch and a
    property one case. It is exemption from **validation**, never from **typing**:
    a live type's arguments still travel through every schema-typing walk.
  - **Value types are generic.** An entry declares named type parameters and the
    annotation's object form supplies arguments — `{ name: Telo.Stream, of:
Telo.Bytes }`. An argument is a schema node, so it nests with no new grammar,
    and a bare name is sugar for a node carrying only the annotation, normalized in
    the single reader. Comparison is **covariant and gradual**: an omitted argument
    is _any_ in both directions, so every producer and consumer that has not
    declared an element keeps checking exactly as it did. A definite conflict is
    `CEL_TYPE_ARGUMENT_MISMATCH`, reported where a produced value's schema meets a
    consuming slot's — a step's `inputs:` against the invoked target's contract,
    which is the one place both halves are in hand.
  - **A shape is named with `!ref`**, Telo's one reference grammar, and `use:
schema` has been in the `x-telo-ref` vocabulary for exactly this relation all
    along. The loader normalizes it to the canonical `telo:<module>/<Type>` `$ref`
    — authoring surface and internal form, the split `resolveRefSentinels` and
    `resolveSchemaRefKinds` already have. Normalizing rather than inlining is what
    preserves schema identity (the compiled-validator cache is keyed on it) and
    leaves a recursive shape expressible; carrying the owning module is what makes
    resolution alias-aware, where matching a bare `metadata.name` across a
    flattened list silently dropped the alias.
  - **A tag's produced type is declared by its ENGINE.** `TemplatingEngine` gains
    `producedType()`; `!include-bytes` declares `Telo.Bytes` and `!include-text`
    declares `type: string`, and `substituteCelFields` loses its tag-name branch —
    the only place a tag's produced type was written down, written in the consumer.
  - **`X_TELO_TYPE_UNKNOWN`** (Levenshtein-suggested) and
    **`X_TELO_TYPE_ARGUMENT_UNKNOWN`** replace the silent degrade, on every
    schema-bearing field of every manifest — not only definition docs, since an
    inline `inputType:` on an ordinary resource carries a schema too.
  - **The migration selector gains a schema region.** `inSchema: true` bounds a
    rule to the kernel's own schema-valued keys, and only with it may `inKind` /
    `under` be `["*"]`, and only for a rule keyed on an `x-telo-*` annotation. That
    pairing is the containment: an annotation keyword occurs in author-written
    schema fragments inside ordinary resource documents, and that set of kinds is
    open, so enumerating it would be both incomplete and a violation of the
    topology-driven constraint.

  **Breaking:** `x-telo-binary` and `x-telo-stream` are rewritten to `x-telo-type`
  at load by the `normalize-value-types` migration, so every published manifest
  keeps working and `telo migrate` repairs a file in place. `binaryKeyword` /
  `isBinarySlot` / `X_TELO_BINARY` are removed from `@telorun/analyzer` in favour
  of `registerTeloKeywords` and the SDK accessors; `withStreamPropertiesSkipped` is
  now `withLiveValuesSkipped`. Value brands are `Telo.`-qualified (`TcpPort` →
  `Telo.TcpPort`), which the same migration rewrites.

## 0.13.0

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

- e801bd2: Embed a file that ships beside the manifest, with `!include-text` and `!include-bytes`.

  A brand font, a background SVG, a `.sql` file, a system prompt — each is a file
  next to `telo.yaml`, and until now there was no way to make one a manifest
  value. `Fs.File` reads at _invocation_ time, resolves against the process cwd
  rather than the module, and cannot supply a field read at construction; pasting
  base64 into a scalar is unreviewable and contradicts the rule `x-telo-binary`
  exists to enforce — that bytes always arrive by reference and are never authored
  inline.

  ```yaml
  kind: PdfMake.Document
  fonts:
    Brand:
      normal: !include-bytes assets/Brand-Regular.ttf
  background:
    svg: !include-text assets/page-background.svg
  ```

  - **Paths are module-root-relative**, never relative to the file the tag was
    written in. That is the rule a controller's `path=` qualifier and
    `files:`/`assets:` patterns already follow, and it is what makes a path mean
    the same thing after publish, which inlines every `include:` partial into a
    single published `telo.yaml` — a per-file-relative path would silently move,
    passing `telo check` locally and failing only for consumers.
  - **Confinement is decided from the written path alone** (`INCLUDE_PATH_INVALID`,
    `INCLUDE_PATH_ESCAPES_MODULE`), so the browser-side analyzer enforces it
    without a filesystem. The kernel re-checks rather than trusting that
    `telo check` ran. A computed path is deliberately not expressible: a file that
    ships inside the artifact has a name known at publish time, so the dynamic
    case belongs to `Fs.File`.
  - **The read happens when the resource holding it is created**, not at manifest
    load — `telo.yaml` is its own artifact layer precisely so reading a manifest
    cannot pull the payload, and an app loads every imported library's manifest.
    A `with:`-scoped resource pays only when its scope runs. An embed on a doc
    that is never instantiated is therefore read by nothing, and reported
    (`INCLUDE_OUTSIDE_RESOURCE`) rather than silently ignored.
  - **Publish adds a named file to the artifact automatically** — nothing is
    restated in `files:`.

  Payload membership is now one generic mechanism rather than two derivations that
  happened to agree:

  - `TemplatingEngine` gains an optional `fileClaims(source)` hook, so an engine
    declares what its tag embeds. The `ref-slot.ts` precedent: one accessor on the
    contract, no consumer pattern-matching a shape.
  - `collectModuleFileClaims` (`@telorun/analyzer`, browser-safe) is the single
    reader — engine claims plus the controller `path=`/`siblings=` claims, each
    carrying its path, layer role and selector. Deliberately **not** part of
    `analyze()`, whose pass is flattened and import-inclusive: its claims would
    mix in imported libraries' files and would make packaging depend on resolving
    the whole import graph.
  - **Breaking:** `partitionLayers` takes that claim set instead of manifest text,
    and `unmatchedSiblings` entries carry `origin` (was `purl`). `readControllerClaims`
    moves out of the CLI. Publish now recognises neither a PURL nor a YAML tag, and
    refuses to publish when a named file does not exist.

  **Fixed: an imported library measured module-relative files from the CONSUMER's
  directory.** An import's child `ModuleContext` carried the importing manifest's
  URL rather than the library's own, and `source` is what every module-relative
  reference resolves against. So a library reading its own asset looked in the
  app's directory — and if the app happened to have a file at the same relative
  path, it silently got the app's. This was never specific to embeds: it is the
  same `source` `ctx.resolveModuleFile` reads, so `Http.Static`, `mcp-client`,
  `assert`'s manifest loader and `Test.Suite` were mis-resolving for an imported
  library too, and one fix covers all of them. It also contradicted packaging,
  which is per-module and had already placed the library's file in the library's
  own artifact.

  **Fixed: a file embed's type is now checked statically.** `substituteCelFields`
  collapsed every tagged sentinel to a slot-shaped placeholder — right for `!cel`,
  whose type is only derivable from the expression, wrong for these two, whose
  result type is a constant of the tag. So `!include-bytes` at a `type: string`
  slot passed `telo check` and failed at resource creation, and the reverse did
  too. The substitution now uses the real type, and AJV plus the existing
  `x-telo-binary` keyword reject both directions with no new diagnostic code.

  Two latent bugs surfaced and are fixed, both from config-resident values that
  previously could not exist:

  - The CEL expansion walker rebuilt **any** object from its entries, so a byte
    buffer in a config field would have reached the controller as `{"0":137,…}`
    with nothing raising. It now recurses only into plain containers, the rule
    `precompileDoc` already followed.
  - The same rule fixes a stack overflow: a template kind expands
    `${{ self.connection }}` to a live `ResourceInstance`, whose object graph is
    cyclic.

  The Rust half mirrors the tag set and the path grammar, and resolves
  `!include-text` at resource creation. `!include-bytes` fails there with an
  explicit message: that kernel carries a manifest as JSON, which has no value for
  raw bytes.

## 0.12.0

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

## 0.11.1

### Patch Changes

- 89ffea7: Upgrade `uuid` to v14, clearing the deprecation warning on `npm i -g @telorun/cli`.

  `uuid@10` is deprecated upstream ("uuid@10 and below is no longer supported"), and since `@telorun/cli` depends on `@telorun/templating`, npm printed that warning on every global CLI install. The CEL stdlib calls `v1`/`v3`/`v4`/`v5`/`v6`/`v7`/`validate`/`version` with no options or caller-supplied buffers, so none of the breaking changes between v10 and v14 — CommonJS removal, the `v1`/`v7` internal-state refactor, the `offset` bounds check on `v3`/`v5`/`v6` — reach any call site. v14 requires Node 20+ and TypeScript 5.4+, both below what this repo already demands.

  The `@types/uuid` devDependency is dropped: uuid has shipped its own types since v11.

## 0.11.0

### Minor Changes

- ab4a911: Add `sum(list): double` and `avg(list): dyn` CEL reducers (siblings of `min` / `max`), so a list of numbers can be folded in any CEL expression. `sum` returns 0 for an empty list; `avg` returns null for one (hence the `dyn` return, like `min` / `max`, so null-safety applies). These back the new `std/collection` module's aggregation kinds, and are usable in any manifest CEL.

## 0.10.1

### Patch Changes

- 9a92bf1: Align CEL aggregate-literal type-checking with cel-go: disable
  `homogeneousAggregateLiterals` so heterogeneous list/map literals unify to `dyn`
  instead of erroring. Previously a map literal whose value type was inferred as
  `dyn` (the common manifest case — `result.rows`, `request`, …) still rejected a
  differently-typed entry (e.g. `{'id': r.id, 'done': r.done == 1}` →
  `Map value uses wrong type, expected 'dyn' but found 'bool'`) even though the
  runtime evaluates it fine. This was a static-vs-runtime false positive; cel-go
  defaults this check off for exactly this reason.

## 0.10.0

### Minor Changes

- 0c16f41: Move the CEL regex functions onto the RE2 contract. `regexReplace`,
  `regexExtract`, `regexExtractAll`, and `regexGroups` are now backed by
  [`re2js`](https://github.com/le0pard/re2js) — a pure-JS port of Google's RE2 —
  instead of JS `RegExp`. Because it's pure JS (no native addon), regex behaves
  identically under Node, Bun, and the browser, with RE2 semantics: linear-time,
  no backtracking (ReDoS-safe), inline `(?s)` and `$1` replacement backrefs, and
  the `i` / `m` / `s` flags. The three extract functions gain an optional trailing
  `flags` argument.

## 0.9.0

### Minor Changes

- aaa760d: Add eight pure (browser-safe, non-host) CEL standard-library functions to the single-source catalog, so both the runtime and the analyzer pick them up automatically:

  - **Indexing** — `range(int): list<int>` (the one previously-missing primitive: materializes indices for an unknown-length list, e.g. `range(size(xs)).map(i, …xs[i]…)`) and `enumerate(list): list` (pairs each element with its zero-based position as `{index, value}`).
  - **Regex** — `regexReplace(s, pattern, replacement, flags?)` (replaces every match by default, `$1` backrefs), `regexExtract`, `regexExtractAll`, and `regexGroups`.
  - **Affixes** — `trimPrefix` / `trimSuffix` strip a fixed affix when present.

## 0.8.0

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

## 0.7.0

### Minor Changes

- 2292a84: Upgraded cel-js package to 7.6.1

## 0.6.0

### Minor Changes

- 06cfcbf: Expand the CEL stdlib:

  - **Time:** `nowIso(tz?)` (ISO-8601, UTC by default or in an IANA timezone), `today(tz?)` (`YYYY-MM-DD` in that zone), `nowMillis()` / `nowSeconds()` (absolute epoch int).
  - **UUID:** `uuidv1/3/4/5/6/7()`, `uuidValidate(s)`, `uuidVersion(s)`.
  - **Strings:** `lower`, `upper`, `trim`, `replace(s, old, new)`, `split(s, sep)`.
  - **Math:** `abs`, `floor`, `ceil`, `round`, `min(list)`, `max(list)`.
  - **Collections:** `distinct`, `sort`, `reverse`, `flatten`.
  - **JSON / encoding:** `parseJson(s)`, `base64Encode/Decode`, `urlEncode/Decode`.
  - **Hashing:** `md5`, `sha1`, `sha512`, `hmac(algorithm, key, message)` (host-injected alongside `sha256`).
  - **Null handling:** `default(value, fallback)`, `coalesce(list)` — CEL has no `??`.

  Time/UUID/`nowMillis` are non-deterministic: in an `x-telo-eval: compile` field they bake once at load; use a runtime field for a fresh value per evaluation. Hashing and base64 are host-injected to keep `@telorun/templating` browser-safe (the kernel supplies Node `crypto`/`Buffer`); `buildCelEnvironment` now accepts a partial handler map. Adds `uuid` as a dependency.

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

## 0.5.0

### Minor Changes

- 64debb5: Add the `!sql` templating engine for safe, dialect-neutral SQL interpolation. A `!sql "… ${{ expr }} …"` scalar evaluates to a parameterized value — literal fragments plus the separately-evaluated value of each interpolation — instead of a joined string, so consumers can emit driver-native placeholders and bind the values rather than splicing them into the SQL text.

  Supporting additions: `@telorun/sdk` gains an optional `parts` field on `CompiledValue` (an interpolated template's segments before they are joined) plus the shared `ParameterizedSql` type and `isParameterizedSql` guard (the marker contract producers and consumers single-source). `@telorun/templating` adds `toParameterized(value, ctx)`, which splits a value into `{ fragments, values }` and backs the new engine.

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Minor Changes

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
  - @telorun/sdk@0.13.0

## 0.3.1

### Patch Changes

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

## 0.3.0

### Minor Changes

- 7889023: Add `!ref <name>` YAML tag for resource references (additive foundation).

  - **templating**: Register a new `ref` engine alongside `cel` and `literal` so `!ref <name>` parses to a `TaggedSentinel` with `engine: "ref"` and the bare resource name as `source`. Adds `isRefSentinel(v)` to detect ref-tag sentinels. Adds a shared `ResourceRefSchema` fragment plus `MANIFEST_SCHEMA_URI` (`telo://manifest`) and `ManifestRootSchema` — the canonical JSON-Schema home for ref-shape definitions that module YAMLs can `$ref` into. The symbols intentionally omit a host-specific prefix since they live in the templating package (the only layer both analyzer and kernel depend on); the URI is the contract.
  - **analyzer**: Recognises `!ref` sentinels at every `x-telo-ref` slot. A new `resolveRefSentinels` pass runs after inline normalization and substitutes each sentinel in-place with `{kind, name}` so downstream phases (reference validation, dependency graph, kernel controllers) see a uniform shape regardless of which surface the user picked. The substitution descends the manifest tree directly and mutates the parent container — no concrete-path string round-trip — so a future change to the field-path encoding can't silently break the writer. `validate-references` emits `UNRESOLVED_REFERENCE` when a sentinel doesn't resolve locally; `dependency-graph` adds boot-order edges for sentinel-named targets. `precompile` leaves ref sentinels intact (they are identity markers, not templating values, and must reach the resolution pass before being collapsed). A new `system-kinds.ts` consolidates the kind-skip sets the three passes (`REF_VALIDATION_SKIP_KINDS`, `DEPENDENCY_GRAPH_SKIP_KINDS`, `REF_RESOLUTION_SKIP_KINDS`) draw from so the asymmetries are named, not implicit. The analyzer's AJV instance now registers `ManifestRootSchema` under `telo://manifest` so module schemas can `$ref` shared fragments without bundling their own copy. The `Telo.Application.targets[]` schema admits both the legacy string form and the post-resolution `{kind, name}` object form, so `!ref <name>` works at that slot too.
  - **kernel**: `SchemaValidator` registers the same `telo://manifest` root so resource-config validators resolve the shared `$ref`. `ResourceContext.resolveChildren` handles `!ref` sentinels that reach a controller directly — currently a stopgap for slots hidden behind a local `$ref: "#/$defs/..."` that the analyzer's field-map walker doesn't descend; see follow-up below. `Kernel.load()` normalises `Telo.Application.targets[]` entries down to bare resource names whether the source surface was a string or a sentinel-resolved `{kind, name}` object — and now throws `ERR_INVALID_VALUE` on an entry it can't normalize rather than silently dropping it.

  **Follow-up (separate PR):** enable the analyzer's reference-field-map walker to follow local `#/$defs/<name>` refs. The walker already descends `oneOf`/`anyOf`/`allOf` variant properties in this PR; the remaining gap is the early-return on `$ref` (the recursion + cycle-detection plumbing is in place but the descent branch is disabled). Turning it on without first updating `Run.Sequence`'s controller (and any other dispatcher with the same pattern) to route through `EvaluationContext.invokeResolved` regardless of Phase-5 instance injection regresses the kernel's `<Kind>.<Name>.Invoked` event emission — sequence steps call `instance.invoke()` directly when handed a live instance, bypassing the kernel's emit path. The walker fix and the dispatcher fix have to land together; once they do, the `!ref` fallback in `ResourceContext.resolveChildren` becomes dead code and can be removed (preserving the polyglot contract where every controller — Node or otherwise — sees only `{kind, name}` at ref slots).

  The legacy ref shapes (bare-name strings and `{kind, name}` objects) are unchanged and continue to work. This change is non-breaking — no existing manifests, schemas, or controllers need to migrate yet. A subsequent migration sweep will convert every module schema to `$ref: "telo://manifest#/$defs/ResourceRef"` and rewrite example/test manifests to `!ref`, after which the legacy paths can be removed.

### Patch Changes

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

## 0.2.3

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.2

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.1

### Patch Changes

- 30bcfef: Catch references to nonexistent step results in Run.Sequence-shaped manifests at static-analysis time.

  Two analyzer gaps let a broken CEL chain like `steps.parseManifest.result.docs[?0].?kind` slip past `telo check` and only fail at runtime with `No such key: parseManifest`:

  - `@telorun/analyzer`: `buildStepContextSchema` registered every named step in the steps map, including control-flow wrappers (`try`, `if`, `while`, `switch`, `throw`) that never produce a result. With a permissive `result: { additionalProperties: true }` placeholder under each wrapper, the chain validator treated every typo or stale reference as valid. Now only steps that carry an `invoke` field register a result-producer entry; wrappers are still descended into via `x-telo-topology-role: branch`, so their inner invokes are unaffected.
  - `@telorun/templating`: `extractAccessChains` only descended into `node.args` when it was an array. cel-js represents unary operators (`!_`, `-_`) with a single `ASTNode` directly in `args`, so any chain inside `!(...)` or `-(...)` was dropped from validation. The walker now also descends when `args` is a single `ASTNode`.

  Both fixes are needed for the typical "negated optional-access chain in a try-wrapped step" pattern (e.g. an `if: "${{ !(steps.<wrapper>.result.docs[?0].?kind ...) }}"` predicate).

## 0.2.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.
