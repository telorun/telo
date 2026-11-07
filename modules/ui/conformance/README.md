# Conformance rows

Data files a renderer's tests read, so every renderer answers what `ui`
answers. Each is one JSON object, `{ description, rows }`, every row carrying a
`name` and the case's inputs and expected outcome. All seven ship with the
module through `files:`.

| File | Pins |
| --- | --- |
| `match.json` | what a `Ui.Match` condition holds for a value |
| `control-fits.json` | which control fits which property, the rule `Ui.controlFits` states |
| `listing-reads.json` | the exact requests a listing's read plan sends |
| `addresses.json` | the text an address or request target resolves to, or the parameter it is unresolved for |
| `current-location.json` | whether a link to an address is marked as the current location |
| `refreshes.json` | which readers a refresh entry, with its `*` / `**` segments, reads again |
| `filter-tokens.json` | how text typed into a search-box filter bar becomes the bar's values |

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

## `addresses.json`

One row is one address in the wire form `ui` produces (`{ path, pathParams,
queryParams }`, every member a binding), the `roots` its chains read from, and
either `url` — the text it resolves to — or `unresolved`, the `parameter` the
`ERR_UI_ADDRESS_UNRESOLVED` error names (`path` when the whole address, or a
path read from data, is unusable). The rules the rows pin:

- A literal `path` is a template; a `{name}` segment is replaced by the value of
  `pathParams.<name>`, percent-encoded as one segment so only RFC 3986's
  unreserved characters stay, a whole `.` or `..` becoming `%2E` / `%2E%2E`.
  An integer is its decimal; an empty, null, absent or non-text value is
  unresolved.
- A `path` read from data is used as it is, never expanded.
- `queryParams` follow in declaration order, form-urlencoded; null, absent and
  empty lists are left out, a list repeats its key, a boolean is `true` or
  `false`, a number its JSON text. They are appended after the path's own query
  and before its fragment.
- The result is held to the address rule: under the mount, or an `https:`,
  `http:` or `mailto:` address.

## `current-location.json`

One row is the text an address resolves to, the viewer's `location` (`path`
under the mount, and `search`), and whether a link to it is `current`. The
rules the rows pin: an app-relative address is current when its path equals the
current path exactly (the fragment ignored) and its query equals the current
one once every parameter named `_telo*` is set aside — key order free, each
key's values compared as an ordered list, an absent key absent. An `https:`,
`http:` or `mailto:` address is never current. A parameter the application did
not write unmarks the link. Only a renderer draws links, so only renderers read
this file.

## `refreshes.json`

One row is a `refreshes` entry in the wire form (`address`, with `roots` for
its chains), the encoded app-relative `path` a reader is keyed by, and whether
it `match`es, so the reader reads again. A pattern is matched segment by
segment against the resolved, encoded path with its query left out: a `*`
segment is exactly one non-empty segment, a `**` segment any number of them,
none included (`/a/7/**` covers `/a/7`). A segment is a wildcard only when the
whole segment is `*` or `**` in a literal template: a `{name}` value is
encoded, so a star in it is text, and a path read from data is exact. An entry
with no wildcard matches only its own path. Only renderers read this file.

## `filter-tokens.json`

`{ description, fields, rows }`. `fields` is the bar the rows are read over
unless a row brings its own: each filter is `{ property, operator, schema,
labels?, relation? }` — `labels` the text each listed value is shown as,
`relation` set where its values are records of another collection. A filter
is named in a row by its key: the property, with `.<operator>` unless the
operator is `eq`.

| Member | |
| --- | --- |
| `name` | what the row shows |
| `fields` | the bar's filters, where the row does not use the file's |
| `typed` | the text in the box |
| `holding` | the bar's values before the text is read, by filter key; absent for an empty bar |
| `result` | the reading: `kind` `text` (no property named), `open` (a property and operator, no value yet), `query` (a relation's property: `query` is the text for its records, never a value), `token` (`values` the filter would hold) or `invalid` (`reason`, and the filter's key where the property and operator were found); `field` is the filter's key |
| `after` | with a `token`: the bar's values once it is committed — the filter holds the token's values and nothing it held |

A token is `<property><operator><value>`, read from the text alone. The
property is matched ignoring case. `:` picks the property's `contains` filter,
else its `in`, else its `eq`; `=` its `in`, else its `eq`; `>`, `>=`, `<` and
`<=` its `gt`, `gte`, `lt` and `lte`. Under `in` commas separate values, and
each is matched by its value or its label, ignoring case; under every other
operator the whole text is one value, commas and spaces included. A relation's
text is never a value. The reasons: `unknown-property` (the bar has no filter
on it), `operator-unsupported` (none of its filters takes the operator),
`value-not-listed` (an enumeration or boolean value that is not listed) and
`value-invalid` (not a number, or not a date). Only renderers read this file.
