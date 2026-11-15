---
status: draft
priority: high
depends-on: []
packages: [analyzer/nodejs, analyzer/rust, kernel/nodejs, kernel/rust, cel/nodejs, cel/rust, cli/nodejs, cli/rust, sdk, packages/ide-support, modules/postgres, modules/sqlite, docs, apps/authoring-agent, apps/hub]
refinement: not-ready
---

# Library-authored manifest migrations

## Problem

A library that renames, reshapes or removes part of its vocabulary breaks every consumer manifest written against the old spelling, and it has no way to repair them. Today migrations are core-only JSON entries: a data matcher plus six fixed patch operations, run per file at parse time. That engine is right for the core grammar it repairs, but it cannot serve a library:

- **It matches the raw `kind:` text before imports resolve.** A library's kinds are spelled through the consumer's alias, so `schema-prepare-bucket`, which names `Postgres.Schema`, already misses a consumer that imports postgres as `Pg`.
- **It sees only documents.** Most `ui` breaks sit on nodes of a named shape (`Ui.Node`) nested inside other kinds' configuration.
- **It cannot make structural moves.** The operations rename a key, set a scalar or add a key. They cannot wrap or move a subtree, change a declaration's kind, or read a referenced declaration.

This plan gives these breaks a migration:

- press-and-record-detail: a `link`'s `href` becomes `to: { kind: Ui.Navigate, href }`.
- ui-query-reads (`UI_DATA_REPLACED`): a `Ui.Data` becomes a `Ui.Query`, and each node placing it becomes a `query` node carrying its trees, inline and named alike.
- durable-execution-remainder: `DurableLocal.Status` names its `workflow` instead of its `journal`.
- `postgres` / `sqlite`: `beforeMigrations` (today's `schema-prepare-bucket`), under any alias.

Two breaks stay manual, each because the rewrite needs content a migration has no place to put: ui-action-form (an action's form definition fits neither a call nor a mutation) and ui-record-pages' listing openers (pages are new top-level documents).

## Constraints

None.

## Surface

**Added**
- `migrations:` — a `Telo.Library` key: a map from a story's diagnostic code (`<SUBJECT>_<PROBLEM>`) to `{ severity?, reason, rules }`.
- `severity` — `warning` (default), `info` or `hint`: the severity a story reports with.
- `reshape` rule — `{ reshape: <type>, from, to, resolve?, referrers? }`: rewrites a legacy value of one of the library's types.
- `resolve` entry — `{ at, from? }`: binds the declaration at a pointer into the old node, as migrated or, with `from`, as this story's reshape of it found it.
- `referrers` entry — `{ kind, slot, at?, single? }`: binds the declarations whose reference at `slot` names a declaration of the old node; `single: true` binds exactly one.
- `Telo.TaggedValue` — a CEL nominal type with members `tag` and `source`, standing for a tagged scalar inside a mapping.
- `tagged(tag, source)` — a migration-environment function that builds a `Telo.TaggedValue`.
- `Telo.Opaque` — a CEL nominal type with no members, standing for content a mapping may carry but not read: a choice construct, or a foreign declaration or value.
- `omit(map, list)` — a function in Telo's CEL catalog, in both engines: the map without the listed keys.
- `MIGRATION_TYPE_FOREIGN`, `MIGRATION_FROM_NOT_DISJOINT`, `MIGRATION_CONTEXT_INVALID`, `MIGRATION_NONDETERMINISTIC` — library-side `telo check` errors, with no `ERR_` twin.
- `MIGRATION_FAILED` / `ERR_MIGRATION_FAILED` — a library migration could not be applied to a consumer's node.
- `kernel/specs/manifest-migrations.md` — the normative spec of both migration layers.
- `analyzer/migration-conformance/` — before/after vectors of the library phase.

**Changed**
- `telo migrate` — also applies library migrations to the entry module's files.
- `telo upgrade` — applies the migrations of the libraries whose pins it moved to the entry module's files.
- `SQL_BEFORE_MIGRATIONS_RENAMED` — declared by `postgres` and `sqlite` themselves, so it reaches a consumer under any alias.
- `ERR_UNSUPPORTED_MANIFEST_FEATURE` — the Rust `telo check` and the Rust kernel raise it at the `imports:` entry first reaching a library whose module doc declares `migrations:`, so every importer of such a library is refused on Rust, current spelling or not — today every `postgres` and `sqlite` consumer, which a Rust check used to migrate; each becomes a debt entry of the parity sweep's `check` dimension.

**Removed**
- `analyzer/migrations/schema-prepare-bucket.json` — the core entry, now a migration of `postgres` and `sqlite`.

## Solution

### Two layers

- **Core grammar** — tags, the definition and annotation grammar, the built-in documents: everything loading and reading definitions themselves depend on. It stays on the JSON data engine, unchanged, run per file before precompile and desugar, in both analyzers. A core change keeps extending that engine's own vocabulary.
- **Library vocabulary** — a library's own kinds and shapes, as the consumer's aliases spell them. It is the new phase below.

### Declaring a migration

A library declares its stories under `migrations:` on its `Telo.Library` doc, beside the definitions they repair; they ship in the manifest layer.

- A story is data the loader reads: no controller, no lifecycle, nothing created.
- Its key is its diagnostic code, which names it everywhere — in a consumer's diagnostic (with the declaring module), in `telo migrate`'s output and in a refusal. A map key is unique by construction, and a malformed one is `SCHEMA_VIOLATION`.
- `Telo.Application` has no `migrations:` key (`SCHEMA_VIOLATION`), since an Application has no importers.
- It is not exported and not gated. It applies to every file whose import closure reaches the library, published dependencies included.
- `rules:` holds `reshape` items, each a statement with `reshape` as its required key, as steps are. A rule is not a resource.

### Recognizing the legacy spelling

A `reshape` names one type of its own module (`Self.<Name>`): a kind, a named shape, or a kind name the module no longer declares.

- **Candidates for a kind:** every declaration of it the analyzer reads — top-level documents, inline declarations at slots, template-body entries, `with:` members, branches of `!if` / `!switch` / `!for-each`.
- **Candidates for a shape:** every value at a schema position that a current kind schema types by that shape. A removed shape is reached through the type that now holds its position.
- **Recognition:** `from:` is the legacy spelling's schema, in the kind-schema grammar, resolved in the library's scope. A candidate is migrated only if it validates against `from` and every `resolve` entry with `from` finds its referent rewritten by that reshape. Inside a matched node the walk also follows `from`'s positions, so a legacy node under a moved key is found.
- **Identity** is canonical, through the reading file's alias and re-export tables; rules are bound per import edge.
- **Containment:** a rule reaches only its own module's types. A foreign declaration or foreign-shaped value inside a matched node is opaque (a `Telo.Opaque`): the mapping can carry it but not read or change it.
- **Cost:** the phase walks only the positions typed by a targeted type, through an index of targets built once per load; a closure declaring no `migrations:` costs nothing.

### The mapping

`to:` is CEL in a deterministic migration environment (no volatile function, no module call). `self` is the old node, typed by `from`:

- **Plain values:** maps, lists and scalars, with integers as int64.
- **Tagged scalars:** each one (`!ref`, `!cel`, `!interpolate`, `!sql`, `!literal`, `!include-*`, `!module-path`) is a `Telo.TaggedValue` with `tag` (the tag without its `!`) and `source`; `tagged()` builds one.
- **Opaque content:** a choice construct (`!if` / `!switch` / `!for-each`) and a foreign declaration or foreign-shaped value are a `Telo.Opaque`. A mapping can place it in its result unchanged; reading it is a type error at the library's `telo check`.
- **Kind names:** a string at a kind position — a declaration's `kind:` — is read and written library-relative (`'Self.Navigate'`, or `'<Alias>.<Kind>'` for a kind the library re-exports) and written in the consumer's spelling on output, so a consumer aliasing `ui` as `U` receives `U.Navigate`. A kind the consumer cannot spell, or one the library neither declares nor re-exports, is `MIGRATION_FAILED`.
- **Kind change:** a mapping may change the `kind:` of the declaration it matched to one of its own or re-exported kinds. `metadata` is kept by the engine, so a name and every reference to it survive. This is also how a library renames a kind at its declarations; a kind named in another library's definition (`extends:`, an `x-telo-ref` kind) is renamed by deprecating the old kind with `replacedBy` for a release, then removing it.
- **Nested matches:** rules apply bottom-up, so descendants are already migrated when the parent's mapping runs.

**Context** is declared on the rule and never written:
- `resolve: { <binding>: { at, from? } }` binds the declaration at `at` (a pointer into `self`), written inline there or named by the `!ref` there. Without `from` it is read **as migrated**, typed by its kind's current schema. With `from: Self.<Type>` it is read **as this story's reshape of that type found it**, typed by that reshape's `from` — how a node placing a declaration takes over the fields the declaration's own reshape drops. The engine keeps each rewritten node's input for the whole load.
- `referrers: { <binding>: { kind, slot, at?, single? } }` binds the declarations of `kind`, in the same module instance, whose reference at `slot` names the declaration at `at` (the matched declaration when omitted), each read as migrated. It is a list; with `single: true` it is the one declaration, and zero or several is `MIGRATION_FAILED` naming each declaration found.
- Context may read foreign kinds. Referents in the same module instance are migrated first; referents in dependencies are already current, because modules are processed in import post-order.
- A cycle among context reads, or a referent that failed, is `MIGRATION_FAILED` at each node involved.

**A move commits as a whole.** A declaration a story rewrites and another rule of the same story reads with `from` is a moved referent. Its move set is the referent plus every declaration in its module instance whose reference, at any slot of any kind, names it. The set commits — in memory and on write — only when every declaration referencing the referent was recognised by a rule of that story reading it with `from`, every member converged and passed the current schema, and, on write, every member's span is writable. Otherwise every member is left as written and each reports one `MIGRATION_FAILED` naming the set, the member that blocked it and why (a failed reader, a referrer no rule reads, an unwritable span). A referent the module exports (`exports.resources`) has referrers no run can see, so it is never moved.

### Chained stories

A library accumulates stories as its vocabulary changes, and a consumer two releases behind needs both on one node. Each node is brought to a fixpoint:

1. Apply the first rule whose target types the node, whose recognition holds for the node's **current** value, and which has not yet fired on it. Order: declaring module, then the story's code, then the rule's position.
2. Each rule fires at most once per node, so the loop terminates by construction.
3. When none applies and some rule's recognition still holds, the node is `MIGRATION_FAILED` (a cycle among stories).
4. Content a mapping produced is walked in turn; a node already at its fixpoint is not re-entered.

A node reports one diagnostic per story that fired on it, at the consumer's own line, with the story's `severity`.

### Where it runs

One loader phase per module instance, after the definitions of its import closure have been read and before desugar, precompile, flatten and analysis; modules in import post-order. Nothing is created before it: the kernel creates resources only from the migrated tree. As for core migrations, every file is rewritten in memory, only the entry module's files report, provenance remaps diagnostics, and the round-trip view keeps the phase off.

**Rust half:** the Rust `telo check` (as a host refusal) and the Rust kernel (at load) refuse the `imports:` entry first reaching a library whose module doc declares `migrations:`, with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the library and its first story's code; reading that one key is all the refusal needs. Telling a legacy node from a current one needs `from` evaluated as JSON Schema over typed positions, which is the whole phase; the vectors in `analyzer/migration-conformance/` are the contract a later Rust twin is held to, run by Node today.

### Checks

At the library's own `telo check`, each an error; a consumer's `telo check` reports them through the dependency verdict, and the kernel never runs them:

| Code | Refused when |
|---|---|
| `MIGRATION_FROM_NOT_DISJOINT` | Neither the rule's `from` nor the `from` of a reshape its `resolve` entries name is proved disjoint from the current schema: no required key the closed current schema lacks, no `const` / `enum` it refuses, and the kind still declared. |
| `MIGRATION_TYPE_FOREIGN` | A reshape target names a type outside the library's own and re-exported ones. |
| `MIGRATION_CONTEXT_INVALID` | A `resolve` `at` reaches no declaration position of `from`, a `from` names a type the story does not reshape exactly once, or a `referrers` entry names no reference slot of its kind. |
| `MIGRATION_NONDETERMINISTIC` | The mapping calls a volatile function or makes a module call. |

The mapping's CEL is type-checked with the standard codes, `self` typed by `from`. Whether a mapping's result is valid is proved by the library's own fixture: every `reshape` has a manifest under the library's `tests/` written in the legacy spelling, which loads with that story's diagnostic, those of the stories chained after it, and no other finding.

At a consumer, the converged result of every node is validated against the current schema. An evaluation error, a result that fails the current schema, a kind the consumer cannot spell, a leftover match, a `single` binding finding zero or several, a context failure or a blocked move set leaves the node untouched and reports `MIGRATION_FAILED` at the node — at the `imports:` entry for a dependency's file — naming the story and the cause; the validator's findings under that node are held back. The kernel's load raises the same as `ERR_MIGRATION_FAILED`.

### Write-back

`telo migrate` writes only entry-module files:

- **Reshape:** the matched node's span is replaced by its converged value, rendered in the node's own style (block or flow, its indentation). Inside it, an entry kept at the same key with an equal value, and an item kept at the same index with an equal value, keeps its original text byte for byte, comments included. Everything else is rendered fresh; a comment inside a re-rendered part is lost, and the command names each one.
- **Kind change:** the same rule at the declaration's node.
- **Unwritable**, reported per location with its reason: a replaced span holding an anchor or an alias. A move set with an unwritable member is not written at all.

The editor offers the same edit set as a quick fix when none of it is unwritable.

### Stdlib moves and obligations

- `schema-prepare-bucket` moves into `postgres` and `sqlite` as a `reshape: Self.Schema` under `migrations: { SQL_BEFORE_MIGRATIONS_RENAMED: … }`, so `Pg.Schema` is now migrated. The check-conformance vector that pinned the core entry is retired; the aliased case lives in `analyzer/migration-conformance/`.
- The ui-query-reads and durable-execution-remainder plans state their migrations in this grammar.
- The built-in vocabulary's `Telo.Library` entry gains `migrations:`; `Telo.TaggedValue` and `Telo.Opaque` are built-in types of the migration environment.
- Docs: `docs/extend/manifest-migrations.md` (the library surface, both context readings, the move rule, what write-back keeps and loses, the fixture rule, how a kind is renamed), `kernel/specs/manifest-migrations.md`, the analyzer's migrations guide (its "no post-resolution phase" paragraph becomes the two-layer rule), `docs/reference/diagnostics.md` (the new codes; `SQL_BEFORE_MIGRATIONS_RENAMED` under its modules).
- The authoring-agent primer and the hub's `guide_design_library` gain library migrations.
- Benefits ledger, under "For module authors": consumers' manifests repaired when a library renames or reshapes its vocabulary.
- `tests/check-run-agreement.yaml` gains `MIGRATION_FAILED` rows, a blocked move among them.
- `telo release floor` runs on the change; `postgres`, `sqlite` and every library adopting `migrations:` carry the measured floor.

## Decisions

- **Two layers.** Core entries repair the grammar that reading definitions depends on, so they must finish first, and their targets need nothing resolved. Library migrations need the consumer's aliases. One typed engine for both would need a privileged core-only target for the untagged-string wildcard and the whole typed engine on Rust's boot path.
- **A key on the library, keyed by code.** A story is metadata about the library, with no instance and nothing naming it but its diagnostic, so it sits on the module doc beside the definitions it repairs; an Application cannot hold one by schema, and the code is the story's one identity.
- **Recognition is a schema (`from`), the transformation is CEL.** Only a schema can be proved disjoint from the current spelling, and that disjointness is what makes a migration idempotent without version stamps.
- **One node, one write; a move commits as a whole.** A migration never creates a top-level document or changes another document. A move out of a referent is two writes, one per node, committed together or not at all, so the moved content never survives only in version control.
- **Context reads the referent migrated, or as its own story found it.** A mapping is written against one spelling of what it reads, never against every historical one.
- **Fixpoint per node, each rule once.** Without stamps a node's age is known only by which `from` it satisfies now.
- **The kernel trusts a library's own checks.** They are publisher defects a consumer cannot fix; a defect that reaches a consumer surfaces as `MIGRATION_FAILED`.
- **No version stamps; retire a migration by deleting it.** A consumer's import pin is not the version its file was written against, and published dependencies must be rewritten whatever they pinned.

## Examples

### A reshape, and a consumer

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
      - reshape: Self.Node
        from: { type: object, required: [type, href], properties: { type: { const: link } } }
        to: !cel "merge(omit(self, ['href']), {'to': {'kind': 'Self.Navigate', 'href': self.href}})"
```

Before — a consumer written against `ui` 0.13, importing it as `U`:

```yaml
kind: Telo.Application
metadata: { name: Library }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.41.0
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

After moving the pin to the `ui` release that ships the story, it still loads, and `telo check` reports the story at the consumer's own line:

```text
$ telo check
telo.yaml:28:9  warning  A link's destination is a navigation effect, so every press target is written one way.
declared by ui (oci://ghcr.io/telorun/ui@0.14.0)
quick fix available — or run `telo migrate`  UI_LINK_HREF_MOVED
```

```text
$ telo migrate
UI_LINK_HREF_MOVED (ui)  telo.yaml  1 rewrite

1 rewrite in 1 file. Imported modules were not touched.
```

`telo upgrade` makes the same rewrite when it is what moves the pin, applying only the stories of the libraries it moved:

```text
$ telo upgrade
  ↑  U  0.13.0 → 0.14.0
UI_LINK_HREF_MOVED (ui)  telo.yaml  1 rewrite

1 upgraded
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

The fixture proving the story, `modules/ui/tests/__fixtures__/legacy-link/telo.yaml`, is written in the legacy spelling under an alias other than `Ui`:

```yaml
kind: Telo.Application
metadata: { name: LegacyLink }
lang: en
imports:
  U: ../../..
targets: []
---
kind: U.Page
metadata: { name: authors }
path: /authors
title: Authors
children:
  - { type: link, text: Back to authors, href: { path: !ref authors } }
```

and `modules/ui/tests/link-press-migration.yaml` asserts it loads with the story's warning and nothing else:

```yaml
kind: Telo.Application
metadata: { name: LinkPressMigration }
lang: en
imports:
  Assert: ../../assert
targets: [!ref legacyLink]
---
kind: Assert.Manifest
metadata: { name: legacyLink }
source: ./__fixtures__/legacy-link/telo.yaml
expect: { warnings: [{ code: UI_LINK_HREF_MOVED }], runs: true }
```

### Chained stories

A later `ui` release renames `Ui.Navigate`'s `href` to `address` and adds a second story beside the first:

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
      - reshape: Self.Node
        from: { type: object, required: [type, href], properties: { type: { const: link } } }
        to: !cel "merge(omit(self, ['href']), {'to': {'kind': 'Self.Navigate', 'href': self.href}})"
  UI_NAVIGATE_HREF_RENAMED:
    severity: info
    reason: Every destination names where it goes as its address.
    rules:
      - reshape: Self.Navigate
        from: { type: object, required: [href] }
        to: !cel "merge(omit(self, ['href']), {'address': self.href})"
```

The consumer above, still written against 0.13, is brought to the newest spelling in one run: the first story produces an inline `U.Navigate` declaration, the walk enters it, and the second story fires on it. `telo check` reports both at line 28 — `UI_LINK_HREF_MOVED` as a warning, `UI_NAVIGATE_HREF_RENAMED` as info — `telo migrate` writes `{ type: link, text: Authors, to: { kind: U.Navigate, address: { path: !ref authors } } }`, and a second run reports no rewrite.

### A move out of a referent

ui-query-reads replaces `Ui.Data`. The `Ui.Data` becomes a `Ui.Query`, dropping its trees; each `composite` node placing it becomes a `query` node and takes the trees over, reading the `Ui.Data` as the first rule found it:

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
      - reshape: Self.Data
        from: { type: object, required: [source, content] }
        to: !cel "merge(omit(self, ['source', 'content', 'loading', 'failure']), {'kind': 'Self.Query', 'url': self.source})"
      - reshape: Self.Node
        from: { type: object, required: [type, ref], properties: { type: { const: composite } } }
        resolve: { data: { at: /ref, from: Self.Data } }
        to: !cel >-
          merge(merge(omit(self, ['ref']), {'type': 'query', 'query': self.ref, 'children': [data.content]}),
          merge(has(data.loading) ? {'loading': [data.loading]} : {}, has(data.failure) ? {'failure': [data.failure]} : {}))
```

A composite placing a `Ui.View` matches the second rule's `from` but not its `resolve` (no `Ui.Data` was rewritten there), so it is untouched and reports nothing. Before, a consumer placing one named `Ui.Data` twice:

```yaml
kind: Telo.Application
metadata: { name: Account }
lang: en
imports:
  Http: oci://ghcr.io/telorun/http-server@0.41.0
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

Had the `/settings` page written its node as an anchor, `- &settingsNode { type: composite, ref: !ref me }`, the move would load migrated but be written nowhere:

```text
$ telo migrate
UI_DATA_REPLACED (ui)  telo.yaml  not written: the move of `me` (telo.yaml:11:1) has an unwritable member — telo.yaml:35:17 holds the anchor `settingsNode`. Remove the anchor and run again.

0 rewrites. Imported modules were not touched.
```

### Reading a referring declaration

`durable-local` moves `Status` from naming the journal to naming the workflow:

```yaml
kind: Telo.Library
metadata:
  name: DurableLocal
  version: 0.8.0
  license: MIT
lang: en
migrations:
  DURABLE_STATUS_JOURNAL_MOVED:
    reason: A status reads the deployed code's digest, which only the workflow knows.
    rules:
      - reshape: Self.Status
        from: { type: object, required: [journal] }
        referrers: { workflow: { kind: Self.Workflow, slot: /journal, at: /journal, single: true } }
        to: !cel "merge(omit(self, ['journal']), {'workflow': tagged('ref', workflow.metadata.name)})"
```

Before, in a consumer importing `durable-local` as `Local`:

```yaml
kind: Telo.Application
metadata: { name: OrderStatus }
lang: en
imports:
  Local: oci://ghcr.io/telorun/durable-local@0.7.2
  Journal: oci://ghcr.io/telorun/durable-journal-file@0.4.0
variables:
  journalDir: { env: ORDERS_DIR, type: string, x-telo-type: Telo.HostPath, default: .telo/orders }
  run: { arg: { flag: run }, type: string, default: "" }
targets:
  - { name: report, invoke: !ref status, inputs: { run: !cel "variables.run" } }
---
kind: Journal.Journal
metadata: { name: journal }
directory: !cel "variables.journalDir"
---
kind: Local.Workflow
metadata: { name: fulfil }
journal: !ref journal
runId: !cel "'order:' + inputs.order"
steps:
  - { name: shipped, invoke: { kind: Telo.Value, value: { stage: ship } } }
---
kind: Local.Status
metadata: { name: status }
journal: !ref journal
```

After `telo migrate`, the status document reads:

```yaml
kind: Local.Status
metadata: { name: status }
workflow: !ref fulfil
```

A consumer that appends a second workflow on the same journal has no single answer, and the node is left as written:

```yaml
kind: Local.Workflow
metadata: { name: refund }
journal: !ref journal
runId: !cel "'refund:' + inputs.order"
steps:
  - { name: refunded, invoke: { kind: Telo.Value, value: { stage: refund } } }
```

```text
$ telo check
telo.yaml:24:1  error  The migration DURABLE_STATUS_JOURNAL_MOVED of durable-local could not be applied: `workflow` needs exactly one Local.Workflow whose `journal` names `journal`, and found 2 — fulfil (telo.yaml:17:1), refund (telo.yaml:28:1). Name the workflow yourself.
MIGRATION_FAILED
```

```text
$ telo run ./telo.yaml
telo.yaml:24:1  ERR_MIGRATION_FAILED: The migration DURABLE_STATUS_JOURNAL_MOVED of durable-local could not be applied: `workflow` needs exactly one Local.Workflow whose `journal` names `journal`, and found 2 — fulfil (telo.yaml:17:1), refund (telo.yaml:28:1). Name the workflow yourself.
```

### Refused at the library

A `from` the current schema still accepts would rewrite current manifests on every load, and a `from` reading of a type the story does not reshape has nothing to read:

```yaml
kind: Telo.Library
metadata:
  name: Ui
  version: 0.14.0
  license: MIT
lang: en
migrations:
  UI_LINK_PRESS_LOOSE:
    reason: A link's destination is a navigation effect.
    rules:
      - reshape: Self.Node
        from: { type: object, properties: { type: { const: link } } }
        to: !cel "self"
  UI_DATA_PLACEMENT_MOVED:
    reason: What is drawn over a read belongs to the node that places it.
    rules:
      - reshape: Self.Node
        from: { type: object, required: [type, ref], properties: { type: { const: composite } } }
        resolve: { data: { at: /ref, from: Self.Data } }
        to: !cel "merge(omit(self, ['ref']), {'type': 'query', 'query': self.ref, 'children': [data.content]})"
  UI_NAVBAR_TITLE_MOVED:
    reason: A navbar's title is its application's.
    rules:
      - reshape: UiReact.App
        from: { type: object, required: [navbarTitle] }
        to: !cel "omit(self, ['navbarTitle'])"
```

```text
$ telo check modules/ui
modules/ui/telo.yaml:12:9  error  `from` also accepts the current spelling of Self.Node: a `link` node with `to` matches it. Require a key the current schema refuses, such as `href`.
MIGRATION_FROM_NOT_DISJOINT
modules/ui/telo.yaml:19:29  error  `from: Self.Data` names a type this story does not reshape; add a `reshape: Self.Data` rule to UI_DATA_PLACEMENT_MOVED, or read the declaration as migrated by leaving out `from`.
MIGRATION_CONTEXT_INVALID
modules/ui/telo.yaml:24:20  error  `UiReact.App` is not a type of ui; a library migrates only its own and re-exported types.
MIGRATION_TYPE_FOREIGN
```

An Application declaring stories is refused by its schema:

```yaml
kind: Telo.Application
metadata: { name: Library }
lang: en
targets: []
migrations:
  LIBRARY_HREF_MOVED:
    reason: Links name their destination.
    rules:
      - reshape: Self.Node
        from: { type: object, required: [href] }
        to: !cel "omit(self, ['href'])"
```

```text
$ telo check
telo.yaml:5:1  error  `migrations` is not a key of Telo.Application; a library declares migrations for its importers.
SCHEMA_VIOLATION
```

### On the Rust build

The Rust build of `telo` refuses the first consumer above where it first reaches `ui`:

```text
$ telo check
telo.yaml:6:3  error  ui (oci://ghcr.io/telorun/ui@0.14.0) declares the manifest migration UI_LINK_HREF_MOVED, and this build does not apply library migrations.
ERR_UNSUPPORTED_MANIFEST_FEATURE
```

## Verify

- Every existing core vector and both analyzers' migration tests pass unchanged, except the retired `schema-prepare-bucket` vector; no core JSON entry names a module's kind.
- The `U`-aliased consumer above loads with `to: { kind: U.Navigate, … }`, warns `UI_LINK_HREF_MOVED` at its own line, and a second `telo migrate` reports no rewrite.
- A consumer importing `sqlite` as `Db` with `beforeMigrations:` loads migrated and warns `SQL_BEFORE_MIGRATIONS_RENAMED`; the Rust build refuses it at that `imports:` line, without reading any of `sqlite`'s partials, and reports nothing else.
- The chain consumer ends in `address` in one run and reports both stories at one line; two independent stories on one node both apply; a two-story cycle is `MIGRATION_FAILED`.
- The `Account` consumer migrates to one `U.Query` and two `query` nodes carrying the tree; an inline `Ui.Data` at a composite migrates the same way; a composite placing a `Ui.View` is untouched and reports nothing.
- With an anchor in one placing node, `telo migrate` writes nothing for `me` or either composite; with a third, unconvertible placement, the load reports `MIGRATION_FAILED` at `me` and at all three placements and no node points at a `U.Query`; an exported `Ui.Data` is never moved.
- A `resolve` without `from` of a declaration that is itself legacy sees its current spelling; two declarations resolving each other are `MIGRATION_FAILED` at both.
- The two-workflow consumer reports one `MIGRATION_FAILED` at the status naming both workflows; with none, the message says none was found.
- A node with one moved key and five unchanged commented keys keeps the five lines byte for byte; a node holding an alias is reported unwritable and left unchanged.
- A mapping producing a `!cel` at a reference slot passes the library check and is `MIGRATION_FAILED` at the consumer, naming the slot's finding.
- An Application with `migrations:` is `SCHEMA_VIOLATION` at `telo check` and at load; a story keyed `linkPress` is `SCHEMA_VIOLATION`.
- `tests/check-run-agreement.yaml`'s `MIGRATION_FAILED` rows, a blocked move among them, agree between `telo check` and the kernel.
