# The collection contract

What the URL in a `source.basePath` must speak for a table, a form and a
filter bar to work over it. Any API that answers this way can be a source.

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

Query keys beginning `_telo` are reserved to the renderer.

The response:

```json
{ "rows": [ { "id": 1, "text": "Write the plan" } ], "total": 42, "next": "b3BhcXVl" }
```

`total` counts every row the filters match, not the page. `next` is an opaque
cursor for the following page, and `null` on the last one.

Each row is a record valid against the model, so a record read can be sent
back: a property with no value is left out of the row, or is `null` where the
model admits `null`.

## Refusals — 400

A request the collection refuses answers with the request-validation envelope:

```json
{
  "error": "ValidationError",
  "message": "Request validation failed",
  "status": 400,
  "details": [ { "location": "query", "path": "sort", "message": "names no property" } ]
}
```

For a refused body, `location` is `body` and `path` is the property's name
exactly as the model spells it (`note`; `address.street` for a nested one). A
form shows a detail on the field whose property its `path` equals, and the
rest under the form.

## Items

| Request | Does |
| --- | --- |
| `POST <basePath>` | creates a row from the JSON body |
| `PUT <basePath>/<rowKey value>` | replaces that row with the JSON body |
| `DELETE <basePath>/<rowKey value>` | deletes it |

`PUT` replaces; it does not merge. Its body is a whole record, valid against
the model exactly as a `POST` body is, and a property absent from it is
cleared. A body missing a required property is a 400 naming it.

A write body holds the properties that have a value, in the JSON types the
model declares. The row key is left out, a property with no value is left out
rather than sent as `null`, and a `null` or a value of another JSON type at a
typed property is a 400 naming the property.

So the renderer sends back what the row held: an edit form's body is the row's
model properties with each field's entered value over them, and a field left
empty is a property left out. A collection that merged instead would keep the
value the user just removed.

A 401 or 403 from any of these is shown where it happened; requests carry the
page's same-origin credentials.
