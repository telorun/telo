# @telorun/analyzer

## 0.63.0

### Minor Changes

- 7463386: Declarative SQL schema support.

  - **SDK**: the duration grammar gains a day unit (`30d`), so a grace window can be
    written as one, and its error message lists it. Grace windows are measured in days and every other duration in
    the runtime already goes through this one parser.
  - **Kernel**: member access on a resource instance reads its **published state**.
    A ref slot holds the live instance after Phase-5 injection, which CEL cannot
    read a member off at all, so a template body could not read a scalar off a
    resource it references. `self.<ref>.<field>` now answers exactly as
    `resources.<name>.<field>` does — the same fact, the same reading. A whole-value
    `${{ self.connection }}` is unchanged: that form is navigated directly and still
    yields the instance itself.
  - **Analyzer**: `x-telo-schema-map` / `x-telo-schema-projection` let a kind whose
    configuration is a collection of typed entries declare what that collection
    means as a JSON Schema object, and `x-telo-schema-projection-from` lets a
    consumer type a slot from the declaration it references. Generic over typed-field
    declarations — nothing in them says SQL, column or table. `SCHEMA_PROJECTION_INVALID`,
    `SCHEMA_MAP_INCOMPLETE` and `SCHEMA_PROJECTION_FROM_UNRESOLVED` report a projection
    that would silently type nothing — on the declaring side and the consuming side
    alike, since the consuming side is where the typing is actually wanted.

- 321f153: Durable execution: the replay seam, the normative contract, and the step engine's journaling.

  `@telorun/sdk` gains `DurableRunHandle` — `step(path, target, inputs, execute)`, `decide(path, kind, compute)`, `park`, and the `writesInside(zone)` question — plus `stepPath` and the collapse rule. The handle rides `InvokeContext.durable`, which the kernel carries and never calls: it is a pure conduit, so a backend is an ordinary module and this member deliberately does not cross the ABI.

  `step` mediates execution rather than merely recording it. Lookup-plus-record is a leaky decomposition — two halves of one operation, split so the CALLER performs the effect in between — which silently fixes the step engine and the resource graph in one process. Where an effect executes is a real architectural axis, so `step` takes a declaration-site target identity even though the local backend resolves it in process.

  The step engine now journals its DECISIONS, not only its outcomes: resolved inputs, predicates, loop conditions, switch keys and pure value steps. A run's replay-closed state is its journal, which is what makes replay a pure function of `(journal, manifest)` — recording only outcomes would leave every decision re-derived in a fresh process from a scope carrying live readings.

  The analyzer gains `validate-durable-regions`: `DURABLE_DETACH_FORBIDDEN`, `DURABLE_NONDETERMINISM` (keyed on `idempotent`, where it states something true) and `DURABLE_UNJOURNALABLE_RESULT`. All are consumers of the one containment walk, parameterized over a zone attribute, so no kind is named in analyzer code.

  Normative contract: `kernel/specs/durable-execution.md`.

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

- 7463386: A DECLARATION-derived contract (`x-telo-schema-projection-from`) is now resolved
  at dispatch as well as at `telo check`. It was static-only, which is a contract
  with a hole exactly where a value is COMPUTED rather than written: a misspelled
  column written as a literal was rejected, and the identical key arriving from a
  CEL expression reached the database — which for a repository kind means arbitrary
  caller text in a SQL identifier position.

  `ProjectionScope` becomes a resolver over the raw slot value rather than a list of
  manifests, because the two hosts see different things there: the analyzer sees the
  `{kind, name, alias?}` reference, while the kernel binds contracts after Phase-5
  injection has replaced it with the live instance. That also makes reference
  resolution alias-aware, so an unambiguous `!ref Alias.users` is no longer refused
  as ambiguous merely because two libraries each export a `users`.

  `x-telo-schema-projection` is read from `schema:` as well as from the kind
  document and reported when it is found there — ignoring a misplaced annotation
  moved the failure onto the consumer's slot and blamed the wrong author.

  A ref slot inside a kind's `schema:` is typed as the published reading it yields,
  so `self.<ref>.status.<field>` is checked instead of being read off the annotation
  node. The runtime view is memoized against a publication counter rather than
  rebuilt on every dispatch.

  A resource rule that throws or exhausts its budget is anchored on the declaring
  definition, and is a warning rather than an error when that definition belongs to
  a published dependency — an error there blocked `telo check` on a line the
  consumer could not change.

  A projection that cannot resolve at dispatch now raises
  `ERR_SCHEMA_PROJECTION_UNRESOLVED` instead of leaving the slot open — the
  analyzer's report is entry-module-scoped, so a dependency's consumer slot was
  unreported at both ends. Rule-declaration validation reads the same merged schema
  the evaluation reads, so a rule declared on an abstract resolves its `in:` pointer
  against the fields a child declares.

  `telo publish` reads the npm controller candidates it may push from the PURL
  parser it already uses, and the self-pin rewrite is anchored on the `controllers:`
  scalars, so a PURL mentioned in a description is no longer a rewrite target. Its
  package directory comes from the candidate's `local_path` rather than an assumed
  layout, an unreachable npm registry is no longer read as "not published", and a
  malformed `package.json` fails instead of silently skipping the pin stamp.

- c7fdbd9: `x-telo-referrer-rules`: a kind declaring, as data, what must be true of whoever
  references one of its resources — the mirror of `x-telo-resource-rules`, which
  relates the fields of one resource and so cannot reach across a reference.

  Declared by the kind that HAS the requirement rather than the one that must
  satisfy it, which is what makes it sound: written on the referring side, a rule
  must name the target kind as a string, and a manifest spells a kind with the
  alias its own author imported it under — so such a rule silently passes on every
  manifest that picked a different alias. Declared on the referenced kind, the
  subject is chosen by the reference itself and no kind literal appears there at
  all. It is also the only direction that scales: a third-party mount carries its
  own requirement without the server kind learning it exists.

  In scope: `self` (the referenced resource) and `referrer` (the one that reached
  it). The optional `referrer:` filter names a kind in the alias-qualified grammar
  `extends:` uses, canonicalized in the declaring scope; a filter that resolves to
  nothing is reported at the kind, since it would match nothing and leave the rule
  inert. Violations are reported on the referrer at the slot path that reaches the
  resource, under `REFERRER_RULE_VIOLATED` with the author's own code in
  `data.rule`; `REFERRER_RULE_UNEXERCISED` reports a rule nothing ever matched,
  which is what a typo in `referrer:` looks like from the outside.

  Polarity, the host-backed and non-deterministic refusals, the condition cache and
  the 50 ms budget are shared with resource rules rather than reimplemented.
  Guide: `docs/extend/referrer-rules.md`.

