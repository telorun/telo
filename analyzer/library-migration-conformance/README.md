# Library migration conformance vectors

What a library's `migrations:` block means, frozen as data: how a rule's `match` recognizes a value, what a library's own `telo check` reports about its migrations, and what a consumer's load makes of them. Every implementation of library migrations reads these rows and answers each identically.

## Format

### `matcher.json`

`{ "vectors": [ … ] }`, each vector `{ id, value, match, holds }`:

- `value` — the candidate, as YAML text, read with Telo's tags (`!cel`, `!ref`, `!if`, …) as a manifest is read.
- `match` — a rule's `match:`, as JSON.
- `holds` — whether `match` recognizes `value`.

The matcher reads `match` as the kind-schema grammar reads the same keywords: `type` (a name or a list of names; `integer` holds a whole number, `number` any number), `const` and `enum` (JSON equality — keys in any order, `1` equal to `1.0`), `required` and `properties` judging a map and passing every other value, `items` judging a list and passing every other value, and `<key>: false` under `properties` holding when the key is absent. A tagged value — an expression, a reference, an expansion tag — never satisfies `type`, `const` or `enum`, is neither a map nor a list, and as a member is present, so it satisfies `required`.

### `checks/<id>/`

One row:

- a manifest tree — `telo.yaml`, the entry (a `Telo.Library`, or a `Telo.Application` for the one row about an application), and every module it imports, beside it under the row's directory and imported by relative path; every kind the row's migrations rewrite is declared by its own fixture library;
- `expected.json` — `{ "diagnostics": [ … ] }`: every diagnostic `telo check` reports for the entry, each as `{ code, severity, file, path, message }` — `severity` the LSP number (`1` an error), `file` relative to the row directory, `path` the dotted path into the document. They are compared as a multiset.

The values are Node's answers, recorded by running the Node analyzer over each row; no generator is committed.

### `consumers/<id>/`

One row of the consumer stage:

- `telo.yaml` — the entry, a `Telo.Application` written in a legacy spelling, importing fixture libraries by relative path: the libraries under `consumers/__fixtures__/` (`ui`, `sqlite`, `edge`, `views`, `hold`), each declaring its own kinds, shapes and migrations, or one beside it under the row's directory;
- `expected.json` — `{ "diagnostics": [ … ], "migrated": { … } }`: `diagnostics` as for a check row, `file` relative to `consumers/`; `migrated` every document holding a rewritten node, by file (relative to `consumers/`) and document index, as the stage leaves it — a tagged value written `"!<engine> <source>"`, an expansion mapping with its `__expand` marker. The runner compares the graph's own trees after the stage, and the trees the stage's edit record yields when applied to fresh copies of the documents as they were before it, with the same `migrated`.

A directory whose name starts with `__` is no row.

## Rows

