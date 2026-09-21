# `!for-each` — fan-out in template bodies

## The gap

A template body declares a fixed list of entries with literal names, and a
reference the instance holds crosses into the body only through a bare
`!cel "self.<path>"`, which forwards the value untouched. So a blueprint can hand
a consumer's list to ONE entry that already takes a list (`Http.Api` `routes:`,
`Ai.Tools` `tools:`, `Mcp.Tools` entries, `Http.Server` `mounts:`), but it
cannot turn a list into N things. Three consumers are blocked on it today:

- **ScheduledJobs** — a map of jobs becomes N `Scheduler.Cron`, each a
  `Telo.Service` with one `cron:` and one `invoke:`.
- **Webhooks** — N routes in ONE `Http.Api` (one router, one OpenAPI document),
  each handler wrapped in its own inline `Idempotency.Once` behind a
  shared-secret check.
- **CRUD from tables** — the consumer declares its backend's schema resource
  (`Sqlite.Schema`, `Postgres.Schema`) with its tables, and hands it to the
  blueprint; per table, the blueprint mounts one inline `Crud.Resource` whose
  data shape is DERIVED from that table. The table is the source of truth and
  JSON Schema the derived form, never the reverse: a table-to-JSON projection
  loses only what a JSON consumer never needs (lengths, indexes, foreign keys,
  renames), while the reverse direction would have to invent all of it. Each
  backend already declares that projection (`x-telo-schema-projection` over
  `columns:`), so no type mapping is written anywhere new, and the table keeps
  its literal columns — its rules, `renamedFrom:`, tombstones and reclamation
  all apply unchanged.

A per-item wrapper kind (`ForEach.Services` / `ForEach.Mounts`) and a
`{ forEach, as, emit }` object form were both evaluated and rejected; the shape
below is the decided one. Rejection reasons, once: a wrapper kind needs one kind
per capability, cannot add items to a sibling's list (so every single-container
transport splits into N containers) and hides its children from the analyzer;
the object form is recognized by guessing from key names inside other kinds'
lists.

## Decided shape

- **A YAML tag**, `!for-each { in: !cel "self.<path>", emit: <item> }`, valid
  as an ITEM of any list inside a template body. The loader turns it into a
  sentinel the way it does `!ref`; one recognizer serves every reader. It is
  expanded before any entry-kind schema check, so no host schema has to admit
  it.
- **Value position only.** It emits one list item per element, concatenated
  with the literal items around it in declaration order. Directly in
  `resources:` it is refused (`TEMPLATE_REPEAT_UNREACHABLE`): nothing can
  `!ref` an emitted entry, so an emitted entry nobody reaches is dead. Emitted
  items are unnamed inline declarations. When one element needs several
  resources that refer to each other, emit one inline `Self.<Unit>` of a
  templated kind whose own body names its internals literally.
- **Bindings reuse the iteration vocabulary**: `item` is the element, plus
  `key` for a map source or `index` for a list source. There is no `as:`. Like
  `self`, they are constants for the instance's life and are in scope in every
  expression inside the emitted item, including ones evaluated later (a route's
  `inputs:` may read `item.x` beside `request.y`). Unlike `self`, they are
  NOT bound on the instance's child context: every emitted item shares that
  context, and often one resource (N routes in one `Http.Api`), so a
  context-wide binding cannot tell item 3's `inputs:` from item 5's. Expansion
  instead closes every expression left compiled inside an emitted item over
  that item's `item` / `key` / `index`, so the entry's controller evaluates it
  later with the right element whatever scope it supplies itself.
- **Innermost binding wins.** A nested `!for-each` shadows the outer `item`,
  and so does an emitted item's own kind wherever it binds the same name (an
  iteration step's `item` inside an emitted sequence). Reaching the outer
  element is done by composition. A named binding (`x-telo-bindings-from`)
  called `item`, `key` or `index` inside an emitted item is
  `BINDING_NAME_RESERVED`, since it would shadow silently.
- **Forwarding is today's rule**: a bare `!cel "item.<path>"` forwards the value
  untouched, references included, exactly as `self.<path>` does; any other
  expression yields data, and a computed value at a reference slot is
  `TEMPLATE_REF_COMPUTED`. The blueprint's schema still marks every reference
  slot under the element with `x-telo-ref`.
- **The source is literal.** `in:` must be a bare `self.<path>` or
  `item.<path>` (`TEMPLATE_REPEAT_SOURCE_INVALID`, reported at the
  definition). The consumer's collection must be literal in their manifest,
  through any chain of bare `self.` forwards (a blueprint wrapping a
  blueprint); a CEL-computed collection is `TEMPLATE_REPEAT_COMPUTED`, reported
  at the consumer's key. Element VALUES may contain CEL.