- 7463386: `x-telo-resource-rules` — a kind declaring, as data, relationships between the
  fields of ONE resource that JSON Schema cannot state: an index naming a column
  its table does not declare, a foreign key whose two sides differ in length, a
  `renamedFrom:` pointing at a column the table still declares. Every rule of that
  form was previously a controller guard at boot, which needs a database to run at
  all, fires in several cases only after an earlier phase has already changed it,
  and is invisible to the editor.

  The predicate is CEL rather than a closed vocabulary of named rules. Correlating
  two collections — a foreign key's own columns against its own references, not
  every other key's — is the part a pointer language gets wrong, and a
  comprehension closure gives it for free; `"id" in self.columns` reads map keys,
  so a `*`-means-keys grammar never arises. The vocabulary is borrowed from
  `Telo.JsonSchema.rules` (`condition` TRUE when the rule HOLDS, the subject bound
  as `this`, plus `code` and `message`), because two CEL rule vocabularies with
  opposite polarity is a trap an author falls into once per rule.

  `in:` names the collection to iterate and IS the diagnostic's anchor, so a
  reported path exists by construction; omitting it gives the whole-resource form
  that a `severity: warning` on a discouraged value wants. Violations report under
  one analyzer-owned `RESOURCE_RULE_VIOLATED` with the author's code in
  `data.rule`, keeping the diagnostic-code namespace closed.

  Both ways coverage can vary invisibly are reported rather than dropped:
  `RESOURCE_RULE_SKIPPED` when a value the condition reads holds a `!cel`
  expression (per element, narrowed to the nodes the condition actually reads), and
  `RESOURCE_RULE_UNEXERCISED` when a rule's collection was empty on every resource
  of its kind. Rules may not call host-backed or non-deterministic functions, and
  are budgeted at 50 ms per resource. Guide: `docs/extend/resource-rules.md`.

- 321f153: Retry parity: a step's retry policy gains `nonRetryable` (error codes that end the loop immediately) and a step gains a per-attempt `timeout:`.

  The leaf's built-in exclusions are the ones decidable without judgement — cancellation, and the kernel's verdicts on the shape of the call. Whether a DOMAIN failure is worth re-attempting is not decidable there at all, so without `nonRetryable` every terminal domain failure was retried to exhaustion. It sits as a sibling of the shared `RetryPolicy` fragment rather than inside it (the way `Http.Request.retry` adds `honorRetryAfter`), because it matches an error CODE while an HTTP retry classifies on a response STATUS.

  `timeout:` bounds ONE attempt, matching Temporal's start-to-close, and is enforced by cancellation: the step mints a scope linked to the caller's token and threads it into the dispatch, so a target that honours cancellation stops rather than running on unobserved. On elapse the step fails `ERR_STEP_TIMEOUT` — a code of its own rather than a cancellation, since the two want opposite follow-ups and `catch:` can only tell them apart by code.

- 9ac2b8a: The step grammar becomes shared vocabulary, and its execution moves to the SDK.

  `$ref: "telo://manifest#/$defs/Step"` on an array's items declares a step body —
  `invoke` / `value` / `if` / `while` / `switch` / `try` / `throw`, the
  `steps.<name>.result` accumulator and the `error` variable inside a `catch:`. Any
  kind can carry one now; a composite kind that wraps a region of work no longer
  needs a `!ref` to an executable and a second document to hold it. The grammar was
  declared four times inside `modules/run/telo.yaml`, and `$defs` are local to the
  schema that declares them, so four kinds in one module could not share one.

  `StepEngine` moves from `modules/run` to `@telorun/sdk` beside the
  `executeInvokeStep` leaf it already delegated to, against a structural context
  (`StepEngineContext`) so it depends on neither the kernel nor `run`. The SDK is
  the one name the bundle loader symlinks onto the kernel's own copy, so the engine
  is one version per process and reachable from a controller bundle and the
  kernel's boot runner alike.

  Two consequences for a kind author. `while/do` is admitted in every step body —
  a fragment cannot be narrowed by its consumer, and the copies that dropped it did
  so editorially rather than for soundness. And `x-telo-step-context` is now the
  legacy spelling: it is read forever (published artifacts carry it, and no
  migration entry can synthesize a `$ref`) but a new step body is declared by
  pointing at the fragment, which the derived `x-telo-fragment: Step` stamp makes
  recognizable with no marker to remember.

  A forward-declared `requires.telo` lower bound is now its own verification state.
  Adopting new syntax means declaring the release that will carry it, so on that
  commit the edge names a version npm does not have — and spawning
  `npx @telorun/cli@<unpublished>` there produced an `ETARGET` wrapped in install
  noise, reported as "could not run", indistinguishable from being offline. The
  registry is now asked before any edge runs, such an edge is never spawned, and it
  is reported as `pending` alongside the latest published version (which is what
  makes a typo'd bound visible). Informational in `telo release check`, fatal in
  `telo publish`, where npm has already published and the floor must exist.

- 321f153: Zone attributes: a body slot that establishes an execution zone can now declare what the region guarantees about everything inside it.

  `x-telo-provides-zone` gains an object form carrying its correlation key as `key` beside the attributes — `atomic`, `idempotent`, `noSuspend`, `replayed`. The vocabulary is CLOSED and ships as data (`sdk/zone-attributes/*.json`), so both kernels read one vocabulary rather than one written in TypeScript; each attribute's value is the author's REASON, which whatever enforces it quotes verbatim, and `requires:` on an entry compiles to JSON Schema's `dependentRequired` so `atomic ⇒ noSuspend` lives in the data rather than in a validator.

  The analyzer gains a downward **containment walk** (`findZoneRegions`), parameterized over the attribute that opens a region rather than over any kind, plus `ZONE_ATTRIBUTE_UNKNOWN` and `ZONE_ATTRIBUTE_INCOMPLETE`. The kernel gains `ctx.zoneAttributes()`, which resolves the attributes off the declaring kind's schema — never off the `ZoneEntry`, which stays three identities so it remains ABI-serializable — and returns them without branching on any name.

### Patch Changes

- 321f153: Durable-execution correctness fixes found in review.

  **A live value is now actually refused.** `assertJournalable` used `JSON.stringify`, which SUCCEEDS on a stream and returns `{}` — so the case the contract names first was recorded as an empty object and replayed as one. Detection is now structural, through the value-type vocabulary's own binding table, and lives in `@telorun/sdk` because it is a property of the contract rather than of one journal. The static half is only a warning precisely because "the runtime is the gate"; the gate was open.

  **`DURABLE_NONDETERMINISM` reads parsed call sites** (`auditCalls`) instead of a regex over CEL source. A regex fires on a name inside a string literal and on an unrelated receiver method, and re-derives what the registry's `deterministic` flag already answers — the text-matching this repo retired elsewhere.

  **`ctx.zoneAttributes` resolves along `extends`** so a child inheriting a zone-providing slot reports what that slot declares, and no longer memoizes an unresolved kind (which would make a transient miss permanent).

  **A step with no name is refused** rather than defaulting to an empty path segment, where two such steps would share one journal key and the second would be handed the first's result. The shared `Step` schema requires `name`, so a manifest cannot reach this; a caller assembling steps in code can.

  Also: the CEL walk now stops at a nested `{ kind }` declaration rather than reporting that resource's expressions against its enclosing one, and the unused `zoneAttributesSchema()` is removed — the property it was meant to guarantee (the `atomic ⇒ noSuspend` rule living in the data) is already true, since the validator reads `requires:` off the entry.

  - @telorun/templating@0.16.0

## 0.62.1

### Patch Changes

- afb2b05: Publish the manifest the payload builder produced.

  The `layers:` index was injected into `telo.yaml` during the push, after the
  builder had already returned the manifest — so for every module shipping a
  payload layer, the text a dependent hashed to derive its import pin was a
  document no registry holds. 18 standard-library modules carried a pin that
  could not resolve, and their consumers failed at load with an integrity error
  naming a republish that never happened.

  `ModulePayloadBuilder` now writes the index, so `publishedManifest()` returns
  the shipping bytes. That requires layer framing to be a pure function of the
  files it covers: `makeTarGz` pins every tar header field that is not the name
  or the contents, which also makes artifacts reproducible. The index itself
  comes from the transport (`Transport.layerIndex`), which owns that framing, and
  publish now verifies each pushed blob against what the manifest already claims
  rather than rewriting it.

  Modules shipping a payload must republish — the wrong pins are in artifacts
  that cannot be edited.

## 0.62.0

### Minor Changes

- 17584a7: Every author-written name is now checked, and the convention behind it is stated
  in one sentence: **case encodes what a name denotes.** PascalCase names a type —
  a module `metadata.name`, a kind name, an import alias, or a resource whose
  capability is `Telo.Type`. camelCase names a value — a resource instance, a `Run`
  step, a `variables:` / `secrets:` / `ports:` key, a CEL binding.

  That distinction is the only thing separating `kind: Console.WriteLine` from
  `!ref Console.writeLine`, which are character-identical grammars, and the pair is
  not hypothetical: it is the sanctioned singleton shape, where a library declares
  `kind: Self.WriteLine`, exports the instance and withholds the kind. The docs
  previously recommended PascalCase for instances on a CloudFormation logical-ID
  analogy — the wrong precedent, since CFN logical IDs sit in a dedicated `!Ref`
  slot with no expression language beside them, while a Telo name _is_ a CEL
  identifier and sits next to `variables.` in the same expression.

  Three tiers, each with a different severity, because they fail in different ways:

  - `INVALID_NAME` (error, every surface) — not `^[A-Za-z_][A-Za-z0-9_]*$`, or a
    CEL keyword.
  - `INVALID_TYPE_NAME` (error) — a type-level name not starting uppercase.
  - `NAME_CASE_CONVENTION` (warning) — a value-level name not starting lowercase.

  The grammar tier is an error because the name is otherwise unreferenceable _or
  silently mis-referenced_. Probed against the CEL engine the runtime actually
  uses: `resources.in` and `resources.2fa` are ParseErrors, but
  `resources.my-server.url` **evaluates**, as `resources.my - server.url`. Where a
  bare name is in scope — which `x-telo-bindings-from` deliberately makes possible
  — a hyphenated resource name therefore yields a wrong number with no diagnostic
  anywhere. This replaces the old dot-only `INVALID_RESOURCE_NAME`, which was the
  strictest special case of the same rule; checking one character while the rest
  went unchecked is what left the hole. The reserved set is the whole keyword list
  rather than the subset today's parser rejects in field position (`for` and
  `package` currently parse) — which keywords tokenize there is a property of a
  dependency, and a name that breaks on a parser upgrade was never safe.

  The type-case tier is an error rather than a warning because half the reference
  grammar already rejected the alternative: `EXTENDS_ALIAS_PATTERN` hard-rejects
  `extends: foo.Bar`, while nothing rejected the `metadata.name: foo` that produced
  it. A lowercase kind is a kind nothing can extend, so this only moves an existing
  failure to where it is fixable. Value-level case stays a warning, Rust's
  `non_snake_case` posture: a name is occasionally dictated from outside and Telo
  has no way to silence a diagnostic locally.

  Only the **first character** is checked. The type/value signal is all it carries,
  and a full pattern would relitigate `httpApi` vs `httpAPI` and `OAuthClient` vs
  `OauthClient` while rejecting an all-acronym type name like `SQL` or `AI`. There
  is deliberately no quick fix: a `DiagnosticFix` is a whole-value replacement for
  one node, and a rename is correct only when every reference moves with it.

  Scoped to the entry's own modules at every tier, errors included — a published
  dependency's naming is not the consumer's to fix — and a name synthesized by
  inline extraction is skipped, since the author never wrote it. Step names come
  from the call graph rather than a walk of their own, which already owns the
  analyzer's only step-array recursion and carries each step's name, owner and
  concrete path.

  Two latent bugs surfaced in this repo: the `workflow` and `workflow-temporal`
  modules were stragglers from the module-name PascalCase migration, and a hub step
  named `record-failure` could never have been read as `steps.record-failure.result`.

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