- `sound-library` — nothing is reported: a hand-over rule of a kind the library no longer declares, a rule reading it with `before`, a `resolve` entry without `before` at a reference slot, a `set:` key the current schema lacks, and a `kind:` the library re-exports.
- `disjoint-open-branch` — `MIGRATION_MATCH_OVERLAPS_SCHEMA`: a required key the schema does not declare, accepted because the schema declares no `additionalProperties: false`.
- `disjoint-one-of-per-branch` — a `match` disjoint from every branch of a `oneOf` passes; one a single branch accepts is refused, naming that branch.
- `disjoint-all-of` — a `match` one part of an `allOf` refuses passes.
- `disjoint-base-child` — a `base:` child is judged by its own schema, which refuses a key only its parent declares, so the `match` requiring it passes.
- `disjoint-merge-child` — a child extending without `base:` is judged by the merged schema, so its parent's key is accepted.
- `disjoint-unjudged-pattern` — `pattern` is read as accepting every value, so a `const` it would refuse is not proved disjoint.
- `refused-at-library` — a loose `match`, a `before` of a type the migration does not rewrite, `rewrite:` naming another library's kind (`SCHEMA_VIOLATION`), and `kind:` naming a kind the library does not re-export and a misspelled own kind (`MIGRATION_KIND_FOREIGN`).
- `refused-by-schema` — `SCHEMA_VIOLATION`: `anyOf` and `x-telo-ref` in a `match`, a `!cel` in `set:`, and a key that is not a diagnostic code.
- `binding-invalid` — `MIGRATION_BINDING_INVALID`: an `at` naming neither a reference slot nor a required key, a `copy:` from no binding, a `move:` from a binding.
- `application-migrations` — `SCHEMA_VIOLATION`: an Application declares no migrations.
- `retype-misfit` — a library's own `telo check`: a kind-only entry retyped to the kind a rule writes is kept, and the body slot the new kind does not fit is `REFERENCE_KIND_MISMATCH` at the body line, never `MIGRATION_FAILED` at the entry.
- `type-unknown` — `MIGRATION_TYPE_UNKNOWN`: a `rewrite:` naming a type the library does not declare and no rule gives a `kind:`; a removed kind every rule of which writes one (a hand-over rule and its fallback) checks clean.
- `consumers/rewrite-under-alias` — a consumer importing the library as `U`: a link node of a named shape moves its `href` under a written `to: { kind: U.Navigate }`, and the inline navigation it produced is migrated in turn, both migrations reported at the link; an inline page at a reference slot and a removed kind at a slot (`U.Box` → `U.Panel`) are candidates; a `kind:` map at an open-typed position is untouched.
- `consumers/rename-under-any-alias` — `beforeMigrations:` moved to `prepare:` under the alias `Db`; a node holding both is `MIGRATION_FAILED` naming `/prepare`, left as written, its schema findings held back.
- `consumers/failures` — two migrations forming a cycle, a rule whose result still satisfies its match, two moves to one destination and a misspelled `set:` key are each `MIGRATION_FAILED`; two independent migrations on one node both apply and the five keys no rule mentions are kept.
- `consumers/declaration-positions` — inline own-kind declarations inside an `!if` branch, a template-body entry and a `with:` member are candidates, as is an own-kind map under a legacy key of an own node; a foreign `kind:` map there and one at an open-typed position are untouched.
- `consumers/hand-over-account` — one `V.Data` placed by two composites becomes one `V.Query`, and each composite a `query` node carrying its content; a `loading` the declaration holds is copied as `loading: [<it>]` and one it lacks writes no key; a composite placing a `V.View` is untouched and reports nothing, and a `resources.me` read keeps no hand-over from firing; `me` is three findings — its own anchor and each composite's.
- `consumers/hand-over-inline` — an inline `V.Data` at a composite migrates the same way at a top-level document, inside an `!if` branch, a template-body entry and a `with:` member, each reported once, at the composite: a rewrite nested inside an outermost anchor of the same code is not reported again.
- `consumers/hand-over-pointer` — a composite under a JSON-Pointer reference into a named shape (`telo://Self/Node#/$defs/Region`), whose items name the shape through a local `#`, is a candidate of the shape, and migrates with its inline `V.Data`.
- `consumers/referent-at-foreign-slot` — a `!ref me` at another library's slot keeps the hand-over from firing: `me` takes the fallback and becomes a `V.View` holding the `query` node, and the composite placing it is left as written.
- `consumers/referent-exported` — the same for a referent a library lists under `exports.resources`.
- `consumers/referent-supplied` — the same for a referent supplied to a library's `resources:`, whose kind-only `{ kind: V.Data }` entry is retyped to `V.View`, the kind the fallback writes.
- `consumers/referent-supplied-no-fallback` — without the fallback rule `me` is `MIGRATION_FAILED` naming `imports.Panel.resources.data`, and the library's entry is `MIGRATION_FAILED` for want of a replacement.
- `consumers/referent-shadowed-with` — a `!ref me` inside a `with:` scope declaring a member `me` resolves to that member, so it is no member of the module's `me`: the hand-over still fires.
- `consumers/referent-shadowed-template` — the same for a template body with a sibling entry `me`.
- `consumers/binding-shadowed-with` — a composite inside a `with:` scope declaring a member `me` reads that member through its `resolve` binding, never the module's `me`: the composite is left as written, and the module's own `me` takes the fallback.
- `consumers/binding-shadowed-template` — the same for a template body with a sibling entry `me`.
- `consumers/supplied-missing` — an import supplying no resource input the library retypes: `RESOURCE_INPUT_MISSING` names the replacement kind, never the removed one.
- `consumers/supplied-wrong-kind` — an import supplying a resource of another kind to a retyped input is `RESOURCE_INPUT_KIND_MISMATCH` against the replacement kind.
- `consumers/referent-legacy-key` — a `!ref me` at a key the current schema does not type, read by no rule, keeps the hand-over from firing: `me` takes the fallback (the key's own `SCHEMA_VIOLATION` stays).
- `consumers/referent-named-shape-slot` — a `!ref me` at a slot declared inside a named shape, reached through a `with:` member and read by a rule, lets the hand-over fire.
- `consumers/referent-unreferenced` — a named removed-kind declaration nothing references takes the fallback: it becomes a `V.View` holding the query beneath it.
- `consumers/referent-unreferenced-no-fallback` — without a fallback the unreferenced declaration is left as written and `MIGRATION_FAILED`: nothing references it, so no node would take over what its hand-over rule drops.
- `consumers/kind-only-retype-misfit` — a retyped kind-only entry is kept when the new kind does not fit a body slot of the library; the library's own findings, `REFERENCE_KIND_MISMATCH` at the body line, reach the consumer's `telo check` through the dependency verdict.
- `consumers/binding-reads` — a `resolve` binding without `before` reads its referent as migrated; two declarations reading each other are `MIGRATION_FAILED` at both.
- `consumers/kind-only-retype` — a kind-only entry whose replacement is itself removed is retyped straight to the declared kind; one whose rules write two different kinds is left as written, `MIGRATION_FAILED` naming both rules.
- `consumers/no-alias` — a file reaching the library only through another library cannot spell the kind a rule writes: `MIGRATION_FAILED` naming the import to add.

## Runners

- `analyzer/nodejs/tests/library-migration-conformance.test.ts` — the Node analyzer: the matcher, the checks and the consumer rows.

- `analyzer/rust/tests/library_migration_conformance.rs` — the Rust analyzer: the matcher, and every consumer row refused, since the Rust build applies no library migration.

The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
