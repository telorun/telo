# Ui.Query

A declared read that draws nothing: the shape of an answer, where it is read
from, what it sends, and when it is read again. Nodes draw it — a
[`query` node](nodes.md#the-query-node) places one query's answer in a page, a
layout region or a [view](view.md), and any number of nodes may draw the same
query from one read.

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the answer: a `!ref` to a `Telo.JsonSchema`, or one inline. A 2xx JSON object valid against it is a success |
| `url` | required | where the answer is read from, under [the record contract](record-contract.md): a `Ui.RequestTarget` over `query` and `params` — an app-relative path string, or `{ path, pathParams, queryParams }` like an [address](nodes.md#addresses) that is never a page. `path` may be a template (`/accounts/{id}`) filled by `pathParams`; `queryParams` are sent as the query. A value that holds nothing leaves the read unsent |
| `input` | none | what the read sends as a JSON body: `{ method?, model, body }`. Without it the read is a `GET` |
| `query` | none | the [query parameters](conditions.md#query-parameters) the query reads, as `query` |
| `reloadOn` | none | what reads the answer again: `focus`, `unauthorized` |
| `reloadEvery` | none | how often the answer is read again while a node drawing it is shown, a duration of at least `5s` — see [When it reads](#when-it-reads) |

```yaml
kind: Ui.Query
metadata: { name: account }
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [authorized]
    properties:
      authorized: { type: boolean }
      email: { type: string, title: Email }
url: /api/auth
reloadOn: [focus, unauthorized]
```

A query used by one node is written inline at its `query` slot; one drawn by
several gets a name and is `!ref`-ed. A sign-in gate is a query, a
[condition](conditions.md) on its answer, and `reloadOn: [unauthorized]` — no
kind of its own.

## A read with a body

`input` says what the read sends. `method` is `QUERY` — the safe method with a
body, which says a read sent again on every change, focus and tick is harmless
— unless written `POST`; any other method, `GET` included, is a
`SCHEMA_VIOLATION`, so a body under `GET` cannot be written.

`body` is a template: a map or list to any depth, each leaf a plain chain over
`query` and `params` or a literal.

```yaml
kind: Ui.Query
metadata: { name: report }
model: !ref ReportAnswer
query:
  from: { type: string, format: date }
  to: { type: string, format: date }
  project: { type: array, items: { type: string } }
url: /api/report
input:
  method: QUERY
  model: !ref ReportRequest
  body:
    period: { from: !cel "query.from", to: !cel "query.to" }
    projects: !cel "query.project"
reloadEvery: 1m
```

- **What is sent.** A chain holding nothing — a missing parameter or `null` —
  leaves its member (or its list item) out; a literal is sent as written,
  `null` included; a map is sent even when every member was left out. The rows
  are pinned by `conformance/template-bindings.json`.
- **Typed by `input.model`.** `telo check` judges the template against the
  model as a value is judged against a declared type: a literal that does not
  fit or a missing member is `SCHEMA_VIOLATION`, a chain whose type or format
  does not fit its member is `CEL_TYPE_ERROR`, and a computed value that is not
  a plain chain is `ACCESSOR_NOT_PLAIN_CHAIN`. A chain that may hold nothing is
  admitted at a required member: whether the request is complete is the
  route's to say, and a body the route refuses is answered 400 with issues at
  `/body/…`, which the node's `failure` draws.
- **Addresses are typed by their grammar.** `url`'s `queryParams` stay typed by
  their own chains: a record is modelled by `input.model`, an address is not.
- **`POST`.** An intermediary that does not forward `QUERY` (some CDNs,
  gateways and firewalls) answers with a status the node's `failure` draws. The
  fix is `input.method: POST` with the route declared `POST`; the request is
  otherwise the same.
- **Dates.** A query parameter declared `{ type: string, format: date }` holds
  only an RFC 3339 full-date — `?to=oops` reads as absent — and a chain over it
  fits a body member declared `format: date`.

## Roots

- `data` — the answer, typed from `model`, in a node's `content`.
- `error` — a `Ui.RequestError` (`{ status?, code?, message? }`) in a node's
  `failure`; `status` is absent when nothing answered.
- `query` — the query's declared parameters, in the node's lists (and every
  view placed there) and at every site of the query itself — `url` and
  `input.body` among them; closed and empty with none declared, open in a
  library whose importer supplies the query.
- `params` — the placing page's [path variables](page.md#params), in the node's
  lists and at every site of the query itself, typed from each page placing the
  query.

Each is read only by what is named — a condition's `at`, a `value` or `list`
node, a parameter. A `when` in a tree is evaluated once, when the tree is
created, and reads none of them.

## One query, one read

Every node drawing the same query — in the page, in the layout's header, in any
document the mount serves — draws from **one read**, keyed by the declaration's
identity (the `id`) and its resolved request: one request, one state. The nodes
load, succeed and fail together, each drawing that state with its own trees,
since a header wants a small placeholder where the body wants a large one. An
inline query inside a view placed twice is one declaration, so one read per
resolved request. Two queries that happen to resolve to the same request stay
two, so a change to one never silently changes the other.

- **Hold.** A read's state is held while at least one mounted node — shown, or
  hidden by `shown` — resolves to its key.
- **Read.** It reads only while a holding node is shown; a trigger arriving
  while all are hidden is read once when one is shown.
- **Drop.** It is dropped, its request in flight aborted, when the last such
  node unmounts or moves to another key: at most one state per held key,
  however often a body changes.
- A node whose request changes keeps drawing its last answer until the new key
  answers; `loading` is drawn only before a node's first answer.

To draw nothing until a parameter is chosen, hide the node with `shown`.

## When it reads

- When it is first drawn, and again whenever its request changes — its
  resolved address, or its resolved body.
- `focus` — when the window regains focus, and when the page is restored from
  the browser's back/forward cache.
- `reloadEvery` — every interval while a node drawing it is shown. A tick is
  skipped while a read is in flight and is not run while the document is
  hidden; coming back to visibility reads once if an interval has passed. A
  tick that fails keeps what is drawn and shows `failure` beside it, and the
  next tick tries again. It is a literal: a value below `5s` is refused by
  `telo check` (`SCHEMA_VIOLATION`) and when the query is created
  (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`).
- `unauthorized` — when a request made by anything drawn inside any of its
  nodes' `content`, `loading` or `failure` answers 401: a listing's page, a form's save, an action, a
  custom component's `fetch`, at any depth, across composite placements. Its own
  read never counts, so a refused read cannot loop; a 401 or 403 to its own
  read draws `failure`.
- When an operation it shares a path with changes it — the path-keyed
  invalidation listings use, matching a `QUERY` or `POST` read by its path as a
  `GET`. A query never announces a path itself.

At most one read is in flight; any number of triggers during it cause exactly
one more read after it, and an answer to a request the query no longer makes is
never drawn.

## What a renderer receives

A `query` node carries a `Ui.QuerySpec`:
`{ id, schema, method, url, input, query, reloadOn }`, every member present
(plus `reloadEvery` when set) —

- `id` the declaration's identity, qualified by its module so two modules'
  queries never share one: a named query's `<module>/<name>`
  (`Shop/account`), an inline one's `<module>/<holder>/<path>` — the holder's
  name and the place it is written (`Shop/web/pages/0/children/1/query`) — the
  same in every document a mount serves.
- `method` `GET`, `QUERY` or `POST`; `GET` exactly when there is no `input`.
- `url` the address wire, `{ path: { value }, pathParams, queryParams }` with
  each path variable and query parameter a binding (`{ root, path }` or
  `{ value }`).
- `input` `null`, or `{ body }` — the template as bindings: a chain or a
  `{ value }`, or a `{ map }` / `{ list }` of them for a structure holding a
  chain, one `{ value }` for a structure holding none.
- `query` the declared parameters (`{ }` when none), `reloadOn` a list (`[]`
  when none) — plus `reloadEvery`, an integer number of milliseconds of at least
  `5000`, omitted when it is not written.