- d08c3bd: Add declared runtime requirements: a module states, in a top-level `requires:` block,
  the range of Telo it is verified against.

  Telo closes every extension vocabulary and rejects an unknown token, which is right for
  a typo and wrong for a version — so a module adopting new syntax broke on older runtimes
  with a message blaming its own author. A declared range turns that into one accurate
  diagnostic (`MODULE_REQUIRES_NEWER_RUNTIME`), and stops `telo upgrade` selecting versions
  the running Telo cannot read at all.

  `telo:` is a semver range over the manifest surface generation — one scale every kernel
  reports, so there is no range per kernel — and host requirements nest under `host:`, where
  `node` is the only axis for now, since an axis is added when something compares it and not
  before. `^` and `~` are rejected: pre-1.0 they allow only one minor, and Telo
  ships breaking changes as minor bumps, so they would pin a module to a single release
  generation. An upper bound must name a version that already exists.

  The claim is verified by running the CLI at each edge of the declared range, in
  `telo publish`'s preflight and across the workspace in `telo release check`. A module
  declaring nothing carries no requirement.

### Patch Changes

- @telorun/templating@0.16.0

## 0.61.0

### Minor Changes

- f4efb4b: A module-owned library is resolved at load through the import graph instead of
  being copied into every dependent's controller bundle, and a module builds one
  bundle rather than one per kind.

  Both halves fix the same defect: a bundle is a module graph, so a shared source
  file compiled into two bundles is two module scopes, and any state a module keeps
  beside its instances — a registry, a `WeakMap`, a counter — silently becomes two
  of them. `sql` had six controller bundles and therefore six copies of its
  connection registry.

  - A module's kinds now select their controllers out of its single bundle with the
    PURL fragment (`…&local_path=./nodejs/src/index.ts#SqlQueryController`).
  - A `Telo.Library` may declare `exports.code:` — entries naming the bare
    specifier dependents import it by and the file that resolves to
    (`{ specifier, format, path, source }`, plus `os` / `arch` / `libc` for a
    native entry). The kernel joins that to the consumer's `imports:` during
    `load()` and resolves the import to that module's own entry point.
  - The artifact spec gains a `library` layer role, per selector, carrying that
    entry point; a file claimed as both a controller and a library entry ships in
    the library layer, and materializing either code role pulls both plus `common`.
  - Three build-time guards keep the property from decaying: importing a subpath of
    a declared specifier, reaching a declared library's entry-source directory by
    any other route, and inlining a module-owned library the manifest never
    declared an import for — each a hard build error rather than a silent extra
    copy. The last is the one that matters most: the other two are derived from the
    `imports:` edges, so they are vacuous exactly where the mistake is made.
  - An unknown layer role in a published index is now skipped rather than rejected,
    so a module that gains a layer for a newer runtime does not become unreadable
    on an older one.

  Deduplication is per (module, resolved version): two dependents pinning different
  versions of one library still resolve two copies — that is different code — and
  the kernel warns rather than pretending otherwise.

## 0.60.0

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

