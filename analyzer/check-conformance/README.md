# Check conformance vectors

What `telo check` reports for a manifest, and what a run of it is refused with, frozen as data: every analyzer and every kernel reads these rows and answers each identically, word for word and position for position. Editing one expected message breaks every runner until each implementation says it.

## Format

`vectors/<id>/` is one row:

- a manifest tree — `telo.yaml`, the entry `Telo.Application`, and every module it imports, beside it under the row's own directory and imported by relative path; nothing is fetched;
- `expected.json` — `{ "diagnostics": [ … ], "runFails": … }`, and no other key.

`diagnostics` is every diagnostic `telo check` reports for the entry, every severity: the parse, import-resolution and analysis diagnostics, assembled as every host assembles them (a file that failed to parse, or whose import failed, has its analysis held back). Each is the analyzer's whole `AnalysisDiagnostic` — `severity`, `code`, `source`, `message`, `tags`, all of `data` — with `range` the UTF-16 LSP range the diagnostic is shown at: its own range when it carries one, else the range its position fallback resolves (the resource's position, then its document, then the file's start); a diagnostic nothing locates has no `range`. They are compared as a multiset: a runner sorts both lists by each diagnostic's JSON text with keys sorted at every depth, compared by code point, and compares the sorted lists whole. A row stores them in that order.

`runFails` is what loading the entry and running its targets is refused with, as one text — `[<CODE>] <message>` of the refusal, then each diagnostic it carries on a line of its own as `  [<CODE>] <message>` (`  <message>` for one with no code) — or `null` when the run succeeds. The carried diagnostics are in the canonical finding order, which every kernel takes from its analysis unchanged, while `diagnostics` stays a multiset.

Every file a row's values name is relative to the row directory: a runner removes the row directory's own prefix (its `file://` URL or its path, followed by a separator) from every string it compares.

The values are Node's answers, recorded by running the Node analyzer and the Node kernel over each row. No generator is committed: a row's values are written once, read by every runner, and change only when the answer does. A row lands only when all four runners pass it, so a construct only one kernel refuses (one the Rust kernel cannot read yet, `ERR_UNSUPPORTED_MANIFEST_FEATURE`) never appears in a row.

## Rows

- `clean-application`, `clean-library-kinds` — nothing is reported and the run succeeds.
- `parse-*` — `MANIFEST_PARSE_FAILED`, one row per kind of YAML failure both loaders classify alike (`duplicate-key`, `unresolved-alias`, `alias-limit`, `tab-indentation`, `unclosed-quote`, `unclosed-flow-collection`, `bad-indentation`, `invalid-escape`, `reserved-character`, `plain-value-colon`), one in an imported library (`parse-in-dependency`), and one whose file's analysis is held back (`parse-holds-back-analysis`).
- `branch-position-metadata`, `repeat-outside-template-include` — an expansion tag where the loader reads before anything is expanded: `BRANCH_POSITION_INVALID`, `REPEAT_OUTSIDE_TEMPLATE`.
- `branch-shape-sequence`, `branch-shape-marker-key`, `repeat-shape-sequence` — an expansion tag of the wrong shape: `BRANCH_SHAPE_INVALID`, `REPEAT_SHAPE_INVALID`.
- `reserved-prefix-alias`, `reserved-prefix-library-name`, `reserved-prefix-entry-name` — `KIND_PREFIX_RESERVED` for an import's alias, an imported library's name and the entry's own name; `import-failure-holds-back-analysis` — the importing file's analysis held back.
- `capability-unknown`, `capability-not-declarable` — `CAPABILITY_UNKNOWN` / `CAPABILITY_NOT_DECLARABLE` on the entry's own definitions; `capability-in-dependency`, `capability-in-transitive-dependency` — on a dependency's, reported at the entry's `imports:` entry reaching it, with `data.writtenAt` naming where the library writes it.
- `builtins-entry` — the built-in vocabulary archive as the entry: one `UNDEFINED_KIND` at its `kind:`, the file's analysis held back; `library-empty-first-document` — an imported library whose first document is empty, its definitions still judged.
- `reference-form-target`, `reference-form-slot` — `INVALID_REFERENCE_FORM`, with its `quotedPlace`, at a boot target and at a kind's reference slot.
- `migration-capability-as-extends`, `migration-ref-slot-scalar-type`, `migration-normalize-value-types`, `migration-element-from-item`, `migration-caught-member-marks`, `migration-untagged-interpolation` — the deprecation each core migration entry reports for the entry's own file (`CAPABILITY_SHADOWS_EXTENDS`, `X_TELO_REF_SCALAR_TYPE`, `X_TELO_TYPE_DEPRECATED`, `DEPRECATED_ELEMENT_FROM_ITEM_FIELD`, `DEPRECATED_IMPLICIT_CAUGHT_MEMBER`, `DEPRECATED_UNTAGGED_INTERPOLATION` for a lone hole and for text with a hole), at the author's own path. A row whose migrated manifest declares what only one kernel runs (an `extends:`, a resource of a kind with no controller, an expression) also declares a misspelled capability, so both kernels refuse it at load on that alone.
- `migration-capability-in-dependency` — a dependency's `capability: <Alias>.<Kind>` is rewritten and reports nothing: only the entry's own files report a migration.
- `untagged-interpolation-entry` — `UNTAGGED_INTERPOLATION` for a plain string in the entry left holding a `${{` no hole can be read out of.
- `metadata-stamp-entry` — `METADATA_RESERVED_FIELD` for a loader stamp the entry's own document writes in `metadata`, at `metadata.<field>`; `metadata-stamp-in-dependency`, `metadata-stamp-in-transitive-dependency` — a dependency's, reported at the entry's `imports:` entry first reaching it, with `data.writtenAt` naming where the library writes it.
- `mixed-entry-and-dependency` — several of the above in one manifest.

