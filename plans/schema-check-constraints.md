# Domains, renames and check constraints in the declared schema

## Problem

A declared table can state a column's storage class, nullability, uniqueness,
default and identity, and a table's indexes and foreign keys. It cannot state a
**domain** (`role` is one of three strings) or a **predicate**
(`balance_cents >= 0`, `status <> 'sent' OR sent_at IS NOT NULL`).

That gap is not theoretical: five manifests in this repo keep a hand-written
`CREATE TABLE` migration for no reason other than a `CHECK` clause — the chat
consoles and the authoring agent for `role IN (…)`, money-transfer for a
non-negative balance. Declaring those tables would silently drop the guard, so
they were left imperative. Every one of them is a table the author would
otherwise declare, which makes this the largest single reason to stay on
migrations.

The two halves are not the same kind of thing, and the plan is built on that
split rather than on which of them JSON Schema happens to spell in one keyword:

- **A domain is a type.** It narrows what a value *is*, it is what Postgres
  models as a first-class enum type, and it is what a consumer of the row needs
  to know — a CRUD model publishes it as an OpenAPI enum, a repository filter can
  be rejected against it before the query, an editor can offer it as a list.
- **A predicate is a constraint.** It relates values, it has no first-class
  construct in any engine beyond `CHECK`, and no consumer of the row can act on
  it. It only ever rejects.

A third gap sits beside them, reached by the same machinery: **a table cannot be
renamed.** A column declares `renamedFrom:`; a table has no equivalent, so
changing `table:` reads as a new table plus a removal — the old one tombstoned
with its rows, the new one empty. Nothing warns, and the data is recoverable only
by hand. The marker this plan adds to an enum declaration is the same marker a
table needs, so all three land together.

## Solution

### Domains — a type refinement, always declared

A domain is a declaration of its own — `Postgres.Enum` and `SQLite.Enum` —
referenced from the columns that use it, so one domain is stated once, shared by
every column that uses it, and reconciled once:

```yaml
kind: Postgres.Enum
metadata: { name: messageRole }
typeName: message_role
values: [system, user, assistant]
---
kind: Postgres.Table
metadata: { name: messages }
table: messages
columns:
  role: { type: !ref messageRole, nullable: false }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
schema: app
version: !cel "module.version"
enums: [!ref messageRole]
tables: [!ref messages]
reclaim: { afterVersions: 3, afterDuration: 30d }
```

**A domain is listed by the schema that owns it, exactly as a table is.** That
list is what the ledger records as owned, so which namespace holds the type, what
a removal tombstones and what a rename rewrites all follow from it with no new
concept. Deriving the set from the columns instead would make deleting the last
column that used a type silently un-declare the type, tombstone it and eventually
drop it — a schema removal nobody wrote — and would leave a type used only by a
`migrations:` entry undeclarable and a type shared by two schema resources
unowned. A table referencing an enum its schema does not list is refused when the
pass plans, naming both and saying to add it to `enums:`.

**A named domain goes in `type:`, because in Postgres it is the column's type.**
The slot unions a name from the backend's closed storage-class vocabulary with a
reference to a declared enum. Inventing a second field beside `type:` would state
in two places what the engine states in one, and would leave the two free to
disagree.

That union does not work today, and making it work is this plan's first piece of
work — see **Unioning a reference with a value** below. There is no precedent to
lean on: `inputType:` / `outputType:` are plain reference slots with no value
branch.

**There is no inline spelling of a domain on the column.** A second way to say
the same thing would need a rule keeping the two from contradicting each other,
and a second path through the projection, in exchange for saving one document on
the single-column case. A domain worth stating is worth naming.

**Identity is the physical name.** The ledger keys an enum on its `typeName`,
never on the resource name — the decision the schema design already made when it
rejected an identity column, so that renaming a declaration does not re-run
everything under a fresh identity. Renaming the resource and its `!ref`s is
therefore free and invisible to the database; renaming the *physical* type is a
schema change, declared with `renamedFrom:` (see Reconciliation).

**The declaration says what the values are; the backend picks the rendering.**
Postgres has a first-class construct and uses it — `CREATE TYPE … AS ENUM`, a
schema object with a physical `typeName`, which is its own base type. SQLite has
no named types at all, so `SQLite.Enum` is a declaration with no database object
behind it: it names a `baseType` from SQLite's storage classes, and the backend
renders the domain as a `CHECK` on every column that references it.

```yaml
kind: SQLite.Enum
metadata: { name: messageRole }
baseType: text
values: [system, user, assistant]
```

Same declaration, same projected row contract, two engine-native renderings —
which is the division of labour the type vocabulary already runs on.

`Domain` was rejected as a name because `CREATE DOMAIN` is a *different* Postgres
construct — a base type plus constraints — and naming the kind after it would
promise the wrong object. That construct is also the more evolvable of the two: a
domain's check can be redefined, where an enum value cannot be removed without a
rewrite (see Reconciliation). The idiom wins here — an enum type is what a
`role` column is expected to be, it orders by declaration rather than
alphabetically, and it is compact — and the removal cost is accepted and made
visible rather than hidden.