- 58bc988: One release system for Telo modules, in the CLI: `telo release add | status | order | check | apply | verify`, over the modules discovered inside a workspace declared by a `telo-workspace.yaml`. A module has one version across `telo.yaml`, `nodejs/package.json` and `rust/Cargo.toml`, and one changelog.

  A Telo module's artifact **embeds its dependencies** — esbuild inlines a sibling library's source into the controller bundle, and publish pins each relative import to a hash of the sibling's manifest — so bumping the dependents is a correctness requirement rather than a courtesy. Neither previous ledger could see that: changie has no dependency graph, and changesets' stops at the npm boundary. Two mechanisms now cover it. A **payload digest**, exact and taken from the bytes, decides _whether_ a module bumps, so it fires for an inlined sibling, a shared-library fix and a lockfile-only transitive bump alike. An **edge graph**, built from the controller build's own metafile plus in-repo relative `imports:`, decides _at what level_, mirroring a dependency's level onto its dependents. A digest that moved with nothing to attribute it to takes a patch and is reported as unattributed rather than passing silently. Both are recorded in `.changes/ledger.yaml`, so the PR gate and the publish gate compute the same number — and the PR gate needs no credentials, which is what lets a fork run it.

  Three changes make the published bytes a pure function of the commit, which is what makes "the same number" true rather than aspirational. Import pins are **authored and verified, never discovered**: `telo publish` no longer fetches a hash for an unpinned remote import (previously best-effort, so one commit produced different bytes depending on network reachability, and an unresolvable import shipped silently unpinned) — it refuses one, and verifies the pins the author wrote. Manifest re-serialization is unconditional. And a relative sibling's pin is derived from the sibling's own locally-built published bytes, in topological order, so a whole release batch is plannable offline.

  The controller layer is now **built by the kernel on the publish path**, as it already was on the run path (`buildControllerBundle`), instead of read as a prebuilt `.mjs` staged by `pnpm run build:bundles`. The shipped bytes and the digested bytes are the same bytes by construction, and the edge graph gets its metafile from the same run. On this path a host without esbuild is a hard failure rather than a fallthrough to a possibly-stale file.

  New CEL binding **`module.<field>`** — the declaring module's own `metadata`, typed per field and closed, so `module.version` reads a module's version instead of restating it and `module.verison` is a diagnostic. An imported library reads its own metadata, not its importer's; the loader's derived stamps (`source`, `sourceLine`, …) are filtered out.

  `ModuleFileClaim` for a bundled controller now carries `localPath`, the source its entry point is built from. `assertWithinModule` aggregates missing payload files into one message and takes a set of paths whose content the caller supplies in memory — a built controller entry point is gitignored and legitimately absent, so the guard runs _after_ the build rather than demanding a prestep that no longer exists. `--frozen` is removed from `telo publish`: it selected between best-effort pinning and a hard error, and best-effort is gone.

  `Output` gains `progress()`, a stderr write gated on the stream being a TTY. `errLine` must write in every format because silencing it loses the reason a command failed; a progress tick explains nothing, so its gate is whether a human is watching rather than which format was asked for.

### Patch Changes

- Updated dependencies [831c0c4]
  - @telorun/templating@0.16.0

## 0.59.0

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

- 35e1a58: A produced value is normalized to the representation its contract declares, so
  the declaration is true rather than merely satisfied.

  A declared shape says what a value IS, not only what it must pass — the service
  a JSON Schema gives an HTTP response serializer. Telo's CEL layer already took
  it literally: `type: integer` types as CEL `int`, and a CEL int is an int64. A
  controller handing back a plain JS number at such a slot therefore made its own
  contract a lie that surfaced nowhere until an expression composed it —
  `!cel "steps.call.result.n + 1"` type-checked statically and then died at
  dispatch with `no such overload: dyn<double> + int`, which is what pushed
  authors to `double(...)` and `int(...)` casts an int64 should never need.

  `declaredScalarPaths` (analyzer, browser-safe) reads the declared representation
  off a contract schema, and `bindContract` normalizes the produced value along
  exactly those paths. It is **representation-driven, not integer-specific**: a
  value type is read through the same rule rather than beside it, so a `json`
  representation contributes its `base` (`Telo.TcpPort` is an int64 slot) while an
  `instance` one replaces the JSON layer — bytes and streams are already their own
  representation, nothing converts to them, and the walk stops rather than
  descending into a value that is not a plain container. `type: number` is the
  symmetric case and normalizes the other way.

  Only an EXACT conversion is performed. An integral number becomes an int64; an
  int64 becomes a double only when the round-trip is lossless. A fractional number
  at an integer slot, a string, a magnitude no double can hold — all arrive
  unchanged, so a value that genuinely violates the contract is still rejected
  rather than quietly repaired, and a 64-bit integer is never truncated to reach a
  `number` slot. Bounded by the schema, so a contract declaring no such scalar
  walks nothing at dispatch.

  **Outputs only, deliberately.** Normalization states what a value is to whoever
  reads it next. On the way out that reader is CEL, which already types the
  declaration as `int` — there the declaration and the value genuinely disagree.
  On the way in it is a controller written in the host language, where handing it
  an int64 would change the authoring surface of every module rather than repair a
  false declaration.

  **This changes what crosses a module boundary.** A controller that reads another
  resource's declared-integer output with `Number.isInteger(...)`, `setTimeout`, or
  plain arithmetic now receives an int64 and must accept both representations —
  `integerInput` (new, `@telorun/sdk`) is that read. Modules in this repo are
  fixed; a published module doing the same breaks until republished.

### Patch Changes

- Updated dependencies [ccf56f5]
  - @telorun/templating@0.15.0

## 0.58.0

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

### Patch Changes

- Updated dependencies [a434722]
- Updated dependencies [c8d457b]
  - @telorun/templating@0.14.0

## 0.57.0

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

### Patch Changes

- Updated dependencies [55a7bef]
- Updated dependencies [e801bd2]
  - @telorun/templating@0.13.0

## 0.56.1

### Patch Changes

