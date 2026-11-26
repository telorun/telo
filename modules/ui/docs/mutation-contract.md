# The mutation contract

What the URL of a [`Ui.Mutation`](mutation.md) must speak. Any operation that
answers this way can be run from a page — from a button, a row, a form's
`onSubmit` or its `autosave`.

## The request — `<method> <target>`

`method` is the mutation's `method` (`POST` by default, `PUT`, `PATCH` or
`DELETE`) and `<target>` its `url`, a [request target](nodes.md#addresses)
resolved over the record the call sends, `input`.

An input property is **consumed** when a `pathParams` or `queryParams` binding
is exactly `input.<property>`. A consumed property travels in the target, so
the body is the input model's remaining properties.

| Method | Body |
| --- | --- |
| `POST`, `PUT`, `PATCH` | `content-type: application/json`: each property that has a value, in the JSON type the model declares, minus the consumed ones. A property with no value is left out rather than sent as `null`, and so is a list with nothing in it |
| `DELETE` | none. Every input property is consumed ([`UI_MUTATION_INPUT_UNSENT`](mutation.md#refused)) |

The body is valid against the route's request schema, which is the input model
minus the consumed properties; the route's path parameters are the consumed
ones. Requests carry the page's same-origin credentials.

## Preconditions

A server opts in to conditional writes by answering a read or a write of a
record with an `ETag`. The renderer keeps, per request path (its query left
out), the `ETag` of the last `GET`, `PATCH` or `PUT` answer at that path, and a
`PATCH`, `PUT` or `DELETE` to the path carries it as `If-Match`; a write's
answer replaces it. A server sending no `ETag` is sent no `If-Match` and
behaves as it always did. Nothing is declared in the manifest: the validator
belongs to the path, so a mutation whose url is a record's path is guarded
once that record has been read — by a [`Ui.Query`](query.md), a form's
edit page — and one whose target nothing read is not.

A refused precondition answers `412`. It draws the call's `failure` tree with the
problem's own `code` (`ERR_UI_PRECONDITION_FAILED` when it names none), the
inputs the person entered stay, and the path is announced as changed, so every
reader of it reads again and takes the new validator. Pressing again sends the
same inputs against the current record.

## The answer

| Status | Means | Shown |
| --- | --- | --- |
| any 2xx | done | the call's `result` tree, drawn from the body |
| 400 | the record was refused | on the fields, and the `failure` tree |
| 401, 403 | not allowed | the `failure` tree |
| 412 | the record changed since it was read ([below](#preconditions)) | the `failure` tree |
| anything else, or no answer at all | failed | the `failure` tree |

**A 2xx body** is a JSON object valid against `outputModel`. It is read only
when something reads `result` — the call's `result` tree, an `onSuccess`
effect or an `invalidates` entry; a mutation whose answer nothing reads may
answer with anything, or with nothing, a 204 included. A body that is read and
is not a JSON object, that is empty, or that `outputModel` refuses, is a
failure with `code: ERR_UI_RESPONSE_INVALID`.

**Any other answer** may carry a problem body (RFC 9457, `application/problem+json`
— what an `Http.Api` answers every error with), whose `code` and `detail` the
`failure` tree reads as `error.code` and `error.message` beside `error.status`.
Without a `code`, `code` is `ERR_UI_UNAUTHORIZED` for a 401, `ERR_UI_FORBIDDEN`
for a 403, `ERR_UI_PRECONDITION_FAILED` for a 412 and `ERR_UI_REQUEST_FAILED`
otherwise; without a `detail`, `message`
is `ui`'s own text for the status. With no answer at all `status` is
absent and `code` is `ERR_UI_REQUEST_FAILED`.

**A 400** is the validation problem
[a collection answers with](https://hub.telo.run/module/oci/ghcr.io/telorun/data-model/), its findings
in `data.issues`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request is not valid.",
  "code": "ERR_INPUT_INVALID",
  "data": { "issues": [ { "pointer": "/body/month", "keyword": "pattern", "params": { "pattern": "^[0-9]{4}-[0-9]{2}$" } } ] }
}
```

An issue whose `pointer` names a shown field's property as its first segment
after `/body` marks that field, worded by the issue's `keyword` and `params`
in the page's language — with the text the browser's own validation shows for
that keyword ([`ui`'s own texts](texts.md#uis-own-texts)). Every other
issue is shown under the form, as its path and that text, and the `failure`
tree reads the problem's `code` and `detail`.

## One shape, named twice

The route and the mutation are written over the same two shapes — the route's
body is the input model minus the consumed properties, its path parameters the
consumed ones — so the page cannot send what the route refuses or draw what it
does not answer:

```yaml
kind: Telo.JsonSchema
metadata: { name: ReportRequest }
schema:
  type: object
  required: [month]
  properties:
    month: { type: string, title: Month, pattern: "^[0-9]{4}-[0-9]{2}$" }
---
kind: Telo.JsonSchema
metadata: { name: ReportAnswer }
schema:
  type: object
  required: [files]
  properties:
    files:
      type: array
      items:
        type: object
        properties:
          name: { type: string, title: File }
          url: { type: string, title: Download, format: uri-reference }
---
kind: Http.Api
metadata: { name: reportsApi }
routes:
  - request:
      path: /reports
      method: POST
      schema:
        body:
          type: object
          required: [month]
          properties:
            month: { type: string, title: Month, pattern: "^[0-9]{4}-[0-9]{2}$" }
    handler: !ref generateReports
    inputs: !cel "request.body"
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              required: [files]
              properties:
                files:
                  type: array
                  items:
                    type: object
                    properties:
                      name: { type: string, title: File }
                      url: { type: string, title: Download, format: uri-reference }
            body: !cel "result"
---
kind: Ui.Mutation
metadata: { name: generate }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
url: /api/reports
```

A button runs it and draws the answer:

```yaml
- type: button
  action:
    mutation: !ref generate
    inputs: { month: !cel "params.month" }
    label: Generate
    result:
      type: list
      rows: !cel "result.files"
      columns:
        - value: !cel "row.name"
        - value: !cel "row.url"
```

## From bound inputs

A [call](mutation.md#calls) — a row's, a button's, an annotation's or a
layout's `move` — sends the same request, its input built from the data in
scope instead of a form: each input the call binds, a path that resolves to
nothing left out — and, where the call declares a `prompt`, each entry its
dialog collected, read as `prompt`. That input fills the mutation's `url`, so a
bound `id` that the url consumes goes in the path and leaves the body: renaming
a conversation from its row is `PATCH /api/chat/conversations/<id>` with
`{ title }`. A prompted entry may be consumed by the url too. A form's
`onSubmit` and `autosave` build their input from the form's `values` the same
way. The answer is read and drawn as the call's own: the `result` tree in place
of the row's button, the `failure` tree beside it; a 400 to a call that prompts
is shown on its dialog's fields, as a form's is.

## After a 2xx

The resolved `url` path, each resolved `invalidates` path and, in a listing, its
`basePath` are announced as changed (a listing's own item writes announce the
item path too). A `Ui.Query`, `Ui.Listing` or `Ui.Chat` whose request path —
resolved, encoded, app-relative, query excluded — equals an announced one reads
again. A form's write announces the same: `onSubmit` the mutation's, an
`autosave` its own url and `invalidates` after each acknowledged save, and a
record editor's default write the collection's `<basePath>` and
`<basePath>/<key value>`.