### Renaming a table

`renamedFrom:` on a table declaration, naming the physical table it supersedes,
rendering `ALTER TABLE … RENAME TO`.

**Unlike a column, this is a native rename, and the difference is not an
oversight.** A column rename is expand-contract — add, copy, tombstone — because
both names can coexist while the previous version of the app is still running.
A table has no cheap equivalent: copying every row is unbounded work, and writes
during the overlap would land in one table and not the other, so the two diverge.
So the rename is immediate, and the cost is stated where an author will read it:
between the rename and the new deployment, an instance still running the previous
version does not find the table. A Postgres compatibility view under the old name
would buy that overlap back — a view over one table is auto-updatable, so reads
and writes keep working — but it means views become schema objects the ledger
owns and reclaims, which is its own change and is out of scope here.

### Predicates — named table-level checks

A `checks:` map beside `indexes:` and `foreignKeys:`, keyed by constraint name,
each entry carrying an `expression` written in that backend's own SQL:

```yaml
checks:
  balance_non_negative:
    expression: "balance_cents >= 0"
  sent_implies_timestamp:
    expression: "status <> 'sent' OR sent_at IS NOT NULL"
```

Keyed by name because the name is the durable identity reconciliation diffs on —
the same reason indexes and foreign keys are maps rather than lists. Editing an
expression in place is a change to that constraint; renaming the key is a drop
and an add.

Raw backend SQL rather than a structured predicate vocabulary. A neutral
predicate language would be a lowest-common-denominator language, which is the
position this schema design already rejected for column types: a backend owns its
whole type vocabulary, and what crosses the boundary is the projection of the
row. It would also fail on the predicates people actually write, which correlate
columns. The precedent is `defaultExpression`, already raw engine SQL beside a
typed `default`.

**A scalar bound is a predicate, not a domain**, so there is no `min` / `max`
column keyword: `balance_cents >= 0` is a named check. Nothing in a CRUD model or
a repository filter could have acted on a bound anyway, and inventing a keyword
for the two comparisons JSON Schema names would put the seam where that spec
draws it rather than where engines and consumers do.

The consequence is stated rather than papered over: **the analyzer cannot read
the expression**, so a check naming a column the table does not declare is not
catchable the way an index's column list is. No half-rule that parses SQL
approximately — the engine reports it at reconciliation.

### Seeds — rows the table is declared to hold

Reference data is desired state, not history, so it is declared beside the shape
it must satisfy:

```yaml
kind: Postgres.Table
metadata: { name: roles }
table: roles
columns:
  name:  { type: text, primaryKey: true }
  label: { type: text, nullable: false }
  rank:  { type: integer, default: 0 }
seeds:
  key: [name]
  rows:
    - { name: admin,  label: Administrator, rank: 100 }
    - { name: viewer, label: Viewer }
```

```sql
INSERT INTO roles (name, label, rank) VALUES ('admin', 'Administrator', 100)
  ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label, rank = EXCLUDED.rank;
INSERT INTO roles (name, label) VALUES ('viewer', 'Viewer')
  ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label;
```

**On the table, not on the schema, because that is what makes the rows
checkable.** The projection already turns `columns:` into a JSON Schema of the
row, so `rows` is typed by pointing the projection at its own resource — a
misspelled column, a string in an integer column or a null in a `nullable: false`
one is a `telo check` error, on the row's own line. Declared on the schema and
keyed by table name, none of that is reachable without resolving a reference
first, and the rows would sit a document away from the shape they have to match.

**`key:` is durable identity**, the same principle as `table:` and an index name:
it names the columns that decide whether a row is the same row, and it is what
the upsert conflicts on.

**A row asserts the columns it states and no others.** `viewer` above declares no
`rank`, so the insert leaves it to the column default and the update leaves
whatever is there alone. That is the answer to a seeded row edited in place: a
column the seed declares is restored on the next boot, because that is what
declaring it means; one it does not is the operator's.

**A row removed from `rows:` is recorded, not deleted** — the tombstone rule
every other object follows, reclaimed under the same policy, and refused-and-held
when a foreign key still references it, exactly as a type still in use is.
Deleting rows is irreversible; nothing about a row makes it the one object worth
exempting.

**Seeds need no introspection.** The upsert is idempotent, so it simply runs; the
only history required is the previous declaration, which the ledger already
records — that is also what a removal is diffed against.

**Environment-conditional seeds are a `when:` on the block**, a compile-eval CEL
slot like `version:`:

```yaml
seeds:
  key: [name]
  when: !cel "variables.environment != 'production'"
  rows:
    - { name: demo, label: Demo }
```

with the trap stated: a `when:` that turns false is a declaration withdrawn, so
those rows tombstone on the next boot of a database that had them. That is the
correct reading of the rule and the surprising one, so it belongs in the docs
beside the field.

**SQLite needs no separate story** — it has had upsert since 3.24, so both
engines render the same statement shape.

## Unioning a reference with a value

The slot, on the `columns:` entry:

```yaml
type:
  title: Type
  oneOf:
    - title: Storage class
      type: string
      enum: [text, varchar, citext, uuid, jsonb, bigint, timestamptz, …]
      x-telo-schema-map:
        text: { type: string }
        uuid: { type: string }
        bigint: { type: integer }
    - title: Enum type
      type: object
      x-telo-ref:
        kind: Self.Enum
        use: schema
```

`use: schema` for the reason a foreign key's target table takes it: what the
reconciler needs is the physical name, which the declaration carries, so nothing
here requires the enum to be constructed first.

**`type: object` on the reference branch is what makes `oneOf` sound.** A
reference branch with no keywords is an empty schema matching everything, so a
valid scalar would match both branches and fail — the reasoning that governs
`x-telo-type` instance branches, which JSON Schema genuinely cannot describe. A
resolved reference can: `!ref` becomes `{kind, name}` at load and config is
validated *before* injection replaces it with the instance, so a scalar matches
the value branch and an object the reference branch, at both ends.

**A plain string at any slot carrying an `x-telo-ref` is `INVALID_REFERENCE_FORM`
today**, so `type: text` is rejected on the slot above. That is verified, not
assumed. The rule guards a *removed* spelling — bare strings and `{kind, name}`
objects are not reference forms in Telo — which is what makes the fix small and
free of semantics: at a slot unioning a reference branch with others, **validate
the value against those other branches first, and report only when it satisfies
none**.

Sound for any branch shape, since a string is simply not a reference. What varies
is the answer when an author *meant* a reference and wrote a bare name: against a
closed branch they are told the value must be one of the declared names; against
an open `type: string` branch it is accepted and the mistake surfaces later, if
at all. The studio needs a closed value branch too, so both point the same way.

Nothing else downstream changes: injection rewrites sentinels and ignores
scalars, and a value matching no branch reports through the existing union
reduction, so a misspelled storage class comes back as "must be one of …" rather
than as a broken reference.

### One control in the studio

```
type  [ text ▾ ]                    type  [ enum ▾ ]  [ !ref messageRole ▾ ]
        ├ text                              ├ uuid
        ├ uuid                              └ enum          messageRole
        └ enum                                              messageStatus
```

The options are the value branch's `enum`, plus one entry per kind the reference
branch accepts; picking that entry swaps to the reference picker.

**`enum` is a mode, never a value.** The slot holds `type: text` or
`type: !ref messageRole`, and the mode is read back from the value — scalar to
the select, reference to the picker — so nothing new is written and there is no
second field to disagree with the first.

Generic: the renderer reads the branches, so the same control serves any
value-or-reference slot and nothing in the studio learns what an enum is. Two
consequences. A select is renderable only from a **closed** value branch. And the
existing reference/inline toggle fires on "some branch is `type: object`", which
the reference branch now satisfies, so this renderer is dispatched ahead of it on
the discriminator that separates them: a branch carrying `enum` beside a branch
carrying `x-telo-ref`. Completion and hover recognise a reference slot the same
way, so the value position completes as the storage-class list rather than as
resource names.

## Correlating sibling declarations

A rename marker is wrong only in relation to the *other* declarations a schema
lists, and an enum a column names is unlisted only in relation to the same set.
A resource rule sees one resource; a referrer rule sees a pair joined by one
reference; neither can state a relation between siblings. This plan's second
piece of analyzer work is the binding that can — `peers:` on a referrer rule,
naming a collection of the referrer to resolve:

```yaml
# Sql.Table — `self` is this table, `referrer` the schema listing it, `entry`
# the schema's entry that reached me, `peers` its OTHER entries. Here the entry
# IS the reference, so a peer is the declaration itself.
x-telo-referrer-rules:
  - referrer: Self.Schema
    peers: /tables
    condition: !cel "!has(self.renamedFrom) || !peers.exists(p, p.table == self.renamedFrom)"
    code: SQL_RENAME_SOURCE_STILL_DECLARED
    message: >-
      renames from a table this schema also declares. A rename's source is the
      table being retired, so declaring both would rename one live table onto
      another and retire neither.
  - referrer: Self.Schema
    peers: /tables
    condition: !cel >-
      !has(self.renamedFrom)
        || !peers.exists(p, p.?renamedFrom.orValue('') == self.renamedFrom)
    code: SQL_RENAME_SOURCE_CLAIMED_TWICE
    message: renames from a table another declaration in this schema also claims.
```

```yaml
# Postgres.Table — an existential over the set, which is why `peers` binds the
# whole collection rather than one member at a time.
  - referrer: Self.Schema
    peers: /enums
    condition: !cel >-
      self.columns.all(c, self.columns[c].type.?name.orValue('') == ''
        || peers.exists(e, e.metadata.name == self.columns[c].type.name))
    code: SQL_ENUM_NOT_DECLARED
    message: names an enum this schema does not list in 'enums:'.
```

The optional select is what discriminates the two shapes `type:` now holds with
no type test: on a string it yields none, on a reference it yields the name, so a
storage-class column short-circuits and a reference column is checked.

