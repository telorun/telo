# Crud.Reader

`Crud.Reader` serves the [list contract](list-route.md) — the declared filter, sort, facet and search pairs, `limit` 1–100, the opaque cursor, `{ rows, total, next }` or, for a facet, `{ values, next }`, and `ERR_CRUD_QUERY_INVALID` with its `issues` — as an invocable you call yourself. `Crud.Api`'s list and read-one routes are readers over one declared table; a reader of your own reads a table or any fixed SELECT, so a list with joined or computed columns needs none of that rebuilt.

```yaml
kind: Crud.Reader
connection: !ref db
collection: !ref commands
select: !sql |
  SELECT c.seq AS "seq", c.runner AS "runner", c.state AS "state",
         c.created_at AS "createdAt", r.region AS "region"
  FROM commands c JOIN runners r ON r.name = c.runner
```

## What it is given

| Field | |
| --- | --- |
| `connection` | the `Sql.Connection` to read through |
| `collection` | a `DataModel.Collection` (a `Crud.Collection` is one): its `model` says what a row holds and how a value is typed, its `key` identifies a row, its `query` says what a request may filter, sort and facet by |
| `table` or `select` | where rows come from — exactly one of them |
| `row` | what a returned row holds, when it differs from the model |
| `query` | the accepted filters, sorts and facets, when they differ from the collection's |

The collection's `key` is the order's tie-break and the cursor's seek, so a collection keyed `seq` pages by `seq`.

## Reading a SELECT

`select` is one fixed statement, written without a trailing semicolon, whose columns are aliased to the model's property names. Quote an alias where the database folds case (`AS "createdAt"` on PostgreSQL). The reader wraps it as a subquery and renders every filter, the order, the seek, the limit, the count and the facet grouping around it through the connection's dialect, so any column of the model can be filtered, sorted and counted, including a joined or computed one, and no clause of the statement is built from the request.

A `!sql` value binds each `${{ }}` hole as a parameter, ahead of the request's own values; a plain string is used as written. With `table`, a property is read from the snake_case column of its name, as `Crud.Api` reads it.

## Scope

`scope` is a map of model property to value that the caller fixes: `scope: { runner: !cel "request.params.name" }` reads only that runner's rows. It holds the page, the `total` and every facet count to those rows, each value is bound as a parameter, and no client can send or widen it: a request filtering by a scoped property is refused as `ERR_CRUD_QUERY_INVALID`, the property reported as not accepted, whatever the collection declares.

A scope is typed by the model before the app runs. A key naming no property is `CONTRACT_INPUTS_MISMATCH` where it is written literally and `CEL_TYPE_ERROR` where a value expression has the wrong type; a computed map naming no property is refused at dispatch as `ERR_INPUT_INVALID`. A value is a string, number or boolean — an equality, never a comparison.

## Inputs

`filters` (`[{ property, operator?, value }]`), `sort` (at most one `{ property, direction? }`), `facet`, `search`, `limit`, `cursor` and `scope`, as [the list route](list-route.md) reads them; the route's `inputs:` is what maps the query string onto them.