- 0ea1b8b: A library's CEL is no longer validated against the importing application's variable contract.

  An application analysis is flattened: `selectModuleManifestsForAnalysis` forwards an imported library's `Telo.Definition` / `Telo.Abstract` / `Telo.Import` docs and the instances named in its `exports.resources`, and drops the library doc itself — so the only module doc in the set is the entry's. The per-resource validation loop already skipped forwarded exports for precisely that reason ("their kind/CEL are authored in that module's scope"); the CEL pass did not, so a forwarded export's `variables.x` was chain-checked against the consumer's `variables:` block.

  That was wrong in both directions. A library reading a variable it declares and the app does not reported `CEL_UNKNOWN_FIELD` — a hard error, with no author-side fix, that only appeared once the library was imported and only for reads in a slot carrying an `x-telo-context` (a `Run.Sequence` step's `inputs:`), since a plain resource field types `variables` permissively and never rejects. In the other direction, a library reading a variable it never declared passed silently whenever the app happened to declare that name.

  `selectModuleManifestsForAnalysis` now carries the declaring module's `variables` / `secrets` / `ports` blocks across as `metadata.moduleGlobals` — the only point where a manifest and its module doc are both in hand — and the CEL pass types each resource's globals from its own module. The read is still checked; it is checked against the right contract.

  Skipping forwarded exports in the CEL pass would not have been equivalent: it retires every other diagnostic for them (`CEL_SYNTAX_ERROR`, `CEL_NULLABLE_ACCESS`, `CEL_IN_NON_EVAL_FIELD`, `UNKNOWN_ENGINE`, `OBSERVED_STATE_*`), and `OBSERVED_STATE_NEVER_RUN` is answerable only in the consumer's analysis, since a library declares no `targets:` of its own.

  `resources` is deliberately left open for a forwarded manifest rather than narrowed to a carried name list: the flat list holds only the library's exported instances and no `with:`-scoped ones, so any list built from it would report names that exist as missing.

  - @telorun/templating@0.12.0

## 0.56.0

### Minor Changes

- 8cede51: Add `x-telo-binary: true` — a declared identity for schema slots carrying raw bytes.

  Bytes have no JSON Schema type. `type: object` was the closest fit and it costs a real check: every object satisfies it, so a mistyped literal at a byte slot passed `telo check` and failed inside the controller. `type: binary` is not an alternative — AJV refuses to _compile_ an unknown type, with no setting to allow it, and a published `telo.yaml` would stop being JSON Schema for the hub, the editor and any third-party reader. An `x-` keyword is ignored by unaware tooling by specification, so it degrades to "unconstrained" instead of "cannot validate this kind at all".

  The accessor and the AJV keyword live in `analyzer/nodejs/src/binary-slot.ts` (browser-safe), registered by the analyzer's `createAjv()` and by every kernel AJV site. Three details are load-bearing: the keyword is AJV **codegen** rather than a `validate` function, so it inlines into the standalone validators the kernel compiles and caches; `celPlaceholderForSchema` hands a CEL leaf at a byte slot a real `Uint8Array`, so the static and runtime rules are one rule rather than two kept in step; and it is exempt from `stripTeloAnnotations`, whose premise was that no annotation affects the validator — stripping it would silently reduce the slot to an empty schema.

  What this buys is a check no JSON Schema type expresses: **bytes always arrive by reference**, so an inline literal at such a slot is rejected statically, and a non-byte value from a CEL expression is rejected by the input contract at dispatch instead of reaching a controller.

  Note for schema authors: a union with a byte branch must use `anyOf`, never `oneOf`. A consumer that does not know the keyword reads the branch as an empty schema matching everything, so under `oneOf` a plain string would match both branches and fail.

## 0.55.0

### Minor Changes

- 2373398: Close the validator-cache warm gaps that made `telo run` recompile — and try to rewrite — schema validators on every boot, producing EACCES noise on a read-only image even after `telo install` had warmed the cache.

  - The validator cache key now describes what AJV compiles, with `x-telo-*` annotations stripped before hashing. The analyzer canonicalizes `x-telo-ref.kind` to `<module>.<Kind>` and the warm pass bakes that view, while the kernel's controller registry keeps the authored `Self.<Kind>` — two keys for one validator, so every kind whose schema declares an alias-qualified ref missed on every boot. Data-bearing keywords (`const` / `default` / `enum` / `examples`) and name-keyed maps (`properties`, `$defs`, …) are exempt from the strip, so an annotation-shaped key inside a matched value or a property name survives.
  - Contract validators (`inputType` / `outputType`) are warmed from the resolved schema the runtime compiles, through the same resolver (`resolveTypeFieldSchema`, extracted from `ResourceContextImpl`) plus the `x-telo-stream` skip. The warm previously compiled the raw declaration — `{kind: Telo.JsonSchema, schema: …}`, not a JSON Schema — and baked a validator no dispatch would ask for. Resource-level narrowings are warmed too, not only kind-level declarations.
  - Named types are registered before the contract warm, from the module graph rather than the flattened view, so a contract written as a `$ref` to one resolves the way it will at runtime. Flatten forwards every module's definitions but only the entry's resource instances, and a named type is a resource instance — a library that declares its shapes once and `$ref`s them (`oauth-client`, `vector-store`) had no type doc in the warm's view at all.
  - `AnalysisRegistry.resolveSchemaTypeRefs(manifests)` canonicalizes `telo://Self/<type>` references in a caller's own projection of the manifest set, in each doc's declaring scope. `analyze()` already did this to its internal view; the warm holds a separate projection, where an un-canonicalized `$ref` resolved to nothing while the runtime resolved it fine.

### Patch Changes

- @telorun/templating@0.12.0

## 0.54.0

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

- Updated dependencies [0938ed4]
  - @telorun/templating@0.12.0

## 0.53.0

### Minor Changes

- 3bd2de9: Modules now report which kernels can run them, and deprecation is structured
  rather than prose.

  `telo module manifest --json` gains a `runtime` block classifying every kind by
  the kernels that can host it, derived from its `controllers:` PURL candidates:
  `pkg:cargo` runs on both kernels (the Node kernel builds the crate as a napi
  addon, the Rust kernel opens it as a cdylib), `pkg:npm` and a bundled
  `pkg:telo/local/js` on Node alone, and a format no kernel hosts contributes
  nothing. Telo is polyglot, so this is a capability rather than trivia — without
  it a consumer composing for the Rust kernel is offered kinds it cannot load.

  The classification is per KIND, and the module roll-up distinguishes full from
  partial coverage, because coverage genuinely differs within one module:
  `std/console` ships Rust controllers for two of its four kinds, so a boolean
  would claim the whole module runs on the Rust kernel. A kind declaring no
  controllers is reported as `portable` — no kernel constraint — rather than
  having today's kernels enumerated into it, which would make the record wrong
  the day a third kernel ships. Language is tracked as a separate axis from
  runtime and is left blank for a `napi`/`wasm` bundle, whose source language the
  PURL does not determine.

  `@telorun/analyzer` gains the first validation of the `metadata:` block on
  `Telo.Application` / `Telo.Library` docs, which previously had no schema at all.
  Known fields are type-checked, the vocabulary stays open, and an unknown key is
  reported only when it is a near-miss of a known one — nothing in the kernel
  reads these fields, so a mistyped `licence:` or `deprecatd:` has no runtime
  failure mode and would otherwise ship unnoticed.

  Two new fields are recognized: `metadata.homepage`, and `metadata.deprecated`
  with a `reason` and an optional `replacedBy`. The replacement is resolvable
  rather than free text, and its form follows the level — a module doc names
  another module ref, a kind doc names an alias-qualified kind (`Self.Migrations`,
  `Telo.JsonSchema`) resolved through the declaring file's own imports, exactly as
  `extends:` is. `INVALID_DEPRECATION` and `DEPRECATION_REPLACEMENT_UNRESOLVED`
  report a replacement a consumer could not follow.

## 0.52.0

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

- f94ff85: `x-telo-context-from-root` now resolves a `telo#Type` slot to the schema it names, which **tightens an existing check**.

  A type field is written as an inline `{ kind, schema }` wrapper, a `!ref` to a named type, or a bare name. Pointing the annotation at one used to type the CEL variable as the _wrapper_ — exposing `kind` / `schema` instead of the contract — and forced every such variable to be an object, so a scalar contract could not be expressed at all. It now resolves to the declared schema. A raw JSON Schema still resolves to itself and a plain property map is still used verbatim.

  **This can turn a previously-passing manifest into a `telo check` failure.** `Telo.Definition`'s built-in context types a template body's `inputs` with `x-telo-context-from-root: "inputType"` — a type slot. Where that resolved to the wrapper (which declares no `type` / `properties`), `inputs` was typed permissively and any member access passed; it is now typed from the declared contract, so `inputs.<typo>` inside a template definition's `inputs:` / `resources:` body is a `CEL_UNKNOWN_FIELD`. The diagnostic is correct — it catches real typos that used to reach runtime — but it is a new failure on unchanged input, which is why this is a minor rather than a patch. A definition whose `inputType` is undeclared is unaffected (the annotation falls back to an open schema).

  This is also what lets `Collection.Fold` type `acc` from its declared `accType`, including a scalar accumulator.

- 0bbbc3f: Named CEL bindings: a kind can declare a `bindings:` map whose names are in scope inside its own expressions.

  A kind opts in with `x-telo-bindings-from: "<field>"` on the `x-telo-context` node of every field that sees the names — the same annotation family as `x-telo-context-from` / `x-telo-context-element-from`, so no kind is named in analyzer code. `analyzer/nodejs/src/cel-bindings.ts` (exported as `resolveBindingOrder` / `findBindingSites` / `bindingContextProperties` / `bindingPathChain` / `schemaAtChain`) derives each binding's dependencies from the **root of every member-access chain its expression parses to** — never from a token scan, which would read `inputs.total` as depending on a sibling binding named `total` and reject a correct manifest — merges the names into the CEL context so they type-check, and reports `BINDING_CYCLE`, `BINDING_NAME_RESERVED` (any name `buildCelEnvironment` already binds at that site, kernel globals included, plus CEL's keywords, which can never be read as a reference) and `BINDING_FIELD_AMBIGUOUS` (a kind whose contexts point the annotation at two different fields).

  The kernel adds `ctx.bindScope(bindings, scope)` (`ControllerContext` / `EvaluationContext`), which extends a scope with accessor properties evaluated lazily and memoised per returned scope, so a binding nothing reads is never evaluated and one read repeatedly is computed once. `expandWith` merges such a scope by property descriptor rather than by value — copying the values would force every getter at merge time — so the returned scope must reach `expandValue` by identity. A name already in scope is skipped, the caller's own and the **ambient globals on the context** alike, which bounds a reserved name the static check did not foresee to a dead binding rather than a hijacked global. A binding that reaches itself raises `ERR_BINDING_CYCLE`.

  `x-telo-step-context` accepts an optional `value` field naming the step key that produces a result without dispatching. Such a step registers `steps.<name>.result` typed from its expression when that expression is a plain chain into something already typed (an earlier step's result, the kind's `inputType`), and permissively otherwise.

