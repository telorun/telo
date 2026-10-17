# Plan — A versioned archive of the built-in vocabulary

## Problem

The kinds that need no import — `Telo.Application`, `Telo.Library`, `Telo.Definition`,
`Telo.Abstract`, `Telo.Import`, `Telo.NeedType`, `Telo.JsonSchema`, `Telo.Function`, the sinks and
the capability abstracts — exist only as code inside the analyzer. Nothing can print, fetch or search
them, so an AI agent authoring a manifest learns them from prose in its system prompt, and that prose
is stale the moment a release changes them. The hub answers no query with a `Telo.*` kind, stores
`extends: Telo.LogSink` with an empty `extends_ref`, and indexes no `Telo.NeedType` of any module.

Defects beside this:

- `Telo.Definition` and `Telo.Abstract` are each validated by two complementary half-schemas: the
  analyzer's knows the template-body fields, the kernel's knows `capability` / `extends` /
  `controllers` / `inputType` / `outputType`. A definition with `controllrs:` passes `telo check` and
  fails at boot, and a rendering of either half would teach an incomplete kind.
- Nothing reserves `Telo` or `Self`. A `Telo.Library` named `Telo` declaring `Application` is accepted
  and replaces the built-in definition in the registry while the old schema stays compiled — a
  silently split registry.
- The Rust analyzer carries the built-in names as a separate list.
- The capability set is open on one kernel and closed on the other. The Node kernel lists the known
  capabilities only to subtract them from a fallback branch that accepts any other name as a
  third-party extension; the Rust kernel refuses any name off its own list
  (`ERR_MANIFEST_VALIDATION_FAILED`, "is not a kernel capability"). A `capability:` naming no
  lifecycle a kernel implements loads on Node and fails on Rust, and nothing static reports it —
  `capability: Foo.Bar` with no `Foo` import is accepted silently. The editor support keeps a third
  copy of the list, with hand-written hover text.
- `capability:` has two meanings. Beside a lifecycle role it also accepts a legacy spelling naming a
  module's abstract (`capability: AbstractLib.Greeter`), which the analyzer wires as an inheritance
  edge and warns about (`CAPABILITY_SHADOWS_EXTENDS`). Every reader keyed on a kind's capability —
  a provider's implicit compile-eval, the need-observation deadlines, the `throws:` allowlist — reads
  such a kind as having an unknown role, and the abstract's schema, contract and `throws` ceiling are
  never applied to it.

## After the change

Every telo release X publishes `oci://ghcr.io/telorun/telo@X`, the built-in vocabulary of that
release. The hub tracks it like a module, so `list_module_versions`, `get_kinds` at a version and
`search_resources` answer for built-ins. `telo builtins [<name>...]` prints the vocabulary of the CLI
that runs it.

### The vocabulary is data

The built-ins move out of code into one JSON file per entry under `sdk/builtins/`, each entry the
built-in in its authored form; the fragment bodies (`ResourceRef`, `RetryPolicy`, `RetryAttempts`,
`InvokeStep`, `Step`, `JsonSchema7`, `KindSchema`) are entries there too. The format entries move from
`analyzer/formats/` to `sdk/formats/`. `sdk/` is MIT, beside `sdk/value-types/` and
`sdk/zone-attributes/`: the vocabulary is the contract authors write against and other runtimes
implement, and JSON is what both the Node and the Rust halves embed without a second copy.

- The Node analyzer registers its built-ins from these entries and derives the expanded form, as it
  does for any module. The Rust analyzer embeds the same entries; its separate list of names goes.
