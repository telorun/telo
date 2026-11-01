# The list route

`GET <prefix>` returns one page of the table, or one page of a property's
present values (a [facet](#facets)). It implements the
[collection contract](../../data-model/docs/collection-contract.md), so a screen
reading the same collection works over it with no adapter. It accepts the
filters, sorts and facets the collection's
[`query`](collection.md#the-declared-query) declares, and no others.

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
| `<property>.absent=true` | holds no value (`NULL`); `false` for the rows that hold one |
| `facet` | one property listed under `query.facets`: answers its present values instead of rows — see [Facets](#facets) |

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
- `absent` applies to a property the collection's `model` leaves optional or
  lets be `null`, and takes `true` or `false`.
- Filters on several parameters all have to hold.
- Rows with no value for the sorted property come last, in either direction.
  Rows that tie are ordered by `id`, ascending.
- Query keys beginning `_telo` are ignored. `limit`, `cursor`, `sort` and
  `facet` are the route's own parameters, so no filtered property may carry one
  of those names.
- `limit`, `cursor`, `sort` and `facet` are typed in the route's request schema
  — `limit` an integer from 1 to 100 defaulting to 25, the other three strings —
  so the generated OpenAPI document carries them. It does not list the declared
  filter parameters, nor the properties `sort` and `facet` accept: the query
  schema is open, and the route itself refuses what the collection does not
  declare.

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
| `rows` | the page, each row holding the properties of the collection's `list` shape in their [declared types](api.md#typed-values). Each row is a record valid against that shape: a property with no stored value is left out, `null` where the shape admits it — see [What a read returns](api.md#what-a-read-returns) |
| `total` | how many rows the filters match, whatever the page |
| `next` | the cursor of the following page; `null` on the last one |

The envelope is the route's declared response, its rows typed by the `list`
shape, so both are in the generated OpenAPI document. The one response schema
documents a facet answer too: `next` is required, and `rows` and `total`, or
`values`, are present by which request was made.

## Paging

The cursor is opaque and stateless: it records where the page ended, not a row
offset. Following `next` to the end returns every row that existed when the
walk began exactly once, even while rows are inserted during it.
Sending an earlier cursor again returns that page again, which is how a client
goes back.

A cursor belongs to the `sort` it was issued under. Changing `sort` starts
again from the first page, with no cursor.

## Facets

`facet=<property>` asks for the values a property holds among the rows the
filters match, each with how many rows hold it:

```
GET /api/posts?facet=authorId&title.contains=x
```

```json
{ "values": [ { "value": 1, "count": 2 }, { "value": 3, "count": 1 } ], "next": null }
```

- The property must be listed under `query.facets`; the filters are read as a
  list's, so `facet` combines with every declared filter.
- Values come in ascending order, each in the property's declared type. A row
  with no value counts toward none: `<property>.absent=true` counts those.
- A facet page is `limit` values (25 when absent); `next` is the cursor of the
  following page, `null` on the last. A facet's cursor belongs to that facet.
- A facet takes no `sort`.

## Refusals — 400

A query the route does not accept is answered with a problem
(`application/problem+json`), one issue in `data.issues` per parameter that
carried a fault, its `pointer` naming that parameter under `/query`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The list request is not valid.",
  "code": "ERR_CRUD_QUERY_INVALID",
  "data": {
    "issues": [ { "pointer": "/query/nope", "keyword": "additionalProperties", "params": { "additionalProperty": "nope" } } ]
  }
}
```

Each issue is `{ pointer, keyword, params }` and carries no prose: whoever shows
it words it from its keyword and params. A parameter name holding `/` or `~` is
escaped in the pointer (`~1`, `~0`).

| `pointer` | `keyword` (`params`) | When |
| --- | --- | --- |
| the parameter, e.g. `/query/nope`, `/query/text.like`, `/query/text.eq` or `/query/isDone.contains` | `additionalProperties` (`additionalProperty`: the parameter) | its property and operator are not a pair `query.filters` declares, `absent` included. Equality has no spelled operator, so `text.eq` is never one |
| the parameter, e.g. `/query/priority` | `type` (`type`) | the value is not of the property's type; `boolean` for an `.absent` value other than `true` / `false` |
| the parameter | `maxItems` (`limit: 1`) | a parameter other than `.in` was sent more than once |
| `/query/sort` | `maxItems` (`limit: 1`) | more than one property (`sort=text,dueOn`) |
| `/query/sort` | `enum` (`allowedValues`: each listed property, ascending and `-` descending) | a property `query.sort` does not list; `invalid` when it lists none |
| `/query/cursor` | `invalid` | malformed, or issued for a different `sort` or another facet |
| `/query/facet` | `enum` (`allowedValues`: each property listed under `query.facets`) | a property `query.facets` does not list; `invalid` when it lists none |
| `/query/sort` | `additionalProperties` (`additionalProperty: sort`) | a `sort` beside a `facet` |

The lister reports these as `ERR_CRUD_QUERY_INVALID`, its pointers rooted at
the parameter (`/nope`), and the route's `catches:` entry builds the 400 from
the entry's `problem`, adding `/query` to each pointer.

The four typed parameters are judged first, by the route's request schema —
a fault among them is the server's own validation problem, `code:
ERR_INPUT_INVALID`, its issues at `/query/limit` (`type`, `minimum`, `maximum`),
`/query/sort`, `/query/cursor` and `/query/facet` (`type`, sent more than once) — and that
answer is the whole answer. A request wrong in both a
typed parameter and a filter (`?limit=0&nope=1`) is therefore told about the
typed parameter alone; once that is right, every remaining fault — filters,
the sort's property, the cursor's content — is reported together.