### Patch Changes

- @telorun/templating@0.11.1

## 0.51.0

### Minor Changes

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

- @telorun/templating@0.11.1

## 0.50.0

### Minor Changes

- e52a2bf: `telo publish`: a bundled controller's entry point no longer has to be restated in `files:`.

  `controllers:` already names it, so it joins the payload from there — matching the module-artifact spec, which defines a controller layer by its candidates' entry points and says nothing about `files:`. A module whose only payload is its controller now declares no `files:` at all, and `files:` keeps its role for what the manifest cannot otherwise name: assets, static files, sidecars. Symlink confinement moved from the pattern match to the whole partition, so it covers every file that actually ships.

  `telo publish` also refuses to publish changed bytes at an unchanged `metadata.version`. A bundle inlines its dependencies, so a fix in a shared TS library — or a transitive bump the lockfile alone moved — changes a module's shipped bytes while touching no file under its own directory and moving no package version; no path-scoped rule and no version ledger can see that, and the fix would ship to nobody. Publish now builds the payload and compares each layer's `integrity` digest against the artifact already published under that version, naming the digest that moved. Exact rather than inferred: it cannot miss what no version records, and identical bytes hash identically so it cannot fire spuriously.

  The analyzer accepts `local_path` as a known qualifier on a bundled-controller PURL. It names the source `path=` was built from, contributes nothing to the layer selector, and is inert in a published artifact.

- 3e9f802: Surface outdated `imports:` entries in the IDE, the way the telo editor's Imports view already does.

  `@telorun/analyzer` gains `newestModuleVersion(versions, { includePrerelease })` beside `isNewerModuleVersion`. Both halves of an upgrade check have to come from one rule: a host that decides "behind" through the shared ordering but reads "latest" off the head of a version list is answering with whatever order its index happened to return. For a module whose newest tag is a prerelease, list-order said the import was behind while the ordering rule said it was current — the same manifest against the same hub, two answers. Unparseable tags (an OCI digest, a moving `latest`) are dropped rather than ordered, and prereleases are excluded unless asked for, matching `telo upgrade`'s default. The editor's Imports view now derives its "latest" through it, so its badge no longer offers `-rc` builds as automatic upgrade targets; the per-import dropdown still lists every version for a deliberate pick.

  `@telorun/ide-support` gains `buildImportUpgrades(text, listVersions, docs?)` — a host-neutral builder that locates every `imports:` entry of a module document, asks a caller-supplied `ModuleVersionLookup` for each distinct base ref's versions, and returns the source edits that re-point the ones that are behind. Both authored shapes are handled: for the object form the now-stale `integrity:` line is deleted alongside the source rewrite, because the pin hashes the `telo.yaml` of the version being replaced and carrying it forward would turn the next install into a tamper error. An entry whose pin shares a line with other fields is reported as a skip — carrying its anchor and versions, so a host renders it in place of the upgrade affordance rather than showing nothing for an import that is behind.

  The VS Code extension renders it as CodeLenses: a summary lens on the `imports:` key (`2 imports outdated · Upgrade all`), a per-entry lens (`↑ 0.9.0 → 1.0.0`), and a warning lens for a skip. Version lists come from the hub, memoized so lens resolution stays off the keystroke path — failures are memoized too, on a shorter clock, or an unreachable hub would fire a request per base ref on every keystroke. A click that changes nothing now says which of the three reasons applied: a lookup that failed, a skip that named a reason, or genuinely current. Hub failures go to a new `Telo` output channel, reachable from the failure notification. New setting `telo.importUpgrades.enabled` turns the feature and its hub traffic off; new command `Telo: Check Imports for Updates` drops the memo and re-checks.

  `@telorun/cli` drops its private copy of the module-kind list in favour of the analyzer's `isModuleKind`.

### Patch Changes

- @telorun/templating@0.11.1

## 0.49.1

### Patch Changes