- Two fields are DERIVED from other entries rather than written in the entry: the `capability:` enum
  of `Telo.Definition` / `Telo.Abstract` (from the roster's `declarable`) and the `throws:` allowlist
  (from its `throwsAllowed`). Every other field is written once, in the entry. The archive renders
  the derived fields in their derived form, so it states which capabilities are legal.
- An entry keeps its fragment references (`$ref: telo://manifest#/$defs/Step`); expansion stays in
  the analyzer.
- The two half-schemas become one, held by the entry: one schema holding both halves' constraints,
  applied by `telo check` and every kernel. Newly refused: an abstract's malformed `schema:` /
  `status:`. A kind document declared as a `with:` scope member gets the same roster and schema
  check from `telo check`.
- Every entry gets a `metadata.description` written for hub search, under the root CLAUDE.md's
  `Manifest descriptions — MANDATORY` rules.
- The public-address need types are shipped as their authored `Telo.NeedType` documents, not as the
  definitions derived from them.

### The capability roster is closed

A capability names a lifecycle a kernel implements and dispatches, so no module can add one, and an
unknown name accepted at load is a resource that can never run. `capability:` gets one meaning — a
lifecycle role — for every value, and the legacy spelling is carried by a migration rather than kept
as a second meaning in code. Keeping the legacy meaning beside a closed roster was rejected: every
reader keyed on a capability would carry a branch for it forever.

**The roster.** Each capability abstract's entry carries `capability` (the name is a lifecycle role —
`Telo.Service`, `Telo.Runnable`, `Telo.Invocable`, `Telo.Provider`, `Telo.Mount`, `Telo.Sink`,
`Telo.Callable`, `Telo.Type`, `Telo.Template`), `declarable` (an authored `capability:` may name it),
`throwsAllowed` and a `description`. `Telo.Template` is a role reserved for the built-in document kinds
and is not declarable; `Telo.Executable` is neither, being a slot constraint. The archive's own
documents may name `Telo.Template`: they are read, never authored.

- The `capability:` field of `Telo.Definition` / `Telo.Abstract` is an enum of the declarable names,
  derived from the entries, so a form and completion read the choices from the schema alone. The
  Node kernel's fallback branch for unknown names goes, and its capability list and `throws:`
  allowlist are derived from the entries.
- The definition registry no longer treats a `capability:` value as an inheritance edge, and the
  analyzer's separate check for the legacy spelling goes.
- The editor support's capability list and hover text are derived from the entries — the names from
  `declarable`, the hover from each `description` — and its own list goes.

**The legacy spelling is a migration.** `analyzer/migrations/capability-as-extends.json` rewrites
`capability:` to `extends:` in `Telo.Definition` and `Telo.Abstract` documents when the value is an
alias-qualified `<Alias>.<Kind>` whose alias is not `Telo` — the legacy shape is told apart without
resolving a name, since every role starts with `Telo.`. It reports `CAPABILITY_SHADOWS_EXTENDS` as a
warning tagged deprecated, in the entry module's own files only, and `telo migrate` writes it to the
file. Where `extends:` is already present the rename refuses the occupied key and leaves the node to
the validator.

- The matcher vocabulary gains two tokens: `valuePattern` (the string value fully matches a pattern)
  and `valueNotPattern` (it does not). Patterns are restricted to the RE2 subset — no lookaround, no
  backreferences — and the entry reader refuses anything outside it, so every runtime's reader agrees.
  Listing the roster as excluded values instead would also rewrite a typo such as `Telo.Invokable`
  into an `extends:` and report it as a missing parent.
- A migrated legacy kind is checked as the `extends` child it always claimed to be: the abstract's
  schema merges into its author surface, the abstract's invocation contract and `throws` ceiling
  apply, and its capability is inherited. A published dependency that violates its abstract's
  contract now fails, loudly, where it was skipped silently.
- The Rust half has no migration reader, so it meets the legacy spelling unrewritten and refuses it as
  an unknown capability. It already refuses every `extends:` (`ERR_UNSUPPORTED_MANIFEST_FEATURE`), so
  such a kind never ran there; only the code changes.

**Codes.**

- `CAPABILITY_UNKNOWN` (new, error) at the `capability:` line: a `Telo.`-prefixed name the roster does
  not hold — a built-in kind that is no role (`Telo.LogSink`) is told to write
  `extends: Telo.LogSink`; a value that is neither `Telo.<Name>` nor alias-qualified (`Invocable`),
  with the nearest roster name suggested; and an alias-qualified kind the migration could not move
  because `extends:` is already declared — a definition has one parent, declared in `extends:`.
- `CAPABILITY_NOT_DECLARABLE` (existing, error) for every entry with `declarable: false`
  (`Telo.Template`, `Telo.Executable`), worded from that entry's `description`; the hardcoded
  `Telo.Executable` check goes.
- The schema's own enum finding at `capability` is dropped in favour of these, so each mistake is one
  diagnostic.
- Both are reported for a dependency's definitions too, anchored at the `imports:` entry reaching it,
  because the kernel refuses them at registration.
