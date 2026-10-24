# The action contract

What the URL in a [`Ui.Action`](action.md)'s `source.path` must speak. Any
operation that answers this way can be run from a page.

## The request — `POST <path>`

`content-type: application/json`. The body is a record valid against the
action's `inputModel`: each field that has a value, in the JSON type the model
declares. A property with no value is left out rather than sent as `null`, and
so is a list with nothing in it.

Requests carry the page's same-origin credentials.

## The answer

| Status | Means | Shown |
| --- | --- | --- |
| any 2xx | done | the `result` tree, drawn from the body |
| 400 | the record was refused | on the fields, and the `failure` tree |
| 401, 403 | not allowed | the `failure` tree |
| anything else, or no answer at all | failed | the `failure` tree |

**A 2xx body** is a JSON object valid against `outputModel`. It is read only
when the action's `result` tree or `onSuccess.navigate` reads `result`; an
action whose answer nothing reads may answer with anything, or with nothing. A
body that is read and is not a JSON object, or that `outputModel` refuses, is a
failure with `code: ERR_UI_RESPONSE_INVALID`.

**Any other answer** may carry a problem body (RFC 9457, `application/problem+json`
— what an `Http.Api` answers every error with), whose `code` and `detail` the
`failure` tree reads as `error.code` and `error.message` beside `error.status`.
Without a `code`, `code` is `ERR_UI_UNAUTHORIZED` for a 401, `ERR_UI_FORBIDDEN`
for a 403 and `ERR_UI_REQUEST_FAILED` otherwise; without a `detail`, `message`
is the renderer's own word for the status. With no answer at all `status` is
absent and `code` is `ERR_UI_REQUEST_FAILED`.

**A 400** is the validation problem
[a collection answers with](collection-contract.md#refusals--400), its findings
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
in the page's language — with the word the browser's own validation says for
that keyword ([`Ui.Words`](texts.md#the-renderers-own-words)). Every other
issue is shown under the form, as its path and that word, and the `failure`
tree reads the problem's `code` and `detail`.

## One shape, named twice

The route and the action are written over the same two shapes, so the page
cannot send what the route refuses or draw what it does not answer:

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
kind: Ui.Action
metadata: { name: generate }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
source: { path: /api/reports }
label: Generate
result:
  type: list
  rows: !cel "result.files"
  columns:
    - value: !cel "row.name"
    - value: !cel "row.url"
```

## From a row

[A row action](action.md#row-actions) sends the same request, its body built
from the row instead of a form: each input the entry binds, a path that
resolves to nothing left out — and, where the entry declares `prompt`, each
field its dialog entered. Its answer is read and drawn as the action's own:
the `result` tree in place of the row's button, the `failure` tree beside it;
a 400 to an entry that prompts is shown on its dialog's fields, as a form's
is. In a table, any 2xx also reloads every table over the same
`source.basePath` on the page.