- 15acf14: `telo check` no longer re-downloads every import on every run.

  It built its `Loader` from `[LocalFileSource, ...transports]` — `LocalManifestCacheSource` was absent, and nothing wrote the cache afterwards. So every `oci://` and registry import was pulled from the origin on every invocation, including fully digest-pinned ones whose bytes cannot change. The loader was also constructed per input path, so one `telo check a b c` re-fetched a module shared between them once per file. Checking the repo's examples took 41s of which 35s was network, with `http-server` and `console` each fetched six times inside a single process.

  `check` now registers the same manifest cache `run` reads and write-throughs after a successful load, and shares one loader across every input path (its `urlToSource` / `fileCache` dedupe by canonical URL, so the resolution result never depended on which entry asked). A cache source is registered per input path's cache root; entries are content-addressed, so a hit under any root is as good as a hit under the one that path would write to.

  Freshness is kept honest rather than assumed, per cache-key shape:

  - A **pinned** import — what `telo install` writes and what every published manifest carries — is verified against its inline `sha256-` hash on read, so it needs no network at all.
  - An import naming a **mutable OCI tag** is revalidated with one `HEAD` per reference (once per invocation, not once per input path) against the digest that produced the cached copy, recorded in `.telo/manifests/.origins.json`. A tag that has moved, or was never recorded — e.g. a cache written by `telo run` — drops that one entry and reloads it.
  - A **registry** ref is always version-segmented, and a published version is immutable by the same convention npm relies on, so it is served without revalidation. This is a deliberate call: the registry origin has no cheap freshness probe (`digest()` downloads the manifest to hash it), so revalidating would cost exactly what re-fetching costs.
  - An arbitrary **HTTP(S) URL** import is never read from the cache by `check`. Its key carries no version segment — one URL is one path forever — so a hit would be served for the lifetime of the directory regardless of what the server now returns. Re-fetching costs one request, which is exactly what revalidating would cost, so the honest option is also the cheap one. `check` still writes these entries, since `telo run` reads them.

  So `check` cannot report a clean bill of health against a manifest that has changed upstream.

  On the kernel side, read-side `OciClient`s are pooled per `(host, repo)` on the `OciTransport` instance instead of built per operation. The client caches bearer tokens per scope, but a per-operation client discarded that cache immediately, so every manifest and every blob paid its own 401→challenge→token round trip plus a `~/.docker/config.json` read and possibly a credential-helper subprocess. An expired token still self-heals through the existing 401 retry. The pool belongs to the instance rather than the module so a second transport — a test, or a second in-process kernel — never inherits another's credentials; `defaultTransportRegistry` is memoized per registry URL, so the production lifetime is unchanged. Publishing keeps its own client.

  `Loader.forget(url)` drops one file's memo (every parse variant, plus every request URL that canonicalised to it) so a single stale manifest can be re-resolved without discarding the whole loader and every unrelated file's cached resolution with it. The loader already documented needing this for watch mode.

  Checking the examples now takes 1.2s warm; a single pinned manifest resolves with no network at all.

- Updated dependencies [89ffea7]
  - @telorun/templating@0.11.1

## 0.49.0

### Minor Changes

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

- @telorun/templating@0.11.0

## 0.48.0

### Minor Changes

- d23de89: Layered module artifacts: a published module is now one artifact of several layers instead of one tarball, and each layer is materialized only when something needs it.

  `telo.yaml` gets its own layer, so reading a manifest no longer downloads (and discards) the whole payload. The rest of `files:` is partitioned into one layer per bundled-controller selector — `format` plus optional `os`/`arch`/`libc` PURL qualifiers — plus an `assets` layer for what the new optional `assets:` list claims and a `common` layer for everything else. A Node kernel never fetches a `napi` layer, a `linux/amd64` host never fetches the `darwin/arm64` binary, and an app that imports a module for its API alone never fetches its frontend.

  This fixes a cold-start failure: bundled controllers used to resolve against an `oci://` base URI that was read as a filesystem path, because the payload was written to disk by a CLI hook running _after_ `kernel.load()`. The first run of any OCI-imported module with bundled controllers failed and the second succeeded. Controller layers now materialize at resolve time through a module-scoped `ModuleArtifact`, built during load where the pinned import ref and the verified manifest are both available — so verification stays anchored to the importer's `#sha256-` pin rather than to whatever is in the cache.

  `ctx.resolveModuleFile(relative)` is the new, URI-returning way to reach a file that ships with a module; it materializes the asset layer on first use. `Http.Static`, `mcp-client`, `assert`'s manifest loader and `Test.Suite` all use it, which also fixes a silent bug where a non-`file://` module resolved a relative root against the process working directory and served the wrong directory instead of failing.

  Also: `telo install --platform os/arch[/libc]` pre-fetches layers for a platform other than the build machine's, the layer index and selector grammar are specified normatively in `kernel/specs/module-artifact.md`, and the cross-process cache lock is shared between the npm loader and layer materialization instead of duplicated.

  Modules published before layers keep resolving: the manifest read path still accepts a single-blob artifact, which contains `telo.yaml` — so nothing that ships no payload needs anything done to it, and npm-backed modules are entirely unaffected. What such an artifact cannot supply is a layer index, so a module that _does_ ship a payload resolves its manifest and then fails at the controller with an actionable "republish" error. That is the six modules shipping `files:` — `oauth-client`, `scheduler`, `kv-store-memory`, `kv-store-redis`, `kv-store-sql`, `idempotency` — which must be republished, with consumers bumping to the new versions.

### Patch Changes

- @telorun/templating@0.11.0

## 0.47.0

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

### Patch Changes

- 6376a66: Fix a credentialed request losing the content-type derived from its body.

  The credential path rebuilt the header set from the client and request maps, but
  the `content-type` inferred for an object body was mutated into the merged map
  only — so every POST/PUT with a JSON body through a client carrying a credential
  was sent with no content-type, and arrived unparsed. Derived headers are now kept
  separately and filled in last, only where nothing else set the key.

  The analyzer's sentinel pass reads `x-telo-scope` from the declaring kind's field
  map instead of inferring a scope structurally from any array of named inline
  resources. The heuristic happened to coincide with `Run.Sequence.with` today, but
  this pass is shared with the kernel, so it would have baked a guess into the
  runtime manifest tree the first time a kind carried such an array without being a
  scope.

  - @telorun/templating@0.11.0

## 0.46.0

### Minor Changes

