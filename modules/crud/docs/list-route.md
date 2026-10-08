# The list route

`GET <prefix>` returns one page of the table. It implements the collection
contract a `Ui.Table` reads, so a table, a form and a filter bar work over it
with no adapter. It accepts the filters and sorts the model's
[`query`](model.md#the-declared-query) declares, and no others.

## Query

| Parameter | |
| --- | --- |
| `limit` | rows to return, an integer from 1 to 100; 25 when absent |
| `cursor` | the `next` of a previous response, passed back unchanged |
| `sort` | ONE property listed under `query.sort`; `-` before it for descending; ordered by `id` when absent |
| `<property>=<value>` | equals — the bare property name is its only spelling |
| `<property>.contains=<text>` | contains the text, ignoring case |
| `<property>.gt=` `.gte=` `.lt=` `.lte=` | greater than, at least, less than, at most |
| `<property>.in=<value>` | one of; the key repeated once per value |

- A filter parameter is accepted only where `query.filters` lists its
  property with its operator: `{ property: text, operator: contains }` accepts
  `text.contains=` and not `text=`. A `sort` is accepted only for a property
  under `query.sort`. `id` is like any other property: `?id=` and `sort=id`
  need an entry. A row can be found by a property the list does not show.
- A value is read as the property's declared type: `isDone=true` is the
  boolean, `priority.gte=3` the integer. A property that declares only `enum`
  takes the type of its listed values.
- `contains` applies to a string property. `%` and `_` in the text match
  themselves.
- `gt` / `gte` / `lt` / `lte` apply to a string or a number.
- Filters on several parameters all have to hold.
- Rows with no value for the sorted property come last, in either direction.
  Rows that tie are ordered by `id`, ascending.
- Query keys beginning `_telo` are ignored.
- `limit`, `cursor` and `sort` are typed in the route's request schema —
  `limit` an integer from 1 to 100 defaulting to 25, the other two strings — so
  the generated OpenAPI document carries them. It does not list the declared
  filter parameters, nor the properties `sort` accepts: the query schema is
  open, and the route itself refuses what the model does not declare.

```
GET /api/todos?status.in=open&status.in=blocked&text.contains=plan&sort=-dueOn&limit=10
```

## Response

```json
{
  "rows": [ { "id": 2, "text": "Review the plan", "isDone": false, "dueOn": "2026-10-07" } ],
  "total": 42,
  "next": "WyItZHVlT24iLCIyMDI2LTEwLTA3IiwyXQ"
}
```

| Field | |
| --- | --- |
| `rows` | the page, each row holding the properties of the model's `list` shape in their [declared types](resource.md#typed-values). Each row is a record valid against that shape: a property with no stored value is left out, `null` where the shape admits it — see [What a read returns](resource.md#what-a-read-returns) |
| `total` | how many rows the filters match, whatever the page |
| `next` | the cursor of the following page; `null` on the last one |

The envelope is the route's declared response, its rows typed by the `list`
shape, so both are in the generated OpenAPI document.

## Paging

The cursor is opaque and stateless: it records where the page ended, not a row
offset. Following `next` to the end returns every row that existed when the
walk began exactly once, even while rows are inserted during it.
Sending an earlier cursor again returns that page again, which is how a client
goes back.

A cursor belongs to the `sort` it was issued under. Changing `sort` starts
again from the first page, with no cursor.

## Refusals — 400

A query the route does not accept is answered with the request-validation
envelope, each detail naming the parameter that carried the fault:

```json
{
  "error": "ValidationError",
  "message": "Request validation failed",
  "status": 400,
  "details": [ { "location": "query", "path": "nope", "message": "is not a filter this collection accepts" } ]
}
```

| `path` | When |
| --- | --- |
| the parameter, e.g. `nope`, `text.like`, `text.eq` or `isDone.contains` | its property and operator are not a pair `query.filters` declares — `is not a filter this collection accepts`. Equality has no spelled operator, so `text.eq` is never one |
| the parameter, e.g. `priority` | the value is not of the property's type, or a parameter other than `.in` was sent more than once |
| `limit` | not an integer (`must be integer`), below 1 (`must be >= 1`) or above 100 (`must be <= 100`) |
| `sort` | sent more than once (`must be string`), more than one property (`sort=text,dueOn`), or a property `query.sort` does not list (`is not a property this collection sorts by`) |
| `cursor` | sent more than once (`must be string`), malformed, or issued for a different `sort` |

The three typed parameters are judged first, by the route's request schema,
and the first fault among them is the whole answer. A request wrong in both a
typed parameter and a filter (`?limit=0&nope=1`) is therefore told about the
typed parameter alone; once that is right, every remaining fault — filters,
the sort's property, the cursor's content — is reported together.