- **The path may cross a reference into a declaration.** `self.schema.tables`,
  where `schema` is a `!ref` to the consumer's schema resource, reads that
  declaration's `tables:` as written; the rest of the path must be literal
  there too (`TEMPLATE_REPEAT_COMPUTED`, reported at the declaration). Both
  halves read the DECLARATION, never a published reading: the analyzer
  resolves the reference, the kernel reaches the declaration through its record
  of which declaration an injected instance came from. This is what lets the
  CRUD consumer list its tables once, in the schema that owns them.
- **Edges**: order is the consumer's declaration order; an empty collection
  emits nothing; an item is made conditional by omitting it; the tag anywhere
  outside a template body is `TEMPLATE_REPEAT_OUTSIDE_BODY`.
- **A map source may not have integer-like keys** (`"1"`, `"2024"`):
  `TEMPLATE_REPEAT_NUMERIC_KEY`, reported at the consumer's key. A JavaScript
  object puts such keys first in numeric order whatever order they were
  written in, and the Rust half's order depends on its map type, so
  declaration order — which decides `targets:` start order — would silently
  differ from what the author wrote and between the two kernels.
- **Emitted items are named from the source**: by key for a map source
  (`jobs.nightly`), by index for a list source. A map source's names are
  therefore stable when the consumer reorders; a list source's are not, which
  is the list's own nature.
- **Reload** rebuilds the whole instance, as any template field change does
  today. Per-key reload would need reconciliation inside one resource, which
  exists for nothing yet.
- **`targets:` accepts it.** `targets:` on a templated `Telo.Service` /
  `Telo.Runnable` shipped on this branch as a list of `!ref` entries started in
  order. For ScheduledJobs it must also accept an inline declaration and a
  `!for-each` item — `targets: [!ref server, !for-each { in: !cel
  "self.jobs", emit: { kind: Scheduler.Cron, … } }]`. That is the
  Application-grammar widening the `targets:` design already anticipated.

## `Crud.Resource` over a declared table

- **`table:` also accepts a `!ref` to an `Sql.Table`** — a union of today's
  name string (a value branch) and a reference branch, so every existing
  manifest keeps working. Given a reference, the physical table name is that
  table's `table:`, and the data shape is the table's projected row schema
  with the `id` column removed (CRUD already requires `id` as the primary key,
  so it is excluded by name, as `model:` documents today).
- **`model:` beside a referenced `table:` is refused**
  (`CRUD_MODEL_WITH_TABLE_REF`, a resource rule): two sources of one shape
  would drift, and the table is the one the database is built from.
- **The API stays camelCase.** Projected keys are column names; CRUD applies
  the snake_case ↔ camelCase conversion it already applies to `model:`
  properties, so a resource's HTTP surface does not change when it switches
  from `model:` to a referenced table.
- **The projected row schema reaches the template body as a value**, because
  CRUD writes it into its `Http.Api` request schemas and OpenAPI document.
  Today a projection is resolved only as a contract (`telo check` and
  dispatch), never handed to a body. It is the same projection both halves
  already compute, so `telo check` and the running server agree on the shape.

## Obligations

- **Loader**: the tag becomes a sentinel in both templating halves (Node and
  Rust).
- **Analyzer**: one reader and ONE shared expansion, which the kernel reuses.
  Everything downstream — forwarded-value checks, CEL typing, reference
  resolution — runs over the expanded body, so a diagnostic inside an emitted
  item lands at the consumer's own line (`jobs.nightly.cron`). Today the
  forwarded-value views are built one per STATIC body index; they must be built
  one per EMITTED item.
- **Definition-side check of `emit:`**: the `emit:` template is checked once at
  the defining module, with no consumer, against the entry kind's schema with
  `item` / `key` / `index` typed from the source path — the
  `TEMPLATE_FORWARD_INCOMPATIBLE` rule extended from `self.<path>` to
  `item.<path>`. Without it a typo inside `emit:` is reported only in a
  consumer's manifest, on a line that consumer cannot fix, and never when the
  blueprint's own tests pass an empty collection.
- **Typing**: `item` / `key` / `index` are typed from the outer kind's schema
  at the source path — through a reference, from the referenced kind's schema
  — as a new binding rule in the one CEL scope resolver; the editor's scope
  query must give the same answer.
- **Kernel**: an `ERR_TEMPLATE_REPEAT_*` guard for every diagnostic above, each
  pair added to `tests/check-run-agreement.yaml`. Expansion happens where the
  template controller expands a body today, at the instance's `init()`, and
  binds each emitted item's expressions to its own element as stated under
  Bindings.
