# Crud.Api

A REST API over one collection's table, as a mount.

| Field | | |
| --- | --- | --- |
| `connection` | required | a `Sql.Connection` (`SQLite.Connection`, `Postgres.Connection`) |
| `collection` | required | a [`Crud.Collection`](collection.md), `!ref` or inline: the table, each operation's shape, and the filters, sorts and facets the list accepts |
| `singular` | required | noun for one item (`todo`); defaults `idParam` to `<singular>Id` and names the per-item operations |
| `plural` | required | noun for the collection (`todos`); names the list operation and the OpenAPI tag |
| `idParam` | `<singular>Id` | name of the `{…}` path parameter; the column stays `id` |

No other key is accepted. The table is the collection's: its physical name is
written into each statement as the table declares it.

```yaml
kind: Crud.Api
metadata: { name: todosApi }
connection: !ref db
singular: todo
plural: todos
collection: !ref todos
```

## Routes

Mounted at `<prefix>`:

| Request | Does | operationId |
| --- | --- | --- |
| `GET <prefix>` | one page of rows in the `list` shape, filtered and sorted only by what the collection's `query` declares; with `facet=<property>`, one page of that property's present values with counts — see [the list route](list-route.md) | `list<Plural>` |
| `GET <prefix>/{<idParam>}` | one record in the `model` shape, whatever `query` declares; 404 when absent | `get<Singular>` |
| `POST <prefix>` | creates a row from a body in the `create` shape; 201 with the stored record | `create<Singular>` |
| `PUT <prefix>/{<idParam>}` | replaces what the `update` shape declares of the row; 200 with the stored record, 404 when absent | `update<Singular>` |
| `DELETE <prefix>/{<idParam>}` | deletes the row; 204, or 404 when absent | `delete<Singular>` |

All five carry the `<plural>` OpenAPI tag. The generated document states each
shape where it applies: the two request bodies, the record every write and
read-one answers with, and the rows of the list. The `{<idParam>}` parameter
takes the type `model` declares for `id`.

## Validation

A `POST` body is validated against the `create` shape and a `PUT` body against
the `update` shape. Required properties must be present, and an unknown one is
refused — both shapes are closed. The body is validated as the JSON it is,
with no conversion: a string where the shape declares an integer, or a `null`
at a typed property, is refused.

A refused body is a 400 before any statement runs: the server's validation
problem (`application/problem+json`, `code: ERR_INPUT_INVALID`), one
`data.issues` entry per finding as `{ pointer, keyword, params }` — `pointer`
the property under `/body` (`/body/text`, `/body/address/street`), and no prose:
`required` with `{ missingProperty: text }`, `maxLength` with `{ limit: 5 }`,
`format` with `{ format: date }`.

## What a write answers with

`POST` and `PUT` answer with the record as it is now stored, in the `model`
shape, taken from the write itself: the `id` the table assigned, a column the
body left to its default, a value the table generated.

```
POST /api/todos   { "text": "Buy milk" }
201               { "id": 1, "text": "Buy milk", "isDone": false }
```

## Replacing a row

`PUT` replaces; it does not merge. Every column the `update` shape declares is
written: the value the body holds, or `NULL` for a property the body leaves
out. A column the shape does not declare keeps its value. So the body holds the
properties that have a value: leaving a property out is how it is cleared, and
a `null` is a 400 naming the property. A client changing one property of a
record it read sends that record's other updatable properties with it.

```
PUT /api/todos/1   { "text": "Buy milk", "isDone": true }
```

stores `text` and `isDone` and clears `dueOn`. A body without the required
`text` is a 400 naming `text`, and the row is left as it was. A column declared
`NOT NULL` with no default needs its property listed in the shape's `required`,
so that a body leaving it out is refused rather than reaching the table.

## Columns

A property is the camelCase API name; its column is the snake_case form —
`dueOn` ↔ `due_on`. The primary key is always the column `id`, assigned by
the table: declared in `model` and the `list` shape, returned on every row, and
never part of a write body. The collection holds both to the table it names
([the table](collection.md#the-table)).

`Crud.Api` does not create the table. List the collection's table in your
engine's `Schema`.

## Typed values

Every route returns and accepts a value in the JSON type its shape declares for
the property, whatever the engine stores. A `boolean` property is `true` /
`false` on the list route, on read-one, and in a create or update body — on
SQLite too, which keeps it as `0` / `1`. An `integer` or `number` property is a
JSON number even where the engine hands back a wide integer as text.

## What a read returns

A read returns a record valid against its shape — `model` for read-one and for
the answer of a write, `list` for each row of the list — and holds that
shape's properties and no other. A client can send back what it read: the
record's properties that `update` declares are a body `PUT` accepts.

What a column holding SQL `NULL` is read as depends on the property:

| The shape says the property is… | read as |
| --- | --- |
| nullable — its `type` admits `"null"`, or it declares neither a `type` nor listed values without `null` | `null` |
| not nullable, and not in the shape's `required` | left out of the record |
| not nullable, and in `required` | the type's empty value: `""` for `string`, `0` for `integer` / `number`, `false` for `boolean`, `[]` for `array`, `{}` for `object` |

So a property cleared by a `PUT` that left it out is absent from the next read,
and `id` is always present. A property whose `type` lists several types takes
the empty value of the first one listed; one declaring only `enum` takes the
type of its listed values.

A required column holds `NULL` only where rows predate the shape — one
tightened over existing data. The empty value is the type's alone: a further
constraint on the property (`minLength: 1`, an `enum`, a `minimum` above 0) may
not accept it. A stored row its shape refuses is a 500 naming the property,
until the row is given a real value or the shape is widened.

A property that should read and write `null` declares it:
`comment: { type: [string, "null"] }`. A `null` in a write body is then
accepted and stored as `NULL`.

## Limits

- The delete route builds its statement with `?` placeholders, which is
  SQLite's spelling. Every other route is rendered through the connection's
  dialect and runs on SQLite and PostgreSQL alike.
- A write reads the stored record back with `RETURNING`, which the engine must
  support (SQLite 3.35 or later, PostgreSQL).
- Paging and the `{<idParam>}` parameter take an `id` that is an integer or a
  string.
- `contains` folds case with the engine's `LOWER`, which on SQLite covers ASCII
  letters only.
- For joins, computed columns or custom status logic, write an `Http.Api` with
  `Sql.Query` handlers; `Crud.Api` covers the single-table case.