**`peers` binds ENTRIES, not resolved declarations.** A collection's items are
not always references — a server's `mounts:` holds `{mount, prefix}` — so each
entry is bound as written with the references *inside it* resolved: `p` is the
declaration where the entry is a bare `!ref`, and `p.mount` is the declaration
with `p.prefix` beside it where it is not. Nothing is guessed from the item
schema and there is no second pointer to write. **One level only** — references
inside a resolved declaration stay references, since a self-referencing foreign
key and a mutual pair are both cycles.

**`entry` binds my own entry**, resolved the same way. Without it a rule could
read every peer's entry data and not its own, which is the shape a prefix or a
mount-order rule is entirely about. Where the entry is a bare reference, `entry`
is `self`.

**So a peer rule evaluates once per entry**, anchored at that entry's slot path —
a deliberate departure from the family's judge-once rule, because a rule reading
`entry` is about the entry, and a resource mounted twice has two entries to
answer for. `self` is excluded from `peers` **by slot path**, not by identity:
exact, cheap, and correct when the same resource is listed twice. A `peers:`
naming a collection *other* than the one that reached me excludes nothing,
because nothing there is me.

**No `this`.** In a resource rule `this` is an element of the resource's own
data; binding it to a foreign manifest is what the referrer family already
refuses, and `peers` / `entry` say what they are.