- **Crud**: the `table:` union, the refusal and the projected shape above, with
  `CRUD_MODEL_WITH_TABLE_REF` in both halves of `tests/check-run-agreement.yaml`.
- **Editor**: the template-body canvas that shipped on this branch (a templated
  definition opened as its own module canvas, entries as nodes, `targets:` as
  boot badges) gains a REPEAT ROW inside the list it sits in, identified by its
  source path. It is not a new kind of containment. The formatter and the
  studio's YAML round-trip preserve `!for-each` on a mapping — the formatter
  has already once rewritten inline CEL into a broken `!ref`.
- **Floors**: every module whose own `telo.yaml` writes `!for-each`, or an
  inline / `!for-each` item in `targets:`, declares `requires: telo:` at the
  release that ships it, verified by running the previous published CLI
  against it. See the version note below.
- **Docs**: templated-definitions guide, the analyzer guide's template
  section, the root `CLAUDE.md` `Telo.Definition` bullets, the authoring-agent
  primer, `blueprints/README.md`, and the crud module's docs and README for a
  referenced `table:`.

## Known template-body gaps to fix first or alongside

Each was hit while building the approval and agent blueprints on this branch
and worked around, not fixed:

1. **An inline declaration as a route handler inside a template body is never
   created**; the route fails at request time with `ERR_RESOURCE_NOT_INVOKABLE`
   and `telo check` is silent. `!for-each`'s Webhooks and CRUD cases emit
   exactly this shape, so this must be fixed first. The blueprints name their
   handlers as entries instead.
2. **An inline `Run.Sequence` as a route handler inside a template body is typed
   with the route's CEL context**, so `steps.*` is a false `CEL_UNKNOWN_FIELD`.
3. **A `Run.Sequence` missing `steps:` inside a template body passes
   `telo check`** and is refused at boot (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`):
   a body entry is not validated against its own kind's required fields.
4. **The canvas draws no edge** for a forwarded reference
   (`invoke: !cel "self.onApproved"`) or for a body `!ref` to one of the
   module's own resources. Emitted items will hit the same.

Fixed on this branch, relevant to the design: `self` now reads a field's schema
`default:` when the instance omits it, and an expression calling a
non-deterministic function (`uuidv4()`, `nowMillis()`) is no longer evaluated
once for the whole instance.

## Version note

The repo's surface generator says this branch's features ship as `0.96.0`, and
the new blueprints declare `requires: telo: ">=0.96.0"`. npm already carries
`@telorun/cli@0.96.0` without `targets:` — it passes `telo check` on a
`targets:` manifest and fails at boot with `Unrecognized target shape at index
0: {}`. After rebasing onto main, the floor for `targets:` (and for
`!for-each`) is the next unreleased version the generator reports then.

## Verify

- ScheduledJobs with three jobs boots; all three crons hold the app and fire.
- Webhooks produces ONE `Http.Api` and one OpenAPI document with N paths, each
  handler wrapped in its own `Idempotency.Once`; a redelivered event is
  deduplicated.
- CRUD over a schema declaring two tables serves both resources' list / read /
  create / update / delete, with both tables created before the server starts.
- Adding a column to one of those tables creates it on the next boot and adds
  it, camelCased, to that resource's create body and OpenAPI document; a
  `renamedFrom:` on a column keeps its data.
- A `Crud.Resource` with both `model:` and a referenced `table:` gives
  `CRUD_MODEL_WITH_TABLE_REF` from `telo check` and the matching `ERR_` at
  boot; one with a name-string `table:` behaves as today.
- A typo inside one consumer element (`jobs.nightly.cron`) is reported by
  `telo check` at that line.
- `jobs: !cel "variables.jobs"` gives `TEMPLATE_REPEAT_COMPUTED` from
  `telo check` and the matching `ERR_` at boot.
- Two webhook routes whose `inputs:` read `item.secret` each receive their own
  secret on a request.
- A typo inside `emit:` (`crno:`) is reported by `telo check` on the blueprint
  alone, with no consumer.
- A map source keyed `"2024"` gives `TEMPLATE_REPEAT_NUMERIC_KEY` from
  `telo check` and the matching `ERR_` at boot.
- Formatting a manifest carrying `!for-each`, and saving it from the studio,
  leaves the tag and its mapping unchanged.
- Nothing in the expansion path names `Scheduler`, `Http`, `Crud` or any other
  kind.
- The previous published CLI refuses each blueprint with its `requires:`
  stripped, and reports `MODULE_REQUIRES_NEWER_RUNTIME` once it is restored.