- Both kernels raise `ERR_CAPABILITY_UNKNOWN` / `ERR_CAPABILITY_NOT_DECLARABLE` at definition
  registration, reading the same entries; Rust's `ERR_MANIFEST_VALIDATION_FAILED` "is not a kernel
  capability" goes. Where the load's analysis already refused, the `ERR_MANIFEST_VALIDATION_FAILED` it
  raises carries the static codes.
- `capability: Foo.Bar` with no `Foo` import is migrated to `extends: Foo.Bar` and reported as
  `EXTENDS_MALFORMED` beside the migration's warning, both mapped back to the `capability:` line; the
  Node kernel raises its existing refusal of an unresolvable `extends:` alias; the Rust kernel
  `ERR_CAPABILITY_UNKNOWN`.

No `requires:` floor: the change only narrows what is accepted, and the matcher tokens are the
analyzer's migration data, not manifest syntax.

### The archive document

A YAML stream whose first document is `kind: Telo.Builtins` with `metadata.name: Telo` and
`metadata.version: <X>`, followed by one document per built-in in authored form (`Telo.Abstract`,
`Telo.Definition`, `Telo.NeedType`) with no `controllers:` anywhere — the root kind says once that the
kernel implements every kind in it. The root document is the `telo://manifest` document:

- `$defs` — the fragments, unexpanded, each referring to the others as `telo://manifest#/$defs/<Name>`.
  No built-in document carries a hoisted or expanded copy, since the reference spelling is what an
  author must reproduce in their own kinds.
- `valueTypes`, `zoneAttributes`, `formats` — maps keyed by name, each entry verbatim from its data
  file, so every `x-telo-type`, zone annotation and `format:` a definition names resolves inside the
  archive.

Neither the `x-telo-*` annotation catalogue nor the CEL function catalog ships: an annotation's meaning
is its reader's behaviour, and a definition names no function.

**Rendered once, at build.** The analyzer's renderer writes the archive as a generated, untracked
file beside the generated surface version, carrying `metadata.version: X` (or `X+unreleased`), and
the `@telorun/analyzer` package ships and exports it; its `prepack` refuses a tarball whose archive
does not carry exactly the package version, as the language server's does. The Node CLI reads those
bytes from the analyzer and the Rust CLI embeds the same file at build, refusing to build without it —
nothing renders at runtime, so the two CLIs cannot disagree. **The archive's identity is the
published `telo.yaml` minus its `layers:` index**, which `telo publish` writes (the `common` layer
carrying the `LICENSE` has an entry): that equals the generated file byte for byte.

`Telo.Builtins` is not a module kind and not a registered kind. It is read, never declared, run or
imported:

- In an Application or Library file it is `UNDEFINED_KIND`; as the entry of `telo check` / `telo run`
  it is refused by both kernels; as an import target it is `INVALID_IMPORT_TARGET` (Rust:
  `ERR_MANIFEST_VALIDATION_FAILED`) — the refusal every released runtime already applies to a root
  that is neither `Telo.Library` nor `Telo.Application`. Codes are unchanged; each message says what
  it is: *"`Telo.Builtins` is the published built-in vocabulary of a telo release; it is read, never
  declared, run or imported."*, and at an import: *"'<source>' is the built-in vocabulary of telo
  <X>; its kinds need no import — remove this `imports:` entry and write them as `Telo.<Kind>`."*
- `telo module manifest --json` reads it, reports `application: null` and no runtime reach (an absent
  PURL would otherwise read as portable, and the Rust kernel hosts almost none of these kinds).
- `telo publish` accepts it as a manifest-only artifact (`manifest` and `common` layers, the `common`
  layer carrying the MIT `LICENSE`; `license: MIT` on the root) and keeps its published-pin gate.

A flagged `Telo.Library` was rejected: every released runtime imports a library and would overwrite
the built-ins, and a dependency's `requires:` does not stop that.

### Reserved prefixes

`Telo` and `Self` are refused as a module `metadata.name` and as an import alias:
`KIND_PREFIX_RESERVED` from `telo check`, `ERR_KIND_PREFIX_RESERVED` from the kernel. This closes the
silent overwrite independently of the archive.

### `telo builtins [<name>...]`

In both CLIs, through the `Output` seam.

- With no names it writes the generated archive of the generation the CLI implements, byte for byte:
  for a release, the published `telo.yaml` minus its `layers:` index; for an unreleased build, one
  carrying `metadata.version: X+unreleased`.