**Strict half, at the declaring kind**: `peers:` must name a collection the
referrer kind declares whose items are, or contain, a reference slot — a
collection of plain data resolves nothing, so the rule would silently never see a
declaration. The `referrer:` filter stays Liskov (every real referrer is a
backend's `Schema`, while the rule is declared on the abstract). A `condition:`
must carry the `!cel` tag: the reader stays lenient and takes a bare string, but
untagged the expression is not CEL to the editor's colouring, completion or
hover, and losing those silently is the failure a strict half exists to move
earlier. That line is worth adding to the two existing rule families at the same
time — nine declarations in the standard library already write the tag.

**Coverage variance is reported both ways**, as the existing families report it:
a peer that resolves to nothing, or a read field holding a `!cel`, skips that
evaluation and says so; a rule whose peer set was empty everywhere reports as
unexercised, which is what a typo in `peers:` looks like from outside.
Violations report under the analyzer-owned envelope with the author's `code` in
`data.rule`, and a rule that throws or exhausts its budget is a defect anchored
on the declaring definition.

**Peers-by-kind was rejected, not deferred.** A binding over "every resource of
this kind in the analysis" needs no resolution and is unsound: a physical name is
scoped by its namespace, so two schema resources over one connection — which the
ledger design supports deliberately — would report a conflict between objects
that never meet. The reference collection is what defines the scope.

**The reconciler keeps its guard.** These relations are re-checked when the pass
plans, before any statement runs, for the reason the table rules already state: a
library caller reaching the schema pass directly never passed through
`telo check`.

## Where each part is declared

A domain kind is a reconciled schema object, so its capability is the one
`Table` already uses, not `Telo.Type` — a Type-capability resource is required to
carry a PascalCase name, which would force `MessageRole` on what is an ordinary
instance.

The table keywords and the enum kinds are backend surface: the SQL is
engine-specific, and a named type exists on one engine and not the other. The
**rules** about them belong on the shared abstracts, the way the existing
table-structure rules do, so each is written once rather than per backend — which
is what `Sql.Enum` exists for:

```yaml
kind: Telo.Abstract
metadata:
  name: Enum
  description: >-
    One declared set of permitted values, stated once and referenced by the
    columns that use it. Each engine renders it natively — a first-class type
    where the engine has one, a per-column constraint where it does not — and
    projects the same enum into the row contract either way.
capability: Telo.Provider
schema:
  type: object
  properties:
    typeName: { type: string }
    values: { type: array, minItems: 1, items: { type: string } }
    renamedFrom: { type: string }
  x-telo-resource-rules:
    - condition: !cel "self.values.all(v, size(self.values.filter(x, x == v)) == 1)"
      code: SQL_ENUM_DUPLICATE_VALUE
      message: repeats a value. Each label is distinct.
    - condition: !cel "self.?renamedFrom.orValue('') != self.typeName"
      code: SQL_RENAME_FROM_SELF
      message: declares renamedFrom itself, which describes no rename.
```

```yaml
# Sql.Schema gains the structural half the shared reconciler already consumes —
# which is also what a peer rule's `peers:` pointer has to be able to name.
    tables: { title: Tables, type: array }
    enums:  { title: Enums,  type: array }
```

Three consequences. **`SQLite.Enum` gains `typeName:`** even though nothing in
SQLite corresponds to it — the ledger has to key on something written down, or
renaming the resource abandons the history under the old name, which is the one
outcome the rejected identity column exists to prevent. **A column's reference
slot names `Self.Enum`, never `Sql.Enum`** — a child is accepted at its
ancestor's slot, so the abstract there would let a Postgres table reference a
SQLite enum. And **the driver seam gains the enum hooks beside the check hooks**
— render a create, a value addition, a rename, a drop, and report live types from
introspection — while the diff, the ledger entry, the tombstone and the phase
ordering stay in the shared half exactly as they do for tables.

## Projection

The row projection today maps a column's storage class to a schema node and
applies the nullable and array modifiers. A domain has to reach the projected
node, and the analyzer must not learn what a column is to carry it. The map is
keyed on the field's **value**, and a reference is not a key, so a `type:`
holding one falls through to a **reference path** the backend declares as data:

```yaml
x-telo-schema-projection:
  entries: /columns
  key: type
  nullable: nullable
  array: array
  reference:
    from: values             # the field of the target declaration to read
    keyword: enum            # the schema keyword it becomes
    base: { type: string }   # a Postgres enum IS its own base type
```

```yaml
  reference:
    from: values
    keyword: enum
    baseFrom: baseType       # SQLite: a storage class, read through the map above
```

`role: { type: !ref messageRole }` then projects to
`{ type: string, enum: [system, user, assistant] }` on either backend.

Generic by construction — nothing in the analyzer mentions SQL or enums, and a
third backend contributes its own declaration. A backend that declares none
projects exactly as it does today. One reader change beyond the path itself: the
`x-telo-schema-map` now sits on a branch, so finding it peels `oneOf` the way the
ref-slot reader already does.

**A projection can also be pointed at its own resource**, which is what types a
seed row:

```yaml
seeds:
  properties:
    rows:
      type: array
      items:
        x-telo-schema-projection-from: ""     # this resource, not a ref slot
```

The consumer annotation names a JSON Pointer to a reference slot; the empty
pointer means the declaration it is written on. That is the whole extension —
resolution is skipped, the declaration is already in hand — and it turns
`{ name: admin, lable: Administrator }` into an unknown-property error on the
row's own line, because a projected row is closed. Rows stay partial by design:
the projection emits no `required`, so a row states the columns it asserts and a
resource rule is what insists the key columns are among them.

**This is a deliberate exception to the projection's lossiness.** Length,
precision and collation stop at the boundary on the stated grounds that a
consumer needs the type, its nullability and its repetition and the database
enforces the rest. A domain crosses because it *is* the type, at the granularity
a consumer acts on: the enum in a CRUD model's OpenAPI operation, a completion
list in the editor, a filter a repository can reject before the query. A bound
only ever rejects, which is why it stays behind with the predicates.

## Reconciliation

The backend driver seam gains, for check constraints, the same pair of hooks
foreign keys already have: render an add, render a drop, classify a change
between live and declared, and report what is live from introspection. A domain
whose rendering is a per-column constraint reuses those same hooks.

**Postgres checks** use `ADD CONSTRAINT` / `DROP CONSTRAINT`, so a check is an
ordinary diff. One addition earns its place on the entry: adding a constraint
validates every existing row and holds a lock while it does, so an entry may
declare `validate: deferred`, which renders `NOT VALID` and validates on a later
pass. Live state comes from the catalog, which reports the name and the
normalized expression.

**A referenced type resolves before the diff.** What the reconciler compares for
a column is its type signature, so a `type:` holding a reference is resolved to
the enum's `typeName` on the way in — after which a named domain and a
storage-class column compare the same way, and introspection needs nothing new:
Postgres reports the type's name in its catalog either way.

**Postgres enum types** are a schema object like a table, with a ledger entry, so
a type this app owns is distinguishable from one it merely uses:

- Absent, it is created — inside the pass, ordered ahead of the tables, so a
  column can name a type this same boot creates.
- A value added to the declaration is added to the type. `ALTER TYPE … ADD VALUE`
  cannot use the new value in the transaction that adds it, so value additions
  run as their own phase ahead of the atomic pass rather than inside it — the
  same phase ordering `prepare:` already establishes (see Phases).
- A value **removed** from the declaration is recorded and left in the type.
  Postgres cannot drop an enum value; doing it properly means a new type, a
  column rewrite per user and a drop, which is a table rewrite. Recording without
  executing is the tombstone rule the schema design is already built on, and the
  removal is reported so it is visible rather than silent.
- A `renamedFrom:` on the declaration renders `ALTER TYPE … RENAME TO`, which is
  instant and rewrites nothing. The marker is not optional sugar: the reconciler
  cannot tell a rename from a drop-and-create, and here the wrong guess is far
  more expensive than for a column — it would create the new type, alter every
  column that uses it (a table rewrite each) and tombstone the old one.

  **The marker is advisory, so a missing predecessor is not an error.** Neither
  name present is a fresh database (or a marker left in place long after the
  fact) and the type is simply created; predecessor present and successor absent
  is the rename itself. **Both present refuses**, naming both — it is either a
  half-finished earlier run or a type created independently, and those want
  opposite repairs, which is why an occupied destination is refused rather than
  guessed at. A predecessor the ledger does not record as **owned** refuses too:
  the same ownership that decides what may be reclaimed decides what may be
  renamed, and the repair — drop the marker, or adopt the type first — is cheap.
  Advisory is what lets an author leave the marker in the manifest indefinitely,
  which is what authors do.

  **A rename rewrites the ledger entry from the old key to the new one.** Since
  an enum is keyed on its `typeName`, tombstoning the old key and creating a new
  one would record a drop-and-create even though the database did the cheap
  thing, and the next boot would see a type awaiting reclamation.
- A type the ledger records as owned and the schema's `enums:` no longer names is
  reclaimed under the ordinary policy. The catalog is asked for dependent columns
  first — a table outside this schema may still use the type — and one still in
  use stays held and is reported as held rather than attempted.

**A table rename runs before that table's own diff.** Renames are applied in the
phase ahead of the reconciliation pass — the phase enum value additions already
use — because a pass that diffed first would find no table under the new name,
create an empty one and tombstone the populated original. Afterwards the table
reconciles normally, including any column that carries its own `renamedFrom:`.

**The table marker behaves exactly as the enum's does**, and for the same
reasons: advisory, so neither name present simply creates the table and a marker
left in the manifest indefinitely is harmless; both names present refuses, naming
both; a predecessor the ledger does not record as owned refuses; and the rename
rewrites the ledger entry from the old key to the new one rather than recording a
drop and a create. SQLite renames a table with the same statement Postgres does,
so this is the one part of the plan where the two engines need no separate story.

**A marker whose predecessor is gone for good is reported, not silently kept** —
the inert-rename report a column's dead marker already gets, extended to tables
and enums, so an author learns the line can be deleted instead of carrying it
forever.

**SQLite** has no `ADD CONSTRAINT` and no named types, so a domain reaches the
database only as a `CHECK` written when the table is created. Checks and domains
therefore land exactly where its foreign keys already are: emitted at create
time, and a later change refused with the reason. The refusal needs no expression
parsing — the ledger records the declaration, so the pass compares this boot's
declaration against the recorded one and refuses on difference. A domain
declaration itself is a ledger object like any other, even though nothing in the
database corresponds to it; that is what lets a change to it be detected at all.

**An enum rename on SQLite renders no statement at all** — the `CHECK`s on
referencing tables never named the type, so the ledger key rewrite *is* the
rename:

```sql
-- Postgres
ALTER TYPE msg_role RENAME TO message_role;

-- SQLite
-- (nothing; the ledger entry moves from msg_role to message_role)
```

**Removing a check is immediate — no tombstone, no reclaim.** A dropped column
can lose data, which is why removals are recorded and reclaimed on a policy. A
dropped constraint loses nothing, so recording it would put a grace window on an
object whose removal is free and leave the declaration disagreeing with the
database for a release cycle. An enum *value* is the opposite case above, and for
the opposite reason: the engine cannot execute the removal at all. **A seed row
is on the tombstoned side** — deleting rows is irreversible — and its reclamation
is a `DELETE` by key that is held and reported when a foreign key still
references it, the way a type still in use is.

**Seeds re-apply on every boot**, bounded by what is declared, because desired
state means a row deleted by hand comes back. The upsert is the whole mechanism:
nothing is read back, and the only history is the previous declaration the ledger
already holds, which is also what a removal is diffed against. A row whose values
carry a `!cel` is expanded at load like any other compile-eval field, so the
statement sees a value, never an expression.

## Phases, and what the imperative bucket is for

Adding a rename phase forces the order to be stated, since `beforeMigrations:`
already runs ahead of the pass and its SQL can name an object about to be
renamed:

```
renames  →  prepare:  →  reconciliation pass  →  seeds  →  migrations:
```

Seeds sit after the pass because the table has to exist, and before `migrations:`
because a one-time backfill may reasonably read the reference data — while
nothing declared can depend on a migration that has already run once and will
never run again.

**Renames first, because a migration key runs exactly once, ever** — on whichever
boot first sees it:

```yaml
renamedFrom: chat_messages
prepare:
  "0007-backfill-tenant":
    statement: UPDATE messages SET tenant_id = '…' WHERE tenant_id IS NULL
```

```sql
-- renames first: one name, correct whether the entry lands on the rename boot or later
ALTER TABLE chat_messages RENAME TO messages;
UPDATE messages SET tenant_id = … ;

-- the other order: the entry must say chat_messages today and messages tomorrow,
-- and which applies depends on deployment history rather than on the manifest
UPDATE messages SET tenant_id = … ;    -- ERROR: relation "messages" does not exist
```

The one shape this costs is an entry whose *purpose* is to clear the destination
name: the rename refuses (`both 'chat_messages' and 'messages' exist`) before the
statement that would have made room can run. The repair is to drop the leftover
in an earlier release, or to rename by hand and omit the marker.

**`beforeMigrations:` is renamed `prepare:`.** Every documented use of it is data
preparation for a narrowing this pass is about to attempt — backfill before
`NOT NULL`, make values fit before a length reduction, convert before a
non-widening type change, add or drop a named primary-key or unique constraint —
and each is what a refusal already tells the author to write:

> adding NOT NULL to a column that is currently nullable fails if any row holds
> NULL. Backfill it in a `prepare:` entry first.

The old name says where it runs relative to the *other bucket*; the new one says
what it is for, which is what the refusals need to name. The rename is free in
the one way that could have cost: the ledger stores the migration **key** alone,
so moving an entry between the two maps — or renaming the map — re-runs nothing.

**Provisioning is a declaration, not a bucket.** `citext` is in the Postgres
storage-class vocabulary and needs an extension before any column can use it,
which today has to be smuggled in as `CREATE EXTENSION IF NOT EXISTS` — desired
state wearing a migration's clothes, with no release it belongs to and a
migration key that is a lie:

```yaml
kind: Postgres.Schema
extensions: [citext, pgcrypto]
```

Reconciled like any other object it owns, ahead of the tables that need it, and
tombstoned on removal rather than dropped — an extension may be in use outside
this schema.

## Static checks

All on the declaring kind, so a bad declaration fails where it is written. What
differs is how far each has to see — a relation inside one declaration is a
resource rule, a relation between the declarations a schema lists is a peer rule:

**Resource rules**, on `Sql.Table` and `Sql.Enum`, so one engine cannot ship
without them:

- A domain's `values` are unique and typecheck against its own base type;
  non-empty is `minItems: 1`, which the schema says better than a rule can.
- A `renamedFrom:` may not name the object its own declaration declares.
- A `checks:` key must be a valid constraint identifier.
- A seed's `key:` names columns the table declares, and every row supplies all of
  them. The rest of a row is the projection's to check, not a rule's:

```yaml
- condition: !cel "self.?seeds.orValue({}).?key.orValue([]).all(c, c in self.columns)"
  code: SQL_SEED_KEY_UNKNOWN_COLUMN
  message: names a column this table does not declare, so no row can be identified by it.
```

**Peer rules**, over the schema's `tables:` and `enums:`:

- A `renamedFrom:` may not name an object another declaration in the same schema
  still declares, and may not be claimed by two declarations at once. Together
  those make a chain (`a → b` beside `c → a`) and a swap unrepresentable — the
  rule a column's `renamedFrom:` already carries, since declaring both sides
  would rename one live object onto another and retire neither.
- A column's enum must be one its schema lists in `enums:`.

Each reports under the analyzer-owned rule envelope with its own rule code.
Nothing validates a check expression; see above.

## Versioning

Adding properties to a module's own kind schema, or a kind to a module, needs no
runtime floor — both ship inside that module's artifact, so an older analyzer
reads a manifest that does not use them exactly as it does today. What does bite
is the module pin: a manifest using `checks:` or `Postgres.Enum` requires the
backend version that introduced it, which is the ordinary import-pin story.

**`beforeMigrations:` → `prepare:` is a manifest-surface rename**, so it ships as
a migration entry rewriting the key: the schema is closed, and an app pinned to a
newer backend would otherwise fail validation on a field name it cannot know has
moved. Nothing re-runs — the ledger keys on the migration key alone.

**Peer rules are the exception, and they do need a floor.** The rule reader is
lenient, so an older analyzer ignores `peers:`, evaluates the condition with the
binding unbound and reports a rule defect against a dependency — noise blaming an
author who cannot act on it. `sql`, `postgres` and `sqlite` therefore declare
`requires: telo: ">=<the release carrying peer rules>"`, verified by execution:
strip the block, run the previous published CLI against the manifest, confirm it
rejects; restore it and confirm the same runtime reports
`MODULE_REQUIRES_NEWER_RUNTIME` instead.

## Staging

Steps 1–7 have landed. What remains is step 8, and it is blocked on a release
rather than on work:

1. ~~**Value-or-reference union slots**~~ — landed.
2. ~~**Peer rules**~~ — landed, with the runtime floor on `sql`, `postgres` and
   `sqlite` verified by execution against `@telorun/cli@0.82.0`.
3. ~~**Domains**~~ — landed.
4. ~~**`renamedFrom:` on a table and on a domain**~~ — landed.
5. ~~**Named checks**~~ — landed.
6. ~~**`prepare:` and `extensions:`**~~ — landed, with the migration entry.
7. ~~**Seeds**~~ — landed.
8. **Convert the five manifests back to declared tables.** BLOCKED on the
   release: `examples/*` and `apps/authoring-agent` import PINNED PUBLISHED module
   versions (`oci://ghcr.io/telorun/sqlite@0.3.0#sha256-…`), so `SQLite.Enum` and
   `checks:` do not exist for them until `sqlite@0.4.0` / `postgres@0.4.0` ship
   and each manifest's pin moves. Verified by attempting one: converting
   `examples/chat-console` produced `KIND_NOT_EXPORTED` for `SQLite.Enum` and a
   storage-class violation on every column, against the pinned 0.3.0.

   The five: `examples/chat-console`, `examples/agent-console`,
   `apps/authoring-agent/chat` (all three `role IN (…)`),
   `examples/money-transfer` (a non-negative balance), and whichever fifth
   console the survey counted — re-run the survey when the pins move, since
   `grep -rl "CREATE TABLE" examples/ apps/` now finds four plus `apps/hub`.

   The backends' schema docs are already updated; only the manifests wait.

## Verify

- On a slot unioning a closed value branch with a reference branch: the scalar
  passes, the `!ref` resolves, a value in neither branch still reports
  `INVALID_REFERENCE_FORM`, and a misspelled scalar reports as an unknown value
  rather than as a broken reference.
- The studio renders that slot as the select, offers the enum entry only where
  the reference branch names a kind, and round-trips both spellings unchanged —
  `type: text` and `type: !ref messageRole` are what the save writes back.
- A manifest filtering on a value outside a column's domain, or a CRUD model
  contradicting it, fails `telo check`; the same manifest with the domain removed
  passes, which is what proves the projection carried it rather than something
  else rejecting it.
- The same domain declared against both backends produces the same projected
  node, checked directly — that equivalence is what the split between declaration
  and rendering claims.
- A fresh boot creates the constraint, the type and the table; a second boot
  against the same database plans no change, so introspection round-trips to the
  declaration.
- A table whose column references an enum the schema's `enums:` does not list
  fails `telo check`, and the same manifest reaching the pass through a library
  caller is refused when it plans, before any statement runs. Dropping
  the enum from `enums:` while a listed table still uses it holds the tombstone
  and reports it as held, rather than attempting a drop the engine would refuse.
- Adding a value to an enum takes effect and a column can store it on the next
  boot; removing one is reported, leaves the type unchanged, and does not fail the
  boot.
- Renaming the resource alone plans no change at all. Renaming `typeName` with
  `renamedFrom:` renames the type in place — no table is rewritten and no column
  is altered — and the boot after it plans nothing; renaming without the marker
  is what the marker exists to avoid, and shows up as the expensive rebuild.
- Renaming a table with `renamedFrom:` moves the populated table under the new
  name — the row count survives and no table is created or tombstoned — and the
  same declaration without the marker is what it protects against: an empty new
  table beside a tombstoned old one.
- A chain (`a → b` declared beside `c → a`) and a swap are refused at
  `telo check`, before any database is involved, and refused again when the pass
  plans for a caller that never ran it.
- A peer rule over a collection whose entries hold the reference in a property
  (`mounts: [{mount, prefix}]`) resolves it and reads the entry's own fields
  beside it; the same rule over a collection of bare `!ref`s binds the
  declaration directly. A rule naming a collection of plain data is refused at
  the kind that declared it, and one whose peer set is empty everywhere reports
  as unexercised rather than passing.
- An untagged `condition:` is reported while still running, so the repair is one
  tag and no rule silently stops being CEL to the editor.
- A first boot against an empty database with the marker present creates the type
  and does not fail; a boot where both names exist refuses naming both; a boot
  whose predecessor is live but unowned refuses. After a rename the ledger holds
  one entry under the new name, so the following boot plans neither a
  reclamation nor a creation.
- On Postgres, removing a check drops it on the next boot, not gated on a
  reclamation policy; `validate: deferred` renders `NOT VALID` on a populated
  table and validates on a later pass.
- On SQLite, adding a check to an existing table, or changing a domain a live
  table references, is refused naming the engine limitation; creating the table
  fresh includes both.
- A row violating a domain or a check is rejected by the database, and the failure
  surfaces as an ordinary statement error rather than a boot failure.
- A `prepare:` entry naming a table renamed in the same boot runs against the new
  name and succeeds; a manifest still spelling `beforeMigrations:` is migrated to
  `prepare:` and the entry does not re-run, since the ledger holds its key.
- An `extensions:` entry is created before the first table whose column needs it,
  a second boot plans no change, and removing it tombstones rather than drops.
- Renaming a SQLite enum's `typeName` with the marker emits no statement, moves
  the ledger entry, and leaves every referencing table untouched.
- A seed row naming a column the table does not declare, or holding a value of the
  wrong type, fails `telo check` on that row's line; a row omitting a non-key
  column passes, and one omitting a key column does not.
- A first boot inserts every seed row; a second plans the same upserts and changes
  nothing; a row deleted by hand comes back; a column a row does not declare keeps
  the value an operator set. Removing a row from `rows:` tombstones it, and it is
  reclaimed only under the policy — held and reported while a foreign key still
  references it.
- A `when:` that evaluates false withdraws the declaration, so those rows tombstone
  on a database that had them — checked directly, since it is the surprising half
  of the rule.

## Out of scope

A compatibility view under a renamed table's old name, which would make views
schema objects of their own; reclaiming a removed enum value (no engine support
short of a table rewrite);
renaming an enum *value*, which needs a richer `values:` vocabulary to hang a
marker on and whose engines diverge — Postgres renames a label in place, where
SQLite stores the literal and would need the rows updated first; Postgres
`CREATE DOMAIN` as a second rendering, `EXCLUDE`
constraints and deferrable constraint timing; any cross-table assertion. Each needs its own vocabulary, and
none of them is what a table declaration lost.

Seed rows that are not upsertable by key — an append-only log, a table whose
identity is a generated surrogate nothing else names — since the declaration
would have no way to say whether a row is the same row.