- 8353d0e: Resources can now declare and report **observed state** — what they learn while running, as opposed to what their author configured. A kind declares it with a `status:` JSON Schema block on its `Telo.Definition` (or `Telo.Abstract`, so a contract can mandate what its implementations report); a controller returns it under the reserved `status` key of `snapshot()`; the kernel publishes it at `resources.<name>.status.<field>`. The flat half — `resources.<name>.<field>` — keeps whatever meaning it has today and is neither typed nor changed. Documented in `kernel/docs/observed-state.md`.

  Configured state is pulled, observed state is pushed, and they never share a payload. `snapshot()` returns what the author configured and the kernel pulls it whenever it needs it — it is a function of the manifest, so re-deriving it is always correct. What a resource LEARNS goes the other way: `ResourceContext.setStatus(...)` reports it at the moment it is known, because nothing but the controller knows when that is. Splitting the two is what keeps each shape described in one place — a controller never rebuilds observed state inside `snapshot()` from a field it stashed only for that purpose, and with two channels there is no reserved key to collide over. Reporting replaces rather than merges, is AJV-checked against `status:` at the call that made it, and is an error before the resource has started (`ERR_OBSERVED_STATE_BEFORE_START`) — `init()` performs no I/O, so nothing is observed there. The reading is sticky: the kernel holds it until teardown, so a dispatch that reports nothing leaves a listener's bound address in place rather than blanking it. A kind that declares `status:` may not also return a flat `status` field (`ERR_OBSERVED_STATE_KEY_COLLISION`); one that declares none may use the name freely. A publication is now a reading rather than a live window: the published value is detached from what the controller returned (plain objects and arrays are rebuilt; class instances and functions pass through, since copying one would break it), so a controller that mutates the structure it reported cannot rewrite an already-published value. Previously the only mechanism for reporting anything learned at runtime was that aliasing accident — the kernel stored the props object by reference, and no schema check could catch a value rewritten behind CEL's back because the shape never changed.

  The segment exists only once the resource reports. Defaulting every field in `snapshot()` (`?? ""` / `?? 0`) is the prevailing controller style, and a pull-based design would publish that from `init()` as placeholders indistinguishable from a real report — the exact failure this replaces. With reporting pushed, there is nothing to withhold: no call, no segment.

  The `status:` chain is folded in the scope that DECLARED each definition, never the consumer's — an `extends` alias belongs to the file it was written in. The kernel stamps the folded block onto the definition at registration (in the defining module context, beside the existing `effectiveAuthorSchema` stamping); the analyzer re-scopes per declaring module. Without that, an abstract's `status:` would vanish for any consumer importing only the implementation — the sanctioned "one import instead of two" — and the reserved-key check, which keys off exactly that, would then reject a correct manifest. Stamping also makes the folded schema a stable object, so the publication path's AJV validator cache hits instead of recompiling on every snapshot.

  Reads are checked statically. `OBSERVED_STATE_IN_STARTUP_FIELD` rejects any path through `.status` in a field that resolves at startup (`x-telo-eval: compile`, or implied by `Telo.Provider`) — a purely syntactic rule, so it covers kinds that declare nothing. `OBSERVED_STATE_NEVER_RUN` rejects a read of a resource nothing can start: reachability is computed from every slot that can reach `run()` — a `targets:` entry and a step's `invoke:`, both keyed on the declared `Telo.Runnable` / `Telo.Service` contract rather than on any field name or kind. Fields under `.status` are type-checked — including cross-module, where an import's exported instances are indexed under `resources.<Alias>.<name>` so a typo fails exactly where a local one does — so a typo is `CEL_UNKNOWN_FIELD` instead of resolving to nothing; the `resources` root and every resource node stay permissive, so no read that validates today can begin to fail. `required:` inside `status:` is `OBSERVED_STATE_REQUIRED_FORBIDDEN`, a dedicated diagnostic naming the rule and the fix rather than an AJV `not:` that could only say "must NOT be valid" — every declared field is mandatory once the resource has run, and a sometimes-absent one is declared with a nullable type, which `CEL_NULLABLE_ACCESS` already guards.

  What genuine ordering leaves is three runtime errors rather than one hedge, because each needs a different action and only the kernel can tell them apart: a resource that has not started names the `targets:` to fix; one that started but whose `run()` has not returned raced a service still coming up; and one whose `run()` returned while a declared field is still missing is a defect in the producing module, which the message names. That last case is unreachable for a long-lived Service, whose `run()` never returns — so a slow bind is never blamed on someone else's code. None yields an empty value or a bare `No such key`.

  `with:`-scoped resources now publish like any other. Each `ScopeHandle.run()` gets its own map of the scope's resources, layered at read time over the enclosing module's — read time, not scope entry, because `setResource` replaces the module's map wholesale on every publish, so a copy would go stale the moment an outer resource republished — with scope-local names winning — matching `ScopeContext.getInstance`'s resolution order, so CEL and `!ref` never disagree, and two concurrent runs of the same sequence never observe each other. `ScopeContext` gains `run(name)`, which dispatches a scope target through the kernel's chokepoint (traced, records that it started, publishes its snapshot) instead of calling `instance.run()` directly, and `resources`, the map itself. `Run.Sequence` uses both. Previously `resources.<scopedName>` resolved to nothing at all.

  Fix a controller's `ctx` targeting the wrong context for a `with:`-scoped resource. `ResourceContextImpl` resolved everything through the enclosing MODULE context, but a scoped resource is owned by the per-run scope child — so registering a manifest, resolving a sibling by name, expanding CEL, spawning a child context and dispatching all went to the wrong place. Registration was the visible one: an inline definition a scoped resource resolves during `init()` landed in the module's pending queue, which the module's init loop had already drained at boot, so the resource was never created and the dispatch failed with `ERR_RESOURCE_NOT_FOUND`. Those members now go through the owning context; `ctx.moduleContext` keeps its meaning and is reserved for what genuinely belongs to the module — imports, the controller policy, and the logging scope, all of which a scope child inherits rather than owns. By-NAME lookup (dispatch, `getResourcesByName`, kind resolution) resolves scope-local first and falls back to the enclosing module, the order `ScopeContext.getInstance` and the CEL `resources` layering already use — a scoped `Http.Server` whose `notFoundHandler` targets a module-level invocable still finds it. Registration deliberately does not fall back: a new manifest belongs to the context that owns the resource creating it.

### Patch Changes

- @telorun/templating@0.11.0

## 0.45.0

### Minor Changes

- 3729559: Add `parseVersionedRef` / `withRefVersion` — the browser-safe, transport-neutral half of an import upgrade (split a ref into `{ baseRef, version, integrity }`, re-point it at a new version). The OCI and registry transports' `refVersion` / `withVersion` now delegate to it, so the ref grammar has one implementation shared by `telo upgrade` and hosts that have no transport at all (the telo editor, which reads versions from the hub instead). `withRefVersion` throws for a ref whose grammar carries no version segment (a relative path, a bare `https://` URL) rather than fabricating one, matching the transport-specific parsers it replaces.

  Export the SemVer ordering that version reconciliation already used — `parseModuleVersion`, `compareModuleVersions`, `isNewerModuleVersion`, `isSameModuleVersion` — from `module-version-order.ts`. Still pure and dependency-free, so it stays browser-safe; it is now the one version-precedence rule available to every host rather than being private to `reconcile-module-versions.ts`.

## 0.44.0

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

### Patch Changes

- @telorun/templating@0.11.0

## 0.43.0

### Minor Changes

- adc8459: Add the `x-telo-value-schema-from` schema annotation.

  The value at an annotated node must satisfy the type declared at the resource's
  named field, resolved with the same `telo#Type` semantics as `inputType` /
  `outputType`. It targets kinds with ONE declared output contract and SEVERAL
  slots that must each produce it — a decision table's rows, a switch's arms —
  where only the branch that wins at runtime would otherwise ever be checked, so a
  mistyped branch ships and fails on the one input that selects it.

  CEL leaves are replaced with schema-shaped placeholders before validation, so an
  expression is accepted wherever its declared type would be; what the check
  catches is structural disagreement no runtime value could fix. A field that
  resolves to no schema is skipped — declaring the contract is what opts in.
  Generic and topology-driven: no resource kind is hardcoded.

### Patch Changes

- @telorun/templating@0.11.0

## 0.42.0

### Minor Changes

- de6c2aa: Reject `!ref` references in `x-telo-scope` fields (e.g. `Run.Sequence`'s `with:`). Such an entry previously registered a config-less resource and failed deep in the controller with a misleading schema error; the kernel now throws `ERR_SCOPE_ENTRY_NOT_INLINE` and `telo check` flags it statically as `SCOPE_ENTRY_NOT_INLINE`, pointing at the offending entry. Scope fields declare inline resource definitions; reference an outer resource from a sibling field like `targets:` instead.

  Also remove the unwired `keepAlive` field from the `Telo.Application` schema — process liveness is governed by resources acquiring a kernel hold (e.g. an HTTP server), not by this flag, which had no runtime effect.

## 0.41.1

### Patch Changes

- Updated dependencies [ab4a911]
  - @telorun/templating@0.11.0

## 0.41.0

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

## 0.40.0

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