## Runners

No runner has a skip path or a tolerance list.

- `analyzer/nodejs/tests/check-conformance.test.ts` — the Node analyzer: `diagnostics`, assembled as `telo check` assembles them.
- `kernel/nodejs/tests/check-conformance.test.ts` — the Node kernel: `runFails`.
- `analyzer/rust/tests/check_conformance.rs` — the Rust analyzer's API: `diagnostics`.
- `kernel/rust/tests/check_conformance.rs` — the Rust kernel: `runFails`.

## What the Rust analyzer covers

The Rust analyzer reports YAML parse failures (`MANIFEST_PARSE_FAILED`) — every error the `yaml` package raises, in every document, read by a twin of its lexer, parser and composer — the loader's expansion refusals (`BRANCH_POSITION_INVALID`, `REPEAT_OUTSIDE_TEMPLATE`, `BRANCH_SHAPE_INVALID`, `REPEAT_SHAPE_INVALID`), `KIND_PREFIX_RESERVED`, the capability roster (`CAPABILITY_UNKNOWN`, `CAPABILITY_NOT_DECLARABLE`), `INVALID_REFERENCE_FORM`, the entry module's `UNTAGGED_INTERPOLATION` and `METADATA_RESERVED_FIELD` for a stamp written on a top-level document — the entry's own where it is written, a dependency's at the entry's `imports:` entry first reaching it — and the Rust kernel raises each from them (the stamp as `ERR_METADATA_RESERVED_FIELD`); it applies every core migration to every file at load, reporting the entry's own. Node's other passes have no twin there yet, so a manifest any of them would report has no row. It may under-report and never over-report; where it does, no row can hold the manifest until a runner can pass it, and these are owed:

- An `imports:` block written behind an expansion tag: Node also reads the tag's marker as an import named `__expand` and reports it `INVALID_IMPORT_SOURCE`; the Rust loader reads no import there.
- `INVALID_IMPORT_SOURCE` and `IMPORT_UNRESOLVED` have no producer: an import that cannot be resolved or read ends the Rust graph walk as the source's own error.
- `INVALID_IMPORT_TARGET` is raised by the Rust kernel's load but reported as no diagnostic, since its sentence names where the target was fetched from, which the Rust transports word differently.
- `UNTAGGED_INTERPOLATION` at a `Telo.Import`: Node reports a dependency holding a `${{` no hole can be read out of at each import reaching it, and an entry's own one inside an `imports:` entry a second time at the import's synthetic document; the Rust analysis has no `Telo.Import` documents until it twins Node's import desugar, and the Rust kernel refuses the dependency's string where it consumes it, as `ERR_UNTAGGED_INTERPOLATION`.
- `METADATA_RESERVED_FIELD` for a stamp written on a nested declaration (inline at a slot, a scope member, a template body entry) or on a `Telo.Import` declared as a scope member: Node judges every option of each as written and reports it where it is written (a dependency's at the import), while the Rust analysis has no nested judge and the Rust loader walks no scoped import.
- `UNTAGGED_INTERPOLATION` inside a nested declaration (`{ kind, … }`) or behind an expansion tag: Node reports it under the resource and path its normalization and expansion give it, which the Rust tree does not hold.

The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
