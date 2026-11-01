# Ui.Data

Data read when a page is drawn, and the trees drawn over it: an account panel,
a context card over one API answer, a sign-in gate. A reader is a
[composite](composite.md).

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record read: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `query` | none | the [query parameters](conditions.md#query-parameters) the reader reads, as `query` |
| `source.path` | required | [app-relative](nodes.md#addresses) URL of the record, read under [the record contract](record-contract.md) |
| `source.params` | none | query parameters sent with the read, by name: a path into `query`, or a fixed value |
| `content` | required | the [node](nodes.md) drawn once an answer is in, over `data` and `query` |
| `loading` | a muted "Loading…" text (the word `loading`) | what is drawn before the first answer, over `query` |
| `failure` | the error's code and message | what is drawn when the read does not succeed, over `error` and `query` |
| `reloadOn` | none | what reads the record again: `focus`, `unauthorized` |

```yaml
kind: Ui.Data
metadata: { name: account }
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [authorized]
    properties:
      authorized: { type: boolean }
      email: { type: string, title: Email }
query:
  signin: { type: string, enum: [denied, expired] }
source: { path: /api/auth }
reloadOn: [focus, unauthorized]
content:
  type: stack
  children:
    - type: value
      value: !cel "data.email"
      shown: { at: !cel "data.authorized", matches: { const: true } }
    - type: composite
      ref: !ref signIn
      shown: { at: !cel "data.authorized", matches: { const: false } }
    - type: text
      text: Your sign-in was refused.
      shown: { at: !cel "query.signin", matches: { const: denied } }
```

A sign-in gate is exactly this: a reader, a [condition](conditions.md) on its
answer, and `reloadOn: [unauthorized]` — no kind of its own.

## Roots

- `data` — the record, typed from `model`, inside `content`.
- `error` — a `Ui.RequestError` (`{ status?, code?, message? }`) inside
  `failure`; `status` is absent when nothing answered.
- `query` — the declared query parameters, in all three trees and in
  `source.params`; closed and empty with none declared.

Each is read only by what is named — a condition's `at`, a `value` or `list`
node, a parameter. A `when` in the trees is evaluated once, when the reader is
created, and reads none of them.

## When it reads

- When it is first drawn, and again whenever the address it reads changes —
  a parameter reading `query` follows the page's address.
- `focus` — when the window regains focus, and when the page is restored from
  the browser's back/forward cache.
- `unauthorized` — when a request made by anything drawn inside its `content`
  answers 401: a listing's page, a form's save, an action, a custom component's
  `fetch`, at any depth, across composite placements. Its own read never
  counts, so a refused read cannot loop; a 401 or 403 to its own read draws
  `failure`.
- When an operation it shares a path with changes it — the path-keyed
  invalidation listings use.

At most one read is in flight; any number of triggers during it cause exactly
one more read after it, and an answer to an address the reader no longer reads
is never drawn. `loading` is drawn only before the first answer: a reload keeps
the content mounted and drawn, and a later failure keeps it mounted out of
sight. Hidden by a condition, a reader reads nothing; a trigger that arrives
meanwhile is read once when it is shown.

## What a renderer receives

A `data` node: `{ schema, source: { path, params }, query, content, loading,
failure, reloadOn }`, every member present — `params` a map of bindings
(`{ }` when none), `query` the declared parameters (`{ }` when none), the three
trees resolved as a [view](view.md)'s are (a node whose `when` is false at
creation left out, `shown` carried as written, each `value` and `list` node
with what `data`, `error` or `query` say about the values it names), `loading`
and `failure` filled when left out, and `reloadOn` a list (`[]` when none).
