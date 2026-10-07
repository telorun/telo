# The list route

`GET <prefix>` returns one page of the table. It implements the collection
contract a `Ui.Table` reads, so a table, a form and a filter bar work over it
with no adapter.

## Query

| Parameter | |
| --- | --- |
| `limit` | rows to return, an integer from 1 to 100; 25 when absent |
| `cursor` | the `next` of a previous response, passed back unchanged |
| `sort` | ONE property name; `-` before it for descending; `id` when absent |
| `<property>=<value>` | equals — the bare property name is its only spelling |
| `<property>.contains=<text>` | contains the text, ignoring case |
| `<property>.gt=` `.gte=` `.lt=` `.lte=` | greater than, at least, less than, at most |
| `<property>.in=<value>` | one of; the key repeated once per value |

- A property is one the model declares, or `id`. Both can be filtered and
  sorted by.
- A value is read as the property's model type: `isDone=true` is the boolean,
  `priority.gte=3` the integer. A property that declares only `enum` takes the
  type of its listed values.
- `contains` applies to a string property. `%` and `_` in the text match
  themselves.
- `gt` / `gte` / `lt` / `lte` apply to a string or a number.
- Filters on several parameters all have to hold.
- Rows with no value for the sorted property come last, in either direction.
  Rows that tie are ordered by `id`, ascending.
- Query keys beginning `_telo` are ignored.
- `limit`, `cursor` and `sort` are typed in the route's request schema —
  `limit` an integer from 1 to 100 defaulting to 25, the other two strings — so
  the generated OpenAPI document carries them.

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
| `rows` | the page, each row `id` plus the model's properties in their [declared types](resource.md#typed-values). Each row is a record valid against the model: a property with no stored value is left out, `null` where the model admits it — see [What a read returns](resource.md#what-a-read-returns) |
| `total` | how many rows the filters match, whatever the page |
| `next` | the cursor of the following page; `null` on the last one |

The envelope is the route's declared response, so it is in the generated
OpenAPI document.

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
  "details": [ { "location": "query", "path": "nope", "message": "names no property of this collection" } ]
}
```

| `path` | When |
| --- | --- |
| the parameter, e.g. `nope` or `nope.gt` | it names a property the model does not declare |
| the parameter, e.g. `text.like` or `text.eq` | what follows the last `.` is not an operator; equality has none |
| the parameter, e.g. `isDone.contains` | the operator does not apply to the property's type |
| the parameter, e.g. `priority` | the value is not of the property's type, or a parameter other than `.in` was sent more than once |
| `limit` | not an integer (`must be integer`), below 1 (`must be >= 1`) or above 100 (`must be <= 100`) |
| `sort` | sent more than once (`must be string`), more than one property (`sort=text,dueOn`), or a property the model does not declare |
| `cursor` | sent more than once (`must be string`), malformed, or issued for a different `sort` |

The three typed parameters are judged first, by the route's request schema,
and the first fault among them is the whole answer. A request wrong in both a
typed parameter and a filter (`?limit=0&nope=1`) is therefore told about the
typed parameter alone; once that is right, every remaining fault — filters,
the sort's property, the cursor's content — is reported together.
