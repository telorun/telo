# Conformance rows

Data files a renderer's tests read, so every renderer answers what `ui`
answers. Each is one JSON object, `{ description, rows }`, every row carrying a
`name` and the case's inputs and expected outcome. All three ship with the
module through `files:`.

| File | Pins |
| --- | --- |
| `match.json` | what a `Ui.Match` condition holds for a value |
| `control-fits.json` | which control fits which property, the rule `Ui.controlFits` states |
| `listing-reads.json` | the exact requests a listing's read plan sends |

## `listing-reads.json`

One row is one read of a listing — one value of the plan's product: a group, a
shown period, a tree level — and one event on it. Its members:

| Member | |
| --- | --- |
| `name` | what the row shows |
| `listing` | what every read of the listing carries: `basePath`, `pageSize`, `filters` (the listing's own, as the `[name, value]` pairs sent), `bar` (the filter bar's, in the bar's order), `sort` (the viewer's: one property, `-` before it for descending; absent for none), and `paging` (the listing's, which the requests do not depend on) |
| `reads` | the layout spec's `reads`, as `ui` produces it |
| `read` | which read of the product: `group` (a group's value, as sent), `period` (`{ from, to }`, the shown period's first and last moment, as sent), `parent` (the key of the record whose children are read; absent for the roots) |
| `event` | `open` (the read's first page), `more` (its next page), `reload` (the pages loaded, read again), `values` (one page of the grouping's values) |
| `loaded` | with `more` and `reload`: the `next` each page loaded so far answered, in order |
| `answers` | with `reload`: the `next` each refetched page answers, in order |
| `relations` | with `values` over a relation: each relation's source, `{ basePath, pageSize }`, by the key `reads.groups.relation` names |
| `requests` | what is sent, in order, each `{ path, params }`: the app-relative path and the query parameters as `[name, value]` pairs in the order sent |

A request's parameters come in one order: `limit`, then `cursor`, then `sort`
(or `facet`, which carries no sort), then the listing's filters, the bar's, and
last what the plan adds — the group's `<property>=<value>`, the period's bounds
(`<start>.gte` and `<start>.lte`, or with `end` the overlap pair `<start>.lte`
and `<end>.gte`), and the tree level (`<parent>.absent=true` for the roots,
`<parent>=<key>` for a record's children).

A reload refetches the pages loaded from the first, each with the cursor the
refetch before it answered, since a cursor is opaque, and stops at an answer
with no `next`. With more than 10 pages loaded in one read it refetches the
first page alone.

`ui` produces the rows' requests through the functions `@telorun/ui` exports
(`pageRequest`, `reloadRequests`, `valuesRequest`); its own unit test holds them
to every row.
