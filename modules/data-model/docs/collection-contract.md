# The collection contract

What the URL a [`DataModel.Collection`](collection.md) is served at must speak
for a listing, a form and a filter bar to work over it. Any API that answers
this way can serve one.

## Listing — `GET <basePath>`

| Parameter | |
| --- | --- |
| `limit` | rows to return, 1–100; 25 when absent |
| `cursor` | the `next` of a previous response, passed back unchanged |
| `sort` | ONE property name; `-` before it for descending |
| `<property>=<value>` | equals — the bare property name is the only spelling the renderer sends |
| `<property>.contains=<value>` | contains the text |
| `<property>.gt=` `.gte=` `.lt=` `.lte=` | greater than, at least, less than, at most |
| `<property>.in=<value>` | one of; repeated once per value |
| `<property>.absent=true\|false` | the property is null or missing (`true`), or present (`false`) |
| `facet=<property>` | answers the property's present values instead of rows (below) |

The reserved query names are `limit`, `cursor`, `sort`, `facet`, and anything
starting `_telo`: no filter property may be named one, and `_telo` keys are
reserved to the renderer.

A renderer sends only declared pairs: a filter parameter for a
`{ property, operator }` the collection lists under `query.filters`, a `sort`
by a property under `query.sort` and a `facet` for a property under
`query.facets`. A collection may refuse the rest with a 400.

The response:

```json
{ "rows": [ { "id": 1, "text": "Write the plan" } ], "total": 42, "next": "b3BhcXVl" }
```

`total` counts every row the filters match, not the page. `next` is an opaque
cursor for the following page, and `null` on the last one.

Each row is a record valid against the model, so a record read can be sent
back: a property with no value is left out of the row, or is `null` where the
model admits `null`.

## Facets — `GET <basePath>?facet=<property>`

The present values of one property, with how many records hold each, under the
filters the request carries (the same filter parameters as a listing, `sort`
excluded):

```json
{ "values": [ { "value": 3, "count": 12 }, { "value": 7, "count": 1 } ], "next": null }
```

`values` holds each value that occurs in at least one matching record, once,
with its `count`. It is paged exactly like a listing: `limit` and `cursor` in,
`next` out, `null` on the last page. A record whose property is null or missing
is not counted. A property the collection does not list under `query.facets` is
refused with a 400.

## Refusals — 400

A request the collection refuses answers with a validation problem
(`application/problem+json`), each finding an entry of `data.issues`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request is not valid.",
  "code": "ERR_INPUT_INVALID",
  "data": { "issues": [ { "pointer": "/query/sort", "keyword": "enum", "params": { "allowedValues": ["title", "due"] } } ] }
}
```

An issue is exactly `{ pointer, keyword, params }` and carries no prose:
`pointer` is a JSON Pointer into the request (`/query/sort`; for a refused body
`/body/note`, `/body/address/street` for a nested property), and `keyword` /
`params` come from the closed vocabulary `Http.Api` answers with — a JSON Schema
keyword and its params, or `invalid`. The renderer words each one. A form shows
an issue on the field its first segment after `/body` names, and the rest under
the form.

## Items

| Request | Does |
| --- | --- |
| `GET <basePath>/<key value>` | answers with that one record |
| `POST <basePath>` | creates a row from the JSON body |
| `PUT <basePath>/<key value>` | replaces that row with the JSON body |
| `DELETE <basePath>/<key value>` | deletes it |

A record read by its key may hold more than its row of the list does. An edit
form reads it before it opens, so what it sends back is what the record held
and not what the list happened to show.

`PUT` replaces; it does not merge. Its body is a record valid against the
model of the form that sends it, and a property of that model absent from it
is cleared. A body missing a required property is a 400 naming it.

A write body holds the properties that have a value, in the JSON types the
model declares. The row key is left out, a property with no value is left out
rather than sent as `null`, and a `null` or a value of another JSON type at a
typed property is a 400 naming the property.

So the renderer sends back what the record held: an edit form's body is the
record's properties that the form's model declares, with each field's entered
value over them, and a field left empty is a property left out. A collection that merged instead would keep the
value the user just removed.

A 401 or 403 from any of these is shown where it happened; requests carry the
page's same-origin credentials.
