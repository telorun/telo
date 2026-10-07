# Crud.Resource

A REST API over one database table, as a mount.

| Field | | |
| --- | --- | --- |
| `connection` | required | a `Sql.Connection` (`SQLite.Connection`, `Postgres.Connection`) |
| `singular` | required | noun for one item (`todo`); defaults `idParam` to `<singular>Id` and names the per-item operations |
| `plural` | required | noun for the collection (`todos`); defaults `table`, names the list operation and the OpenAPI tag |
| `model` | required | a `Telo.JsonSchema`, `!ref` or inline: the writable columns, without `id` |
| `table` | `plural` | the table name, written into each statement as given; its primary key is the column `id` |
| `idParam` | `<singular>Id` | name of the `{…}` path parameter; the column stays `id` |

```yaml
kind: Telo.JsonSchema
metadata: { name: Todo }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties:
    text: { type: string, minLength: 1 }
    isDone: { type: boolean }
    dueOn: { type: string, format: date }
---
kind: Crud.Resource
metadata: { name: todos }
connection: !ref db
singular: todo
plural: todos
model: !ref Todo
```

## Routes

Mounted at `<prefix>`:

| Request | Does | operationId |
| --- | --- | --- |
| `GET <prefix>` | one page of rows — see [the list route](list-route.md) | `list<Plural>` |
| `GET <prefix>/{<idParam>}` | one row; 404 when absent | `get<Singular>` |
| `POST <prefix>` | creates a row from the JSON body; 201 | `create<Singular>` |
| `PUT <prefix>/{<idParam>}` | replaces the row with the JSON body, answering it back; 404 when absent | `update<Singular>` |
| `DELETE <prefix>/{<idParam>}` | deletes the row; 204, or 404 when absent | `delete<Singular>` |

All five carry the `<plural>` OpenAPI tag.

## Validation

`POST` and `PUT` take the same body: a whole record, validated against the
model. Required properties must be present, and with
`additionalProperties: false` an unknown one is refused. The body is validated
as the JSON it is, with no conversion: a string where the model declares an
integer, or a `null` at a typed property, is refused.

A refused body is a 400 before any statement runs, in the request-validation
envelope: `location` is `body`, `path` the property (`text`, `address.street`)
and `message` what is wrong with it — `is a required property`,
`must NOT have more than 5 characters`, `must match format "date"`.

## Replacing a row

`PUT` replaces the row; it does not merge. Every column the model declares is
written: the value the body holds, or `NULL` for a property the body leaves
out. So the body holds the properties that have a value: `id` is left out,
leaving a property out is how it is cleared, and a `null` is a 400 naming the
property. A client changing one property of a row it read sends that row's
other valued properties with it.

```
PUT /api/todos/1   { "text": "Buy milk", "isDone": true }
```

stores `text` and `isDone` and clears `dueOn`. A body without the required
`text` is a 400 naming `text`, and the row is left as it was. A column declared
`NOT NULL` needs its property listed in the model's `required`, so that a body
leaving it out is refused rather than reaching the table.

## Columns

A model property is the camelCase API name; its column is the snake_case form
— `dueOn` ↔ `due_on`. The primary key is always the column `id`: an
auto-increment integer, returned on every row, never part of a write body, and
left out of the model.

`Crud.Resource` does not create the table. Declare it with your engine's
`Table` / `Schema` kinds, naming the columns in snake_case.

## Typed values

Every route returns and accepts a value in the JSON type the model declares for
its property, whatever the engine stores. A `boolean` property is `true` /
`false` on the list route, on read-one, and in a create or update body — on
SQLite too, which keeps it as `0` / `1`. An `integer` or `number` property is a
JSON number even where the engine hands back a wide integer as text.

## What a read returns

A read returns a record valid against the model, so a client can send back what
it read: the record `GET` returned, with `id` removed, is a body `PUT` accepts.
That holds on read-one and for every row of the list route.

What a column holding SQL `NULL` is read as depends on the property:

| The model says the property is… | read as |
| --- | --- |
| nullable — its `type` admits `"null"`, or it declares no `type` | `null` |
| not nullable, and not in the model's `required` | left out of the record |
| not nullable, and in `required` | the type's empty value: `""` for `string`, `0` for `integer` / `number`, `false` for `boolean`, `[]` for `array`, `{}` for `object` |

So a property cleared by a `PUT` that left it out is absent from the next read,
and `id` is always present. A property whose `type` lists several types takes
the empty value of the first one listed.

A required column holds `NULL` only where rows predate the model — a model
tightened over existing data. The empty value is the type's alone: a further
constraint on the property (`minLength: 1`, an `enum`, a `minimum` above 0) may
not accept it, and such a record is refused when sent back until the property
is given a real value.

A property that should read and write `null` declares it:
`comment: { type: [string, "null"] }`. A `null` in a write body is then
accepted and stored as `NULL`.

The list route and read-one share one reader, so a row looks the same on both.

## Limits

- The create and delete routes build their statements with `?` placeholders,
  which is SQLite's spelling. The two read routes and the update route are
  rendered through the connection's dialect and run on SQLite and PostgreSQL
  alike.
- `contains` folds case with the engine's `LOWER`, which on SQLite covers ASCII
  letters only.
- For joins, computed columns or custom status logic, write an `Http.Api` with
  `Sql.Query` handlers; `Crud.Resource` covers the single-table case.