- With names it writes only those entries. A name is a kind or need type (`Application` or
  `Telo.Application`), a fragment (`Step`), a value type (`Telo.Url`), a zone attribute (`atomic`) or a
  format (`css-selector`). The reader follows a reference by asking again; selection keeps one answer
  within an agent's tool-result bound.
- An unknown name exits non-zero, listing the names there are.
- No version flag: another version is `telo module manifest oci://ghcr.io/telorun/telo@<X>`.

### Publishing

The publish workflow reconciles on every push to main: for each `@telorun/analyzer` version on npm at
or above the first that ships the archive, whose `oci://ghcr.io/telorun/telo` tag is missing, it
takes the archive out of that released package and pushes it with `telo publish`. No historical CLI
is run. It is not a step of the npm release job, where a failure after `changeset publish` has
nothing to retry and a missed version would stay missing. The pin gate refuses a second push of a
version whose `telo.yaml` would differ. There is no backfill: the archive starts at the first release
that ships it, because a pinned artifact no release produced cannot be corrected.

### The hub

- **Ingest.** A `Telo.Builtins` root is accepted only at the hub variable `builtinsRef` (env
  `BUILTINS_REF`, default `oci://ghcr.io/telorun/telo`), which the hub tracks; at any other ref it is
  refused with `INGEST_ROOT_KIND_UNSUPPORTED` — registration is open, so nobody else may publish
  "built-in" kinds. `module_versions.root_kind` gains `Builtins`.
- **Need types are kinds.** Ingest indexes every module's `Telo.NeedType` documents as kinds, and
  `get_kinds` returns them.
- **No import line.** `get_kinds` for the builtins module prints, in place of its `# imports:` line,
  *"# Telo — built in to telo <X>: write no import; name these kinds `Telo.<Kind>` (the prefix is
  fixed, not an alias)."* Search hits and `list_libraries` entries from it carry `module.builtin: true`,
  and the MCP `instructions:` gain one line saying so, staying within 4096 characters.
- **Prefix resolution.** For `extends:` and `replacedBy`, the `Telo.` prefix resolves to `builtinsRef`,
  and a module's own `metadata.name` prefix resolves to its own ref as `Self` does — for every module.
  The empty `extends_ref` for a built-in parent is retired.
- **Closure.** `get_kinds` includes every fragment, value type, zone attribute and format a returned
  definition names, transitively, and every `Telo.<Kind>` parent — for every module's kinds.
- **Which telo.** A built-in reference resolves against the telo that runs the manifest, not the
  declaring module's floor, so `get_kinds` takes an optional `telo` argument — a telo version — and
  reads every built-in it returns at that version, the latest tracked when it is omitted. Its output
  states the telo version it resolved against, and a version the hub does not track is refused,
  naming the tracked ones.
- A new ingest revision re-ingests every tracked version so the need types, resolved refs and
  `root_kind` reach existing rows.

### Documentation

- A normative spec of the `Telo.Builtins` document, `kernel/specs/builtin-vocabulary.md`, and READMEs
  for `sdk/builtins/` and `sdk/formats/`.
- The authoring agent's primer replaces its prose field shapes of the built-in kinds with: read them
  with the `telo` tool's `telo builtins <name>`, or `get_kinds` passing the CLI's version as `telo`. The prose rules that are not data (CEL, references, where `inputs:` belong) stay.
  Matching hub guides are updated in the same change.
- Root, analyzer, CLI and hub CLAUDE.md files (the capability sections included); the migrations
  guide (`docs/extend/manifest-migrations.md`, the two matcher tokens and the entry); the
  diagnostics reference (`CAPABILITY_UNKNOWN`, the reworded `CAPABILITY_NOT_DECLARABLE`);
  `pnpm run check:licenses` lists the new MIT data.
- Changesets for every published package changed; a hub changelog fragment through `telo release add`.

## Order of work

1. The data move, the half-schema unification and the closed capability roster with the
   `capability-as-extends` migration and its matcher tokens, with the Rust analyzer, both kernels
   and the editor support reading the same entries.
2. Reserved prefixes, with their agreement-suite pins.
3. The archive rendering, `telo builtins` in both CLIs, `telo module manifest --json` and
   `telo publish` accepting the root, the tailored refusals.
4. The publish workflow.
5. The hub.
6. Documentation and the primer.

