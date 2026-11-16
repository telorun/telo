---
status: done
priority: high
depends-on: []
packages: [analyzer/nodejs, analyzer/rust, kernel/nodejs, kernel/rust, cli/nodejs, cli/rust, sdk, packages/ide-support, modules/postgres, modules/sqlite, docs, apps/authoring-agent, apps/hub]
refinement: not-ready
---

# Library-authored manifest migrations

## Problem

A library that renames, reshapes or removes part of its vocabulary breaks every consumer manifest written against the old spelling, and it has no way to repair them. Today migrations are core-only JSON entries: a data matcher plus six fixed patch operations, run per file at parse time. That engine is right for the core grammar it repairs, but it cannot serve a library:

- **It matches the raw `kind:` text before imports resolve.** A library's kinds are spelled through the consumer's alias, so `schema-prepare-bucket`, which names `Postgres.Schema`, already misses a consumer that imports postgres as `Pg`.
- **It sees only documents.** Most `ui` breaks sit on nodes of a named shape (`Ui.Node`) nested inside other kinds' configuration.
- **It cannot make structural moves.** The operations rename a key, set a scalar or add a key. They cannot wrap or move a subtree, change a declaration's kind, or read a referenced declaration.

The grammar lets each of these breaks ship a migration; each migration ships with the change that makes its break, except `postgres` / `sqlite`'s, which this plan moves out of the core layer:

- press-and-record-detail: a `link`'s `href` becomes `to: { kind: Ui.Navigate, href }`.
- ui-query-reads (`UI_DATA_REPLACED`): a `Ui.Data` becomes a `Ui.Query`, and each node placing it becomes a `query` node carrying its trees, inline and named alike; a `Ui.Data` whose trees cannot move to its placing nodes becomes a `Ui.View` around a `query` node.
- `postgres` / `sqlite`: `beforeMigrations` (today's `schema-prepare-bucket`), under any alias.

Three breaks stay manual: ui-action-form (an action's form definition fits neither a call nor a mutation) and ui-record-pages' listing openers (pages are new top-level documents), because the rewrite needs content a migration has no place to put; and durable-execution-remainder (`DurableLocal.Status` names its `workflow` instead of its `journal`), because finding the workflow is a reverse lookup the grammar does not have — that plan's `Added` fragment describes the one-line hand edit.

## Constraints

- Migrations must be able to run in browser
- Ui.Data must be migratable into Ui.Query
- Migrations must handle resources passed to another library via `resources:`.

## Surface

**Added**
- `migrations:` — a `Telo.Library` key: a map from a migration's diagnostic code (`<SUBJECT>_<PROBLEM>`) to `{ severity?, reason, rules }`.
- `severity` — `warning` (default), `info` or `hint`: the severity a migration reports with.
- `reason` — the migration's message, shown at every node it rewrites.
- `rules` — the migration's `rewrite` items, in order.
- `rewrite` rule — `{ rewrite: <type>, match, remove?, move?, copy?, set?, resolve? }`: rewrites a legacy value of one of the library's types; everything it does not mention is kept as written.
- `match` — the legacy spelling's recognizer, a closed vocabulary spelled as a subset of the kind-schema grammar: `type`, `required`, `const`, `enum`, `properties` and `items` holding the same, and `<key>: false` under `properties` for an absent key.
- `remove` — JSON Pointers into the matched node, deleted from it.
- `move` — a map of source → destination pointers within the matched node; the node at the source lands at the destination exactly as written, and the source is deleted.
- `copy` — the same with the source kept; a source may also be `<binding>#<pointer>`, into a binding.
- `set` — a partial node merged over the matched node: literals only; it carries nothing.
- `resolve` entry — `{ at, before? }`: binds the declaration at a pointer into the old node, as migrated or, with `before`, as it was before this migration's hand-over rule of that type.
- `MIGRATION_KIND_FOREIGN`, `MIGRATION_MATCH_OVERLAPS_SCHEMA`, `MIGRATION_BINDING_INVALID`, `MIGRATION_TYPE_UNKNOWN` — library-side `telo check` errors, with no `ERR_` twin.
- `MIGRATION_FAILED` / `ERR_MIGRATION_FAILED` — a library migration could not be applied to a consumer's node.
- `declared by <module> (<source>)` — the second line of a library migration's diagnostic in `telo check`, naming the library responsible.
- ``run `telo migrate <path>` to apply`` — the third line of a library migration's diagnostic in `telo check`, the path that of the module whose file holds the node.
- `comment dropped: <text>` — `telo migrate`'s stderr line naming a comment inside a re-rendered part.
- `kernel/specs/manifest-migrations.md` — the normative spec of both migration layers.
- `analyzer/library-migration-conformance/` — before/after and matcher vectors of the library stage.
- `tests/manifest-migrations.yaml` and `tests/__fixtures__/manifest-migrations/<code in kebab case>/` — where a library proves its migrations, one legacy-spelling fixture per migration.

**Changed**
- `telo migrate <paths..>` — also applies library migrations, over each given module's whole closure, writing only that module's own files; a path may name a Library as well as an Application. It writes every node that converged and is writable, leaves the rest as written with the reason the load gives, and exits 1 while any `MIGRATION_FAILED` remains in the loaded graph or anything is not written, 0 otherwise.
- `telo migrate -o json` envelope — gains `failed: [{ migration, module, file, path, message }]`, each `unwritable` item carries its `reason`, and `ok` is false exactly when the exit status is 1.
- `telo check` severity — a diagnostic of severity `info` or `hint` prints that label and carries it as `-o json` `severity`, instead of `warning`.
- `not written: <reason>` — `telo migrate`'s stderr line for a rewrite it could not write in place, for core and library migrations alike (the core line "could not be rewritten in place" takes this form).
- `SQL_BEFORE_MIGRATIONS_RENAMED` — declared by `postgres` and `sqlite` themselves, so it reaches a consumer under any alias.
- `ERR_UNSUPPORTED_MANIFEST_FEATURE` — the Rust `telo check` (a host refusal on stderr, `ok: false` and no diagnostic in the envelope) and the Rust kernel (at load) raise it for the `imports:` entry first reaching a library whose module doc declares `migrations:`, only when a node of the closure could be a candidate of one of its rules, naming that node; a consumer holding only current spelling checks and runs. Each refused manifest is an `unsupported` debt entry of the parity sweep's `check` dimension.

**Removed**
- `analyzer/migrations/schema-prepare-bucket.json` — the core entry, now a migration of `postgres` and `sqlite`.
- `analyzer/check-conformance/vectors/migration-schema-prepare-bucket/` — the vector that pinned the core entry.

## Solution

### Two layers

- **Core grammar** — tags, the definition and annotation grammar, the built-in documents: everything loading and reading definitions themselves depend on. It stays on the JSON data engine, unchanged, run per file before precompile and desugar, in both analyzers. A core change keeps extending that engine's own vocabulary.
- **Library vocabulary** — a library's own kinds and shapes, as the consumer's aliases spell them. It is the new stage below.

Core entries repair the grammar that reading definitions depends on, so they must finish first, and their targets need nothing resolved; library migrations need the consumer's aliases. One typed engine for both was rejected: it would need a privileged core-only target for the untagged-string wildcard and the whole typed engine on Rust's boot path.

### Declaring a migration

A library declares its migrations under `migrations:` on its `Telo.Library` doc, beside the definitions they repair; they ship in the manifest layer.

- A migration is data the loader reads: no controller, no lifecycle, nothing created.
- Its key is its diagnostic code, which names it everywhere — in a consumer's diagnostic (with the declaring module), in `telo migrate`'s output and in a refusal. A map key is unique by construction, and a malformed one is `SCHEMA_VIOLATION`.
- `Telo.Application` has no `migrations:` key (`SCHEMA_VIOLATION`), since an Application has no importers.
- It is not exported and not gated. It applies to every file whose import closure reaches the library, published dependencies included.
- `rules:` holds `rewrite` items, each a statement with `rewrite` as its required key, as steps are. A rule is not a resource.

A migration is metadata about the library, with no instance and nothing naming it but its diagnostic, so it sits on the module doc beside the definitions it repairs, and the code is its one identity.

### Recognizing the legacy spelling

A `rewrite` names one type of its own module (`Self.<Name>`): a kind, a named shape, or a kind name the module no longer declares. `rewrite` and `before` take only `Self.<Name>`, by a pattern in the `Telo.Library` schema (`SCHEMA_VIOLATION` otherwise): a type has one owner who knows its history, a re-exporter's proof would break on the owner's next release, and a node is a candidate of exactly one module's rules.

- **Candidates for a kind:** every declaration of it the analyzer reads — top-level documents, inline declarations at slots and at an import's `resources:` supply, template-body entries, `with:` members, branches of `!if` / `!switch` / `!for-each`.
- **Kind-only declarations** — a Library's `resources:` entry and a `needs:` entry naming a kind its module no longer declares — are retyped to that kind's **replacement**: the kind every rule of it that is not a hand-over rule writes at the declaration's root (`set: { kind: … }`), in any migration, followed onward while that kind is itself removed, until a declared kind. It is spelled in the declaring module's alias and written at the entry's `kind:`. Hand-over rules do not count, because a supplied declaration never takes the hand-over. A replacement that is not exactly one declared kind — no such rule, two rules writing different kinds, a cycle — leaves the entry as written with `MIGRATION_FAILED` naming the removed kind and each rule involved; the order of migration codes decides no kind. A retyped entry is kept; how its new kind fits the library's body is judged by the library's own analysis of its migrated tree — at the body's own position in the library's check, through the dependency verdict in a consumer's.
- **Candidates for a shape:** every value at a schema position that a current kind schema types by that shape.
- **Removed types:** a `rewrite: Self.<Name>` naming no type the library declares is a removed kind, provided some rule of the library rewriting `<Name>` writes `kind:` at its root (in any migration, hand-over rules included); any other undeclared target is `MIGRATION_TYPE_UNKNOWN`. A removed shape is never a target: a shape value carries no name, so a legacy spelling at a position whose shape was removed or replaced is a rule of the type holding that position now — the current shape there, or the nearest own kind or shape enclosing it.
- **Recognition:** `match:` is a closed matcher, evaluated as data by a small matcher, not by a JSON Schema validator: `type`, `required`, `const`, `enum`, and `properties` / `items` holding the same vocabulary, with `<key>: false` under `properties` meaning the key is absent. Anything else in `match`, `$ref` and `x-telo-ref` included, is `SCHEMA_VIOLATION` at the library. A tagged value never satisfies `type`, `const` or `enum`, and satisfies `required`. A rule's **recognition** of a candidate is its `match` holding and every `resolve` entry with `before` finding its referent rewritten by that type's hand-over rule; a candidate is migrated only where a rule recognizes it, so a `composite` placing a `Ui.View` satisfies a `match` and is still not recognized.
- **Legacy positions:** inside any value typed by one of the module's own types, and inside the whole body of an own kind no longer declared, the walk visits every position the current schema does not type. A map there whose `kind:` resolves canonically to an own type is a candidate of that type's rules — an inline declaration always names its kind — and a foreign `kind:` is carried as written. A position typed by an open schema counts as typed, so payload data is never scanned. A shape value at a legacy position is not a candidate where it sits: it is walked once a rule moves or copies it to a typed position, and otherwise current validation reports it as the unknown key it is. Reach is a property of the module's types alone, so editing or retiring one rule changes no other rule's candidates.
- **Identity** is canonical, through the reading file's alias and re-export tables; rules are bound per import edge.
- **Containment:** a rule reaches only its own module's types. A foreign declaration or foreign-shaped value inside a matched node can be moved or copied but never read or changed.
- **Cost:** the stage walks only the positions typed by a targeted type, through an index of targets built once per load; a closure declaring no `migrations:` costs nothing.

Idempotence without version stamps rests on proving `match` disjoint from the current spelling, so `match` says only what the proof reads. Full JSON Schema whose proof reads a subset was rejected: it still needs the subset spelled out and refused, and would put a tag-aware JSON Schema validator into the Rust twin. There are no version stamps, and a migration is retired by deleting it: a consumer's import pin is not the version its file was written against, and published dependencies must be rewritten whatever they pinned. Deleting a migration is therefore a breaking removal — a published dependent still in the old spelling stops loading — released as the repo's breaking changes are, with an `Added` fragment describing the break, and decided by the library's dependents on the hub.

### The change

A rule writes only what changes; everything it does not mention is kept as written. Every source is read from the matched node as found (its descendants already migrated bottom-up) or from a binding, and the result is built in one step, so the order of the keys never matters:

1. Start from the node; delete each `remove:` pointer and each `move:` source (removing an absent pointer does nothing).
2. Merge `set:`: a map written over a map merges recursively, any other value replaces the old one, a YAML `null` writes null.
3. Place every moved or copied node, exactly as written — tags, `!if` / `!switch` / `!for-each`, foreign content and its text included — at its destination.

Whether a destination is already held, or two writes reach one position, is judged against the matched node as found: a move beneath a map `set:` writes as a literal (`set: { to: { kind: Self.Navigate } }` with `move: { /href: /to/href }`) lands inside it.

- **Moves and copies:** `move:` and `copy:` map a source pointer to a destination pointer. A source is `/<pointer>` into the matched node, or, for `copy:`, `<binding>#<pointer>` into a `resolve` binding; a rule writes only its own node, so it never moves from a binding. A destination follows JSON Patch `add`: a member is set, an index inserts, `-` appends, and missing maps and lists on the way are created. A missing source writes nothing and creates no container, so a key can be conditional: `copy: { data#/loading: /loading/0 }` writes `loading: [<it>]` only when the `Ui.Data` had one.
- **`set:`** holds literals only, and any tag in it is `SCHEMA_VIOLATION`. A reference reaches a new position by moving or copying the node's own reference, never by naming a binding.
- **Kinds:** a `kind:` in `set:` is a literal, spelled library-relative (`Self.Navigate`, or `<Alias>.<Kind>` for a kind the library re-exports), and written in the consumer's alias, so a consumer aliasing `ui` as `U` receives `U.Navigate`. At the matched declaration's root it changes that declaration's kind; `metadata` is kept by the engine, so a name and every reference to it survive. This is also how a library renames a kind at its declarations; a kind named in another library's definition (`extends:`, an `x-telo-ref` kind) is renamed by deprecating the old kind with `replacedBy` for a release, then removing it.
- **Nested matches:** rules apply bottom-up, so descendants are already migrated when the parent's rule runs.

Unmentioned content survives and moved or copied content is placed by pointer, so tags, choices and foreign content are never turned into values. No CEL runs in a migration; computed data is added when a migration needs it, with a measured floor. Rejected: one `!cel` expression over the node as source data, which needed CEL types for a tagged scalar and for opaque content usable nowhere else in a manifest; a whole-node template, which silently drops any optional key its author forgot to list.

**Bindings** are declared on the rule and never written:
- `resolve: { <binding>: { at, before? } }` binds the declaration at `at` (a pointer into the matched node), written inline there or named by the `!ref` there. Without `before` it is read **as migrated**, typed by its kind's current schema. With `before: Self.<Type>` it is read **as it was before this migration's hand-over rule of that type**, typed by that rule's `match` — how a node placing a declaration takes over the fields the declaration's own rewrite drops. The engine keeps each rewritten node's input for the whole load.
- A binding may read foreign kinds. Referents in the same module instance are migrated first; referents in dependencies are already current, because modules are processed in import post-order.
- A cycle among binding reads, or a referent that failed, is `MIGRATION_FAILED` at each node involved.

A binding reads its referent migrated, or as it was before its own rewrite, so a rule is written against one spelling of what it reads, never against every historical one.

**A hand-over commits as a whole, or falls back.** The **hand-over rule** of a type is the first rule of that type in a migration that another rule of the same migration reads with `before`; every later rule of the type in that migration is its **fallback**. The referent's members are every `!ref` in its module instance that resolves to it — at a slot or not, resolved as the analyzer resolves `!ref`, scope first innermost out and a template body's siblings first, in any branch — and every `exports.resources` entry naming it: a reference slot of any kind or shape, own or foreign, a `targets:` entry, a step `invoke:`, a template-body dispatch slot, a `with:` member slot, an import's `resources:` / `needs:` supply. A CEL read of `resources.<referent>` is not a member: it carries no content, and analysis after the stage types it against the new kind. The hand-over rule fires on a referent only when it has at least one member and every member position is the `at` of a `resolve` with `before` of the referent's type, in a rule of the same migration that fired on the node holding it and converged, and every rewritten node passes the current schema — each node validated as it converges, the group judged before anything of it is kept in memory. A foreign slot, a `targets:` entry, a step `invoke:`, a `with:` slot, an import supply or an export therefore always keeps the hand-over from firing, since no rule can sit there; so does a reader that failed. Then the referent takes the type's fallback rule, the readers' `before` finds no hand-over, and every node holding a member is left as written and still current, because it places a referent that is now current. With no fallback the referent stays as written and reports `MIGRATION_FAILED` naming the position that kept the hand-over from firing.

**Content never crosses a module-instance boundary.** A library supplied the referent, or an importer of an exported one, keeps placing it whole: the fallback keeps the content on the referent. Every module's result depends on its own source and its libraries' types alone, so an application and the library it supplies are migrated separately, in either order, to the same files.

A migration never creates a top-level document or changes another document: moving content out of a referent is one write per node, committed together or not at all, so moved content never survives only in version control.

### Chained migrations

A library accumulates migrations as its vocabulary changes, and a consumer two releases behind needs both on one node. Each node is brought to a fixpoint:

1. Apply the first rule whose target types the node, whose recognition holds for the node's **current** value, and which has not yet fired on it — a hand-over rule only when its hand-over fires. Order: the migration's code, then the rule's position.
2. Each rule fires at most once per node, so the loop terminates by construction.
3. When none applies and some rule's recognition still holds, the node is `MIGRATION_FAILED` (a cycle among migrations).
4. Content a rule produced is walked in turn; a node already at its fixpoint is not re-entered.

A node reports one diagnostic per migration that fired on it, at the consumer's own line, with the migration's `severity`.

Without stamps a node's age is known only by which `match` it satisfies now, hence the fixpoint.

### Where it runs

One stage of the loaded graph, not of a file. Each file is parsed, desugared, precompiled and run through the core layer as today; a tagged or compiled value is carried by position, and a rule reading one as data is `MIGRATION_FAILED`. The library stage then runs once the whole import closure has loaded — `imports:` entries and scoped `Telo.Import` members — and module versions are reconciled, and before flatten, inline extraction, `!ref` resolution, choice expansion and every analysis pass; modules in import post-order.

- **Registration first.** The definition registry and the per-module alias resolvers are built once from the closure's kind documents and the graph's import edges, before the stage, and the same registration serves the stage and the analysis after it. No rule rewrites a definition's `schema`, `extends` or contracts, which are all the registration holds; inside kind documents the only candidates are template-body entries and inline `targets:` items, which the registration does not read — expansion and the call graph read them from the migrated tree.
- **Candidates are found by the analyzer's existing readers**, each read in the alias scope of the module declaring the document: the reference reach (inline declarations at slots, recursed with the inline kind's own reach, as inline extraction does), the expansion-site and branch readers (each `!if` / `!switch` / `!for-each` branch typed by its position's schema, as expansion does), template-body entries, and the scoped name resolver over a reading built from graph membership. Named-shape positions come from the value/schema co-walk the text-site check already used, extracted and shared, so it is one positional walk whose readers are the text sites, the schema sites and the stage; its untyped positions are the legacy positions. An annotation keeps one reader, and a new annotation touches no stage code.
- **One result per module source.** Instances of one source share its files and the reconciled closure, and the stage migrates every branch rather than a decided one, so nothing it reads depends on instance variables. Every reader takes that result: flatten, the dependency verdict, the kernel's import loading and the editor engine.
- Nothing is created before it: the kernel creates resources only from the migrated tree. As for core migrations, every file is rewritten in memory, only the entry module's files report, provenance remaps diagnostics onto the author's spans, and the round-trip view keeps the stage off: a graph carries the load's `migrate` stamp, and the stage runs only on a graph stamped `migrate`. The stage is analyzer code and runs in the browser.

The author's trees are edited while the analyzer's readers say what each node is, so write-back keeps the author's spans and no annotation gets a second reader. Rejected: a raw-tree walk of its own, a second reader of every slot annotation that drifts at the first new one; running on the normalized tree, which puts the stage inside analysis once per import site and makes write-back rebuild `!ref` text and unfold extracted declarations.

**Rust half:** the Rust `telo check` and the Rust kernel refuse the `imports:` entry first reaching a library whose module doc declares `migrations:` only when a map in a file whose closure reaches it could be a candidate, with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the library, the migration and the node. The test is position-free and reads only the library's module doc: the Rust analyzer reads `migrations:` and twins the matcher, held to the matcher vectors, and scans resource documents and the template-body entries and inline `targets:` of kind documents. For a kind it refuses when a map's `kind:` names the kind by its last segment and the map satisfies a rule's `match`, or a rule of that kind writes `kind:` at its root (which covers the kind-only declarations a retyping rewrites); for a shape, when any map satisfies a rule's `match`. A rule with `before: Self.<Type>` counts only when some map of the closure names `<Type>` by its last segment, so a current `composite` node is not refused because a rule handing a `Ui.Data` over to composites exists. Over-refusing is safe, and the parity sweep catches the one unsound outcome, Rust accepting where Node reports a migration. The check's refusal is a host refusal — the file is held back, the refusal goes to stderr and the envelope reports `ok: false` with no diagnostic — so the parity sweep records each refused manifest as an `unsupported` debt entry. Applying a migration needs the readers, which is the whole stage; the vectors in `analyzer/library-migration-conformance/` are the contract a later Rust twin is held to, run by Node today.

Ignoring a migration changes what a manifest means, so a build that cannot apply one refuses the import where one may apply, as an unknown critical feature is refused. Rejected: a warning leaving legacy nodes to schema validation, which over-reports against Node on every such consumer; a warning in check and a refusal in run, which splits check from run on one manifest.

### Checks

At the library's own `telo check`, each an error; a consumer's `telo check` reports them through the dependency verdict, and the kernel never runs them — they are publisher defects a consumer cannot fix, and one that reaches a consumer surfaces as `MIGRATION_FAILED`:

| Code | Refused when |
|---|---|
| `MIGRATION_MATCH_OVERLAPS_SCHEMA` | Neither the rule's `match` nor the `match` of a rule its `resolve` entries name with `before` is proved disjoint from the current schema: no required key the closed current schema lacks, no `const` / `enum` it refuses, and the kind still declared. The message names the branch and the cause and the fix: require a key, or pin a `const` / `enum` that branch refuses. |
| `MIGRATION_KIND_FOREIGN` | A `kind:` in `set:` names a kind that is neither declared by the library, nor re-exported by it, nor a removed own kind some `rewrite:` of the library names. |
| `MIGRATION_TYPE_UNKNOWN` | A `rewrite:` names a type the library does not declare and no rule of the library rewriting it writes `kind:` at its root. The message names the type and both fixes: name the current type that holds the position, or add a rule giving the removed kind a `kind:`. |
| `MIGRATION_BINDING_INVALID` | A `resolve` `at` names neither a reference slot of the target's current schema nor a key `match` requires, a `before` names a type no rule of the migration rewrites, a `copy:` source names no binding, or a `move:` source names a binding. |

`set:` is not checked against the target's current schema at the library: a migration is written against the vocabulary of its own release, and judging an older one against today's would turn each later rename into a hand edit of a shipped migration. A tag in `set:` is refused by the `Telo.Library` schema itself (`SCHEMA_VIOLATION`), and the converged result is validated at the consumer.

**The proof reads the schema validation applies** at the target's positions: for a kind, the author schema with the injected `kind` / `metadata`, an `extends` child's merge folded and a `base:` child's own schema; for a shape, its schema with its `extends` parents folded; local and named `$ref` followed. A `oneOf` / `anyOf` is disjoint only when disjoint from every branch, an `allOf` when disjoint from any one part. A branch without `additionalProperties: false` refuses no extra key; a keyword the proof does not judge (`not`, `if` / `then`, `pattern`, `format`, `patternProperties`, dependencies) is read as accepting everything; a reference slot accepts any `!ref` or declaration. A removed kind is disjoint by definition; a rule against the type now holding a removed shape's position is proved against that type's current schema, like any rule. So the proof reads the current schema as at least as permissive as it is, and is refused only where that reading accepts a matched value.

**A rule's result is not proved at the library.** Since `match` is disjoint from the current schema, a result still satisfying its `match` fails the current schema, and every converged result is validated at the consumer's `telo check`. A library shows its rules work by a legacy-spelling fixture per migration, `tests/__fixtures__/manifest-migrations/<code in kebab case>/`, asserted by `tests/manifest-migrations.yaml`, loading with that migration's diagnostic, those of the migrations chained after it, and no other finding — guidance, not a gate.

At a consumer, the converged result of every node is validated against the current schema. A `set:` map merging into a value that is not a literal map, two writes reaching one position, a value at a `resolve` `at` that is neither a `!ref` nor a map with `kind:`, a data read reaching a tagged or compiled value, a move or copy onto a position the node holds and the rule does not remove, a copy from a declaration in another module instance, a result that fails the current schema, a kind the consumer cannot spell (no alias in the file names the library; the message names the import to add), a leftover match (naming the rule left matching), a binding failure or a hand-over that cannot fire with no fallback leaves the node untouched and reports `MIGRATION_FAILED` at the node — at the `imports:` entry for a dependency's file — naming the migration and the cause; the validator's findings under that node are held back. The kernel's load raises the same as `ERR_MIGRATION_FAILED`.

### Write-back

`telo migrate <path>` writes only the given module's own files — an Application's or a Library's, so a workspace's own libraries are repaired by naming them; a library's files are never written through a consumer's load, whose reconciliation could put a spelling into it that its own pins refuse:

- **Rewrite:** the matched node's span is replaced by its converged value, rendered in the node's own style (block or flow, its indentation). Inside it, an entry kept at the same key with an equal value, and an item kept at the same index with an equal value, keeps its original text byte for byte, comments included. Everything else is rendered fresh; a comment inside a re-rendered part is lost, and the command names each one (`comment dropped:`).
- **Kind change:** the same rule at the declaration's node.
- **Unwritable**, reported per location with its reason (`not written:`): a replaced span holding an anchor or an alias. A hand-over with an unwritable member is not written at all.
- **Partial runs:** every node that converged and is writable is written, a failed or unwritable one is left as written and reported, and the command exits 1 while anything is pending — a `MIGRATION_FAILED` anywhere in the loaded graph, a dependency's included, or a rewrite not written. `telo upgrade` moves pins only: a node that needs a hand edit needs the new spelling, which only the new pin accepts, so withholding the pin until the repair succeeds would deadlock. Repair is `telo migrate` after the upgrade.
- When a migration reaches an editable library only because a consumer reconciled a dependency to a newer version, the library's own pin is moved first with `telo upgrade <library>`, then `telo migrate <library>` runs on it.

The editor offers the same edit set as a quick fix when none of it is unwritable.

### Stdlib moves and obligations

- `schema-prepare-bucket` moves into `postgres` and `sqlite` as a `rewrite: Self.Schema` under `migrations: { SQL_BEFORE_MIGRATIONS_RENAMED: … }`, so `Pg.Schema` is now migrated; each proves it in `tests/manifest-migrations.yaml` over `tests/__fixtures__/manifest-migrations/sql-before-migrations-renamed/`. The check-conformance vector that pinned the core entry is retired; the aliased case lives in `analyzer/library-migration-conformance/`.
- The ui-query-reads plan states `UI_DATA_REPLACED` in this grammar, its fallback rule included; the durable-execution-remainder plan ships no migration.
- The Rust analyzer reads `migrations:` and twins the matcher, run against the matcher vectors.
- The built-in vocabulary's `Telo.Library` entry gains `migrations:`, with `match`'s closed vocabulary as its schema.
- Docs: `docs/extend/manifest-migrations.md` (the library surface, `match`'s vocabulary, `remove` / `move` / `copy` as positional operations and `set` as literal data only, everything unmentioned kept, both binding readings, the hand-over rule and its fallback, content never crossing a module-instance boundary, kind-only declarations retyped, what write-back keeps and loses, the fixture guidance, how a kind is renamed, retiring a migration as a breaking removal), the `telo migrate` reference (a Library as a path, partial runs and the exit status, `telo upgrade` moving pins only), `kernel/specs/manifest-migrations.md`, the analyzer's migrations guide (its "no post-resolution phase" paragraph becomes the two-layer rule and the stage's position), `docs/reference/diagnostics.md` (the new codes; `SQL_BEFORE_MIGRATIONS_RENAMED` under its modules).
- The authoring-agent primer and the hub's `guide_design_library` gain library migrations.
- Benefits ledger, under "For module authors": consumers' manifests repaired when a library renames or reshapes its vocabulary.
- `tests/check-run-agreement.yaml` gains `MIGRATION_FAILED` rows and a row where a `Ui.Data` supplied to a library loads migrated through the fallback.
- `telo release floor` runs on the change; `postgres`, `sqlite` and every library adopting `migrations:` carry the measured floor.
- Fragments: an `Added` one for the telo line (library migrations, `telo migrate` on a Library) and one for `postgres` and `sqlite` (the migration now declared by the module, reaching every alias).

## Examples

The `ui` migrations below ship with the changes that make those breaks; here they show the grammar on real vocabulary, and `analyzer/library-migration-conformance/` runs each as a vector over a fixture library declaring the same kinds and migrations.

### A rewrite, and a consumer

`ui` ships the press plan's `link` change on its module doc in `modules/ui/telo.yaml`:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.14.0
  license: MIT
lang: en
migrations:
  UI_LINK_HREF_MOVED:
    reason: A link's destination is a navigation effect, so every press target is written one way.
    rules:
      - rewrite: Self.Node
        match: { type: object, required: [type, href], properties: { type: { const: link }, to: false } }
        move: { /href: /to/href }
        set: { to: { kind: Self.Navigate } }
```

Before — a consumer written against `ui` 0.13, importing it as `U`:

```yaml
kind: Telo.Application
metadata: { name: Library }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  U: oci://ghcr.io/telorun/ui@0.13.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
ports: { http: { env: PORT, default: 8080 } }
targets: [!ref server]
---
kind: U.Page
metadata: { name: authors }
path: /authors
title: Authors
children:
  - { type: text, text: Authors, style: title }
---
kind: UiReact.App
metadata: { name: app }
title: Library
theme: !ref UiReact.defaultTheme
pages:
  - kind: U.Page
    path: /
    title: Home
    children:
      # The list of authors lives on its own page.
      - { type: link, text: Authors, href: { path: !ref authors } }
  - !ref authors
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref app }
```

After moving the pin to the `ui` release that ships the migration, it still loads, and `telo check` reports the migration at the consumer's own line:

```text
$ telo check
telo.yaml:28:9  warning  A link's destination is a navigation effect, so every press target is written one way.
declared by ui (oci://ghcr.io/telorun/ui@0.14.0)
run `telo migrate telo.yaml` to apply
UI_LINK_HREF_MOVED
```

```text
$ telo migrate telo.yaml
UI_LINK_HREF_MOVED (ui)  telo.yaml  1 rewrite

1 rewrite in 1 file. Imported modules were not touched.
```

After — the only change `telo migrate` makes; the comment stays, and the kind is written through the consumer's alias:

```yaml
kind: UiReact.App
metadata: { name: app }
title: Library
theme: !ref UiReact.defaultTheme
pages:
  - kind: U.Page
    path: /
    title: Home
    children:
      # The list of authors lives on its own page.
      - { type: link, text: Authors, to: { kind: U.Navigate, href: { path: !ref authors } } }
  - !ref authors
```

The fixture proving the migration, `modules/ui/tests/__fixtures__/manifest-migrations/link-href-moved/telo.yaml`, is written in the legacy spelling under an alias other than `Ui`:

```yaml
kind: Telo.Application
metadata: { name: LinkHrefMoved }
lang: en
imports:
  U: ../../../..
targets: []
---
kind: U.Page
metadata: { name: authors }
path: /authors
title: Authors
children:
  - { type: link, text: Back to authors, href: { path: !ref authors } }
```

and `modules/ui/tests/manifest-migrations.yaml`, which holds one assertion per migration of `ui`, asserts it loads with the migration's warning and nothing else:

```yaml
kind: Telo.Application
metadata: { name: ManifestMigrations }
lang: en
imports:
  Assert: ../../assert
targets: [!ref linkHrefMoved]
---
kind: Assert.Manifest
metadata: { name: linkHrefMoved }
source: ./__fixtures__/manifest-migrations/link-href-moved/telo.yaml
expect: { warnings: [{ code: UI_LINK_HREF_MOVED }], runs: true }
```

### A rename under any alias

`sqlite` carries the migration the core layer used to hold, so it reaches a consumer under any alias:

```yaml
kind: Telo.Library
metadata:
  name: SQLite
  version: 0.15.0
  license: MIT
migrations:
  SQL_BEFORE_MIGRATIONS_RENAMED:
    reason: "`beforeMigrations:` is now `prepare:`; nothing re-runs, because the ledger stores the migration key alone."
    rules:
      - rewrite: Self.Schema
        match: { type: object, required: [beforeMigrations] }
        move: { /beforeMigrations: /prepare }
```

Before — a consumer importing `sqlite` as `Db`, which the core entry never reached:

```yaml
kind: Telo.Application
metadata: { name: Accounts }
variables:
  database: { env: ACCOUNTS_DB, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: accounts.db }
imports:
  Db: oci://ghcr.io/telorun/sqlite@0.14.4
targets: [!ref schema]
---
kind: Db.Schema
metadata: { name: schema }
connection: { kind: Db.Connection, file: !cel "variables.database" }
tables:
  - kind: Db.Table
    table: users
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: text, nullable: false }
# Backfill before `name` becomes NOT NULL.
beforeMigrations:
  20260501_backfill_names: { statement: "UPDATE users SET name = '' WHERE name IS NULL" }
```

After moving the pin to `sqlite` 0.15.0:

```text
$ telo check
telo.yaml:9:1  warning  `beforeMigrations:` is now `prepare:`; nothing re-runs, because the ledger stores the migration key alone.
declared by sqlite (oci://ghcr.io/telorun/sqlite@0.15.0)
run `telo migrate telo.yaml` to apply
SQL_BEFORE_MIGRATIONS_RENAMED
```

The key is renamed, so its line is rendered fresh and the comment above it is dropped; the moved value keeps its text:

```text
$ telo migrate telo.yaml
SQL_BEFORE_MIGRATIONS_RENAMED (sqlite)  telo.yaml  1 rewrite
  telo.yaml:18:1  comment dropped: # Backfill before `name` becomes NOT NULL.

1 rewrite in 1 file. Imported modules were not touched.
```

After, the schema document reads:

```yaml
kind: Db.Schema
metadata: { name: schema }
connection: { kind: Db.Connection, file: !cel "variables.database" }
tables:
  - kind: Db.Table
    table: users
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: text, nullable: false }
prepare:
  20260501_backfill_names: { statement: "UPDATE users SET name = '' WHERE name IS NULL" }
```

### Chained migrations

A later `ui` release renames `Ui.Navigate`'s `href` to `address` and adds a second migration beside the first:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.15.0
  license: MIT
lang: en
migrations:
  UI_LINK_HREF_MOVED:
    reason: A link's destination is a navigation effect, so every press target is written one way.
    rules:
      - rewrite: Self.Node
        match: { type: object, required: [type, href], properties: { type: { const: link }, to: false } }
        move: { /href: /to/href }
        set: { to: { kind: Self.Navigate } }
  UI_NAVIGATE_HREF_RENAMED:
    severity: info
    reason: Every destination names where it goes as its address.
    rules:
      - rewrite: Self.Navigate
        match: { type: object, required: [href] }
        move: { /href: /address }
```

The consumer above, still written against 0.13, is brought to the newest spelling in one run: the first migration produces an inline `U.Navigate` declaration, the walk enters it, and the second migration fires on it. `telo check` reports both at the consumer's line, each with its migration's severity:

```text
$ telo check
telo.yaml:28:9  warning  A link's destination is a navigation effect, so every press target is written one way.
declared by ui (oci://ghcr.io/telorun/ui@0.15.0)
run `telo migrate telo.yaml` to apply
UI_LINK_HREF_MOVED
telo.yaml:28:9  info  Every destination names where it goes as its address.
declared by ui (oci://ghcr.io/telorun/ui@0.15.0)
run `telo migrate telo.yaml` to apply
UI_NAVIGATE_HREF_RENAMED
```

`telo migrate` writes `{ type: link, text: Authors, to: { kind: U.Navigate, address: { path: !ref authors } } }`, counting the node once per migration that fired on it, and a second run reports no rewrite:

```text
$ telo migrate telo.yaml
UI_LINK_HREF_MOVED (ui)  telo.yaml  1 rewrite
UI_NAVIGATE_HREF_RENAMED (ui)  telo.yaml  1 rewrite

2 rewrites in 1 file. Imported modules were not touched.
$ telo migrate telo.yaml
✓  Nothing to migrate
```

A file that reaches `ui` only through another library cannot spell the kind a rule writes, and the node is left as written. Here `Shop` (`./shop`) imports `ui` and exports the `home` page:

```yaml
kind: Telo.Application
metadata: { name: Catalog }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
  Shop: ./shop
ports: { http: { env: PORT, default: 8080 } }
targets: [!ref server]
---
kind: UiReact.App
metadata: { name: app }
title: Catalog
theme: !ref UiReact.defaultTheme
pages: [!ref Shop.home]
notFound:
  - { type: link, text: Back to the shop, href: / }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref app }
```

```text
$ telo check
telo.yaml:17:5  error  The migration UI_LINK_HREF_MOVED of ui could not be applied: it writes the kind Ui.Navigate, and telo.yaml has no import of ui to spell it with. Add `Ui: oci://ghcr.io/telorun/ui@0.15.0` under `imports:` and run again.
MIGRATION_FAILED
```

### A move out of a referent

ui-query-reads replaces `Ui.Data`. The first rule is the hand-over: the `Ui.Data` becomes a `Ui.Query`, dropping its trees, and each `composite` node placing it becomes a `query` node and takes the trees over, reading the `Ui.Data` as the first rule found it. The third rule is the fallback, for a `Ui.Data` whose trees cannot move: it becomes a `Ui.View` holding a `query` node over an inline `Ui.Query`, with the trees beneath:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.16.0
  license: MIT
lang: en
migrations:
  UI_DATA_REPLACED:
    reason: A read is a query, and what is drawn over its answer belongs to the node that places it.
    rules:
      - rewrite: Self.Data
        match: { type: object, required: [source, content] }
        move: { /source: /url }
        remove: [/content, /loading, /failure]
        set: { kind: Self.Query }
      - rewrite: Self.Node
        match: { type: object, required: [type, ref], properties: { type: { const: composite } } }
        resolve: { data: { at: /ref, before: Self.Data } }
        move: { /ref: /query }
        copy: { data#/content: /children/0, data#/loading: /loading/0, data#/failure: /failure/0 }
        set: { type: query }
      - rewrite: Self.Data
        match: { type: object, required: [source, content] }
        move: { /model: /content/query/model, /source: /content/query/url, /reloadOn: /content/query/reloadOn, /content: /content/children/0, /loading: /content/loading/0, /failure: /content/failure/0 }
        set: { kind: Self.View, content: { type: query, query: { kind: Self.Query } } }
```

`move: { /ref: /query }` carries the `!ref me`, or an inline `Ui.Data` the first rule has already made a `U.Query`. A composite placing a `Ui.View` matches the second rule's `match` but not its `resolve` (no `Ui.Data` was handed over there), so it is untouched and reports nothing. Before, a consumer placing one named `Ui.Data` twice:

```yaml
kind: Telo.Application
metadata: { name: Account }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  U: oci://ghcr.io/telorun/ui@0.13.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
ports: { http: { env: PORT, default: 8080 } }
targets: [!ref server]
---
kind: U.Data
metadata: { name: me }
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [authorized]
    properties: { authorized: { type: boolean }, email: { type: string } }
source: { path: /api/me }
reloadOn: [focus, unauthorized]
content: { type: value, value: !cel "data.email" }
---
kind: UiReact.App
metadata: { name: app }
title: Account
theme: !ref UiReact.defaultTheme
pages:
  - kind: U.Page
    path: /
    title: Home
    children: [{ type: composite, ref: !ref me }]
  - kind: U.Page
    path: /settings
    title: Settings
    children: [{ type: composite, ref: !ref me }]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref app }
```

After `telo migrate` — one `Ui.Query`, and two `query` nodes each carrying the tree:

```yaml
kind: U.Query
metadata: { name: me }
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [authorized]
    properties: { authorized: { type: boolean }, email: { type: string } }
url: { path: /api/me }
reloadOn: [focus, unauthorized]
---
kind: UiReact.App
metadata: { name: app }
title: Account
theme: !ref UiReact.defaultTheme
pages:
  - kind: U.Page
    path: /
    title: Home
    children: [{ type: query, query: !ref me, children: [{ type: value, value: !cel "data.email" }] }]
  - kind: U.Page
    path: /settings
    title: Settings
    children: [{ type: query, query: !ref me, children: [{ type: value, value: !cel "data.email" }] }]
```

Had the `/settings` page written its node with an anchor, `children: [&settingsNode { type: composite, ref: !ref me }]`, the move would load migrated but be written nowhere:

```text
$ telo migrate telo.yaml
UI_DATA_REPLACED (ui)  telo.yaml
  not written: the hand-over of `me` (telo.yaml:11:1) has an unwritable member — telo.yaml:35:16 holds the anchor `settingsNode`. Remove the anchor and run again.

0 rewrites. Imported modules were not touched.
$ echo $?
1
```

### A referent supplied to a library

The application hands `me` to a library of its own, which places it in a view it exports; the application places that view too:

```yaml
kind: Telo.Application
metadata: { name: Account }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
  U: oci://ghcr.io/telorun/ui@0.16.0
  UiReact: oci://ghcr.io/telorun/ui-react@0.14.0
  Panel: { source: ./panel, resources: { data: !ref me } }
ports: { http: { env: PORT, default: 8080 } }
targets: [!ref server]
---
kind: U.Data
metadata: { name: me }
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [authorized]
    properties: { authorized: { type: boolean }, email: { type: string } }
source: { path: /api/me }
reloadOn: [focus, unauthorized]
content: { type: value, value: !cel "data.email" }
---
kind: UiReact.App
metadata: { name: app }
title: Account
theme: !ref UiReact.defaultTheme
pages:
  - kind: U.Page
    path: /
    title: Home
    children: [{ type: composite, ref: !ref me }]
  - kind: U.Page
    path: /settings
    title: Settings
    children: [{ type: composite, ref: !ref Panel.summary }]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref app }
```

`panel/telo.yaml`, still pinning the `ui` release it was written against:

```yaml
kind: Telo.Library
metadata: { name: Panel }
lang: en
imports: { U: oci://ghcr.io/telorun/ui@0.13.0 }
resources:
  data: { kind: U.Data }
exports: { resources: [summary] }
---
kind: U.View
metadata: { name: summary }
content: { type: composite, ref: !ref data }
```

The import's `resources:` supply is a member no rule reads, so the hand-over does not fire and `me` takes the fallback; the composite at `/` places a `U.View`, which is current, and is left as written. The library's input names a kind `ui` no longer declares, so it is retyped to the kind the fallback writes:

```text
$ telo check
telo.yaml:12:1  warning  A read is a query, and what is drawn over its answer belongs to the node that places it.
declared by ui (oci://ghcr.io/telorun/ui@0.16.0)
run `telo migrate telo.yaml` to apply
UI_DATA_REPLACED
panel/telo.yaml:6:9  warning  A read is a query, and what is drawn over its answer belongs to the node that places it.
declared by ui (oci://ghcr.io/telorun/ui@0.16.0)
run `telo migrate panel` to apply
UI_DATA_REPLACED
```

Each module is written by its own run, in either order, with the same result; the library's own pin is moved before its run:

```text
$ telo migrate telo.yaml
UI_DATA_REPLACED (ui)  telo.yaml  1 rewrite

1 rewrite in 1 file. Imported modules were not touched.
$ telo upgrade panel
$ telo migrate panel
UI_DATA_REPLACED (ui)  panel/telo.yaml  1 rewrite

1 rewrite in 1 file. Imported modules were not touched.
```

After, the application's `me` reads:

```yaml
kind: U.View
metadata: { name: me }
content:
  type: query
  query:
    kind: U.Query
    model:
      kind: Telo.JsonSchema
      schema:
        type: object
        required: [authorized]
        properties: { authorized: { type: boolean }, email: { type: string } }
    url: { path: /api/me }
    reloadOn: [focus, unauthorized]
  children: [{ type: value, value: !cel "data.email" }]
```

and `panel/telo.yaml`:

```yaml
kind: Telo.Library
metadata: { name: Panel }
lang: en
imports: { U: oci://ghcr.io/telorun/ui@0.16.0 }
resources:
  data: { kind: U.View }
exports: { resources: [summary] }
---
kind: U.View
metadata: { name: summary }
content: { type: composite, ref: !ref data }
```

Without the fallback rule, `me` would stay as written and report the member that kept the hand-over from firing:

```text
$ telo check
telo.yaml:12:1  error  The migration UI_DATA_REPLACED of ui could not be applied: the hand-over of `me` cannot fire because of telo.yaml:8:3 (`imports.Panel.resources.data`), a reference no rule of UI_DATA_REPLACED reads, and no later `rewrite: Self.Data` rule takes it instead.
MIGRATION_FAILED
panel/telo.yaml:6:9  error  The migration UI_DATA_REPLACED of ui could not be applied: `U.Data` has no replacement, since no rule of ui other than a hand-over rule writes its kind.
MIGRATION_FAILED
$ telo migrate -o json telo.yaml
{"ok":false,"rewrites":0,"unwritable":0,"files":[],"failed":[{"migration":"UI_DATA_REPLACED","module":"ui","file":"telo.yaml","path":"/","message":"the hand-over of `me` cannot fire because of telo.yaml:8:3 (`imports.Panel.resources.data`), a reference no rule of UI_DATA_REPLACED reads, and no later `rewrite: Self.Data` rule takes it instead."}]}
$ echo $?
1
```

### Refused at the library

A `match` the current schema still accepts would rewrite current manifests on every load, a `before` reading of a type the migration does not rewrite has nothing to read, and a kind outside the library's vocabulary is not the library's to write:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.14.0
  license: MIT
lang: en
imports: { Font: ../font, DataModel: ../data-model, Conversation: ../conversation }
migrations:
  UI_LINK_PRESS_LOOSE:
    reason: A link's destination is a navigation effect.
    rules:
      - rewrite: Self.Node
        match: { type: object, properties: { type: { const: link } } }
        remove: [/href]
  UI_DATA_PLACEMENT_MOVED:
    reason: What is drawn over a read belongs to the node that places it.
    rules:
      - rewrite: Self.Node
        match: { type: object, required: [type, ref], properties: { type: { const: composite } } }
        resolve: { data: { at: /ref, before: Self.Data } }
        move: { /ref: /query }
        copy: { data#/content: /children/0 }
        set: { type: query }
  UI_COLLECTION_KEY_RENAMED:
    reason: A collection names its key as `key`.
    rules:
      - rewrite: DataModel.Collection
        match: { type: object, required: [keyProperty] }
        move: { /keyProperty: /key }
  UI_SOURCE_COLLECTION_INLINED:
    reason: A source names its collection.
    rules:
      - rewrite: Self.CollectionSource
        match: { type: object, required: [model] }
        set: { kind: DataModel.Collection }
```

```text
$ telo check modules/ui
modules/ui/telo.yaml:13:9  error  `match` also accepts the current `link` branch of Self.Node: a `link` node with `to` matches it. Require a key that branch refuses, such as `href`.
MIGRATION_MATCH_OVERLAPS_SCHEMA
modules/ui/telo.yaml:20:46  error  `before: Self.Data` names a type this migration does not rewrite; add a `rewrite: Self.Data` rule to UI_DATA_PLACEMENT_MOVED, or read the declaration as migrated by leaving out `before`.
MIGRATION_BINDING_INVALID
modules/ui/telo.yaml:27:18  error  `rewrite` names a type of the library's own, `Self.<Name>`; `DataModel.Collection` belongs to data-model, which migrates it.
SCHEMA_VIOLATION
modules/ui/telo.yaml:35:20  error  `DataModel.Collection` is neither a kind of ui nor one it re-exports; a migration writes only its own library's kinds.
MIGRATION_KIND_FOREIGN
```

A `match` outside the closed vocabulary, and a computed value in `set:`, are refused by the `Telo.Library` schema itself:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.14.0
  license: MIT
lang: en
migrations:
  UI_LINK_HREF_MOVED:
    reason: A link's destination is a navigation effect, so every press target is written one way.
    rules:
      - rewrite: Self.Node
        match: { anyOf: [{ required: [href] }, { required: [url] }] }
        move: { /href: /to/href }
        set: { to: { kind: Self.Navigate, title: !cel "self.text" } }
```

```text
$ telo check modules/ui
modules/ui/telo.yaml:12:18  error  `anyOf` is not a key of a migration's `match`, which takes `type`, `required`, `const`, `enum`, `properties`, `items` and `<key>: false`. Write one rule per legacy spelling.
SCHEMA_VIOLATION
modules/ui/telo.yaml:14:50  error  `set:` holds literals only, and no expression runs in a migration. Carry the value with `copy: { /text: /to/title }`.
SCHEMA_VIOLATION
```

An Application declaring migrations is refused by its schema:

```yaml
kind: Telo.Application
metadata: { name: Library }
lang: en
targets: []
migrations:
  LIBRARY_HREF_MOVED:
    reason: Links name their destination.
    rules:
      - rewrite: Self.Node
        match: { type: object, required: [href] }
        remove: [/href]
```

```text
$ telo check
telo.yaml:5:1  error  `migrations` is not a key of Telo.Application; a library declares migrations for its importers.
SCHEMA_VIOLATION
```

### On the Rust build

The Rust build of `telo` holds the first consumer above back where it first reaches `ui`, because its legacy `link` node satisfies a rule's `match`; the refusal is a host refusal on stderr and the envelope carries no diagnostic:

```text
$ telo -o json check telo.yaml
[ERR_UNSUPPORTED_MANIFEST_FEATURE] 'telo.yaml', imports.U: ui (oci://ghcr.io/telorun/ui@0.14.0) declares the manifest migration UI_LINK_HREF_MOVED, which may apply at telo.yaml:28:9, and this build does not apply library migrations
{"ok":false,"errorCount":0,"warnCount":0,"diagnostics":[]}
$ echo $?
1
```

The Rust kernel refuses it at load, before any resource is created:

```text
$ telo run ./telo.yaml
[ERR_UNSUPPORTED_MANIFEST_FEATURE] 'telo.yaml', imports.U: ui (oci://ghcr.io/telorun/ui@0.14.0) declares the manifest migration UI_LINK_HREF_MOVED, which may apply at telo.yaml:28:9, and this build does not apply library migrations
```

After `telo migrate` on the Node build, the same consumer holds no node a rule could match, and the Rust build checks it:

```text
$ telo -o json check telo.yaml
{"ok":true,"errorCount":0,"warnCount":0,"diagnostics":[]}
```

### Machine output

A rewrite that cannot be written in place is reported the same way for a core migration. Before:

```text
$ telo migrate telo.yaml
!  untagged-interpolation  telo.yaml  /targets/0/inputs/url  could not be rewritten in place (the YAML there cannot carry the edit) — fix it by hand
```

After:

```text
$ telo migrate telo.yaml
untagged-interpolation  telo.yaml
  not written: telo.yaml:12:20 (/targets/0/inputs/url) sits in a block scalar, which cannot carry the edit. Fix it by hand.
$ echo $?
1
```


`telo migrate -o json` on the `Account` consumer with the anchor in its `/settings` page's node, as above — the hand-over fires in memory, so nothing of it is written:

```text
$ telo migrate -o json telo.yaml
{"ok":false,"rewrites":0,"unwritable":1,"files":[{"file":"telo.yaml","rewrites":[],"unwritable":[{"migration":"UI_DATA_REPLACED","path":"/pages/1/children/0","reason":"the hand-over of `me` (telo.yaml:11:1) has an unwritable member — telo.yaml:35:16 holds the anchor `settingsNode`. Remove the anchor and run again."}]}],"failed":[]}
$ echo $?
1
```

## Verify

- Every existing core vector and both analyzers' migration tests pass unchanged, except the retired `schema-prepare-bucket` vector; no core JSON entry names a module's kind.
- No analyzer, kernel or CLI source names a library's migration code or a module's kind: the stage knows only the `migrations:` grammar, and every library-shaped case lives in fixture data under `analyzer/library-migration-conformance/`.
- The `U`-aliased consumer above loads with `to: { kind: U.Navigate, … }`, warns `UI_LINK_HREF_MOVED` at its own line, and a second `telo migrate` reports no rewrite.
- A consumer importing `sqlite` as `Db` with `beforeMigrations:` loads migrated and warns `SQL_BEFORE_MIGRATIONS_RENAMED`; the Rust build prints the host refusal for `imports.Db` naming the `beforeMigrations` node on stderr with `ok: false` and no diagnostic in the envelope, without reading any of `sqlite`'s partials, and the parity sweep's `check` dimension passes with its `unsupported` entry and fails without it; the same consumer without `beforeMigrations` checks and runs on the Rust build.
- No vector in `analyzer/library-migration-conformance/` where Node migrates a node is accepted by the Rust build.
- The chain consumer ends in `address` in one run and reports both migrations at one line; two independent migrations on one node both apply; a two-migration cycle is `MIGRATION_FAILED`.
- The `Account` consumer migrates to one `U.Query` and two `query` nodes carrying the tree; an inline `Ui.Data` at a composite, one inside an `!if` branch, one inside a template-body entry and one inside a `with:` member each migrate the same way; a composite placing a `Ui.View` is untouched and reports nothing.
- With an anchor in one placing node, `telo migrate` writes nothing for `me` or either composite. With `me` supplied to an import's `resources:`, listed in `exports.resources`, or named by a `!ref` at a foreign kind's slot, `me` becomes a `U.View` holding the `query` node and every composite placing it is left as written, in `telo check` and the kernel alike; a `resources.me` CEL read does not keep the hand-over from firing.
- In the `Panel` case, the library's `data: { kind: U.Data }` is retyped to `kind: U.View`; a `Ui.Data` supplied to a path library and one supplied to a published library both load migrated; `telo migrate` on the application and on the library, in either order, gives the same files; without the fallback rule `me` reports `MIGRATION_FAILED` naming `imports.Panel.resources.data`.
- A `resolve` without `before` of a declaration that is itself legacy sees its current spelling; two declarations resolving each other are `MIGRATION_FAILED` at both.
- A node with one moved key and five unchanged commented keys keeps the five lines byte for byte; a node holding an alias is reported unwritable and left unchanged.
- A `!cel` in `set:`, `match: { anyOf: [{ required: [href] }] }` and an `x-telo-ref` inside `match` are each `SCHEMA_VIOLATION` at the library; a rule whose result still satisfies its `match`, and a rule moving two present keys to one destination, each pass the library check and are `MIGRATION_FAILED` at the consumer, naming the leftover or the position.
- The disjointness vectors in `analyzer/library-migration-conformance/` — an open branch, a `oneOf` disjoint per branch, an `allOf`, a `base:` child, a merge-form child, an unjudged `pattern` — each refuse or pass as stated, the message naming the branch and the cause.
- An inline `U.Data` under a legacy key of an own node is found and migrated; a foreign `kind:` map at the same place and a `kind:` map inside an open-typed position are untouched; deleting any one rule changes only the nodes that rule rewrites.
- In a node with five keys no rule mentions, all five survive unchanged; `{ path: !ref authors }`, a moved `!if` and `href: !cel "row.id"` all land at `/to/href` byte-equal; a schema holding both `beforeMigrations` and `prepare` reports `MIGRATION_FAILED` naming `/prepare` and is left as written.
- The `Account` consumer without `loading` gets no `loading` key, and with one gets `loading: [<it>]`; `Pg.Schema` and `Db.Schema` are written with `prepare:`.
- `telo migrate telo.yaml` on the `Panel` consumer without the fallback rule writes every other converged node, leaves `me` as written, lists it under `failed` and exits 1; a second run gives the same output; after the hand edit it exits 0 with nothing to migrate. A `telo upgrade` that brings in a failing migration still moves the pin, and `telo check` reports the failure.
- `telo migrate blueprints/<name>` rewrites a path-imported library's own legacy nodes, after which the consumer's `telo check` reports no migration at that library's file; `telo migrate` on the consumer leaves the library's files untouched.
- `rewrite: DataModel.Collection` is `SCHEMA_VIOLATION`; `set: { kind: DataModel.Collection }` in `ui`, which does not re-export it, and `set: { kind: Self.Navgate }`, which no rule rewrites, are each `MIGRATION_KIND_FOREIGN`; a later `ui` that removes `Navigate` (with a migration taking it onward) or renames a key `UI_LINK_HREF_MOVED`'s `set:` writes still passes its own check; a misspelled `set:` key passes the library check and its fixture fails with `MIGRATION_FAILED` naming the position.
- A kind-only entry of a removed kind whose replacement was itself removed is retyped straight to the declared kind at the end; a second migration whose non-hand-over `Self.Data` rule writes `Self.Query` leaves Panel's entry as written with `MIGRATION_FAILED` naming both rules; renaming or reordering migration codes changes no retype.
- Exactly one definition registration is built per load; an inline `U.Data` in an `!if` branch and a shape value inside a union branch migrate.
- An Application with `migrations:` is `SCHEMA_VIOLATION` at `telo check` and at load; a migration keyed `linkPress` is `SCHEMA_VIOLATION`.
- A closure declaring no `migrations:` runs no stage work.
- The chained consumer prints `info` for `UI_NAVIGATE_HREF_RENAMED`, and `-o json` reports `"severity":"info"`; in every `telo migrate -o json` envelope `ok` is true exactly when the exit status is 0.
- `tests/check-run-agreement.yaml`'s `MIGRATION_FAILED` rows and the fallback row agree between `telo check` and the kernel.