## Verify

- A registry built from the archive's documents equals the one the analyzer runs on (round-trip test).
- A `Telo.Definition` with `controllrs:` is refused by `telo check` and by `telo run` alike.
- `capability: Telo.Invokable`, `capability: Invocable` and `capability: Telo.LogSink` are each
  `CAPABILITY_UNKNOWN`, and `capability: Telo.Template` and `capability: Telo.Executable` each
  `CAPABILITY_NOT_DECLARABLE`, from `telo check`, the Node kernel and the Rust kernel (`ERR_`-prefixed
  at runtime), one diagnostic per mistake, pinned both ways in `tests/check-run-agreement.yaml`
  (refused at the declaring module, and at a consumer whose `telo check` reports it at the
  `imports:` entry and whose run fails naming it), and by shared conformance vectors read by the
  analyzer, the Node kernel and the Rust tests.
- `tests/capability-shadows-extends.yaml` keeps its legacy fixture and becomes the migration's test:
  `capability: AbstractLib.Greeter` loads on Node with `CAPABILITY_SHADOWS_EXTENDS`, the kind extends
  `AbstractLib.Greeter` (the abstract's required fields are demanded of it), and `telo migrate`
  rewrites the key in the file. The same document with `extends:` also declared is
  `CAPABILITY_UNKNOWN`.
- A migration entry whose pattern uses lookaround or a backreference is refused by the entry reader.
- No code path treats a `capability:` value as an inheritance edge; the kernel's definition schema has
  no fallback branch; every reader keyed on a kind's capability sees only roster names; every module
  in the repo still passes `pnpm run test`.
- Capability completion and hover in the editor offer exactly the declarable names, with each
  entry's description.
- Every `telo://manifest#/$defs/<Name>` in the archive resolves inside the root `$defs`, every
  `x-telo-type` inside `valueTypes`, and the archive holds no `telo:`-prefixed `$defs` key.
- A library or application named `Telo` or `Self`, and an import aliased `Telo`, are refused as
  `KIND_PREFIX_RESERVED` by `telo check` and `ERR_KIND_PREFIX_RESERVED` by `telo run`, pinned in
  `tests/check-run-agreement.yaml`.
- A file whose first document is `Telo.Builtins` is refused by `telo check`, the Node `telo run` and
  the Rust kernel, each with the tailored message; importing it is refused with the import message,
  pinned in `tests/check-run-agreement.yaml`; the previous published CLI refuses the same import
  (by execution).
- `telo module manifest --json` on the archive reports first document `Telo.Builtins`,
  `application: null`, no runtime kinds.
- `telo builtins Application Step` prints exactly those two entries; an unknown name exits non-zero
  naming the available ones; `telo builtins` from the Node CLI and from the Rust CLI of one build are
  byte-equal to the generated file.
- The archive's `Telo.Definition` and `Telo.Abstract` `capability:` enum equals the roster's
  declarable names, and its `throws:` allowlist the roster's `throwsAllowed` names.
- Packing `@telorun/analyzer` with an archive carrying `X+unreleased` or another version is refused.
- For every released line version X at or above the first, `oci://ghcr.io/telorun/telo@X` exists and
  its `telo.yaml` minus `layers:` is byte-equal to the archive in `@telorun/analyzer@X`; re-running the
  workflow publishes nothing; a different archive for an existing X is refused by the pin gate;
  `telo module versions oci://ghcr.io/telorun/telo` lists nothing below the first such release.
- Hub: `search_resources("write log records somewhere")` returns `Telo.ConsoleSink` and
  `Telo.FileSink` with `module.builtin: true`; `get_kinds` for `Telo.Definition` returns `KindSchema`
  and `JsonSchema7` and no `# imports:` line; `get_kinds` for a `Run` step kind returns `Step` and
  `InvokeStep`; `get_kinds` for an `Otlp` sink returns `Telo.LogSink`; an `Otlp` sink's `extends`
  resolves to `oci://ghcr.io/telorun/telo`; a module's need type is returned by `get_kinds`; ingesting
  a `Telo.Builtins` root at any other ref records `INGEST_ROOT_KIND_UNSUPPORTED`; `get_kinds` for a
  `Run` step kind with `telo: <older X>` returns that release's `Step` and names X in its output,
  without `telo` returns the latest and names it, and with an untracked version is refused naming
  the tracked ones.
