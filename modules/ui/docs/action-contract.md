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
| any 2xx | done | each declared list, drawn from the body |
| 400 | the record was refused | on the fields, and under the form |
| 401, 403 | not allowed | an `error` node: `ERR_UI_UNAUTHORIZED`, `ERR_UI_FORBIDDEN` |
| anything else, or no answer at all | failed | an `error` node: `ERR_UI_REQUEST_FAILED` |

**A 2xx body** is a JSON object valid against `outputModel`. It is read only
when the action declares `lists`; an action with none may answer with anything,
or with nothing. A 2xx whose body is not a JSON object, on an action that
declares lists, is an `error` node `ERR_UI_RESPONSE_INVALID`.

**A 400** is the request-validation envelope
[a collection answers with](collection-contract.md#refusals--400):

```json
{
  "error": "ValidationError",
  "message": "Request validation failed",
  "status": 400,
  "details": [ { "location": "body", "path": "month", "message": "must match pattern \"^[0-9]{4}-[0-9]{2}$\"" } ]
}
```

A detail whose `path` is exactly a shown field's property marks that field with
its `message`. Every other detail is shown under the form, and so is a bare
`message` when the envelope carries no details.

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
lists:
  - rows: !cel "result.files"
    columns:
      - value: !cel "row.name"
      - value: !cel "row.url"
```

## From a row

[A row action](table.md#row-actions) sends the same request, its body built
from the row instead of a form: each input the entry binds, a path that
resolves to nothing left out. Any 2xx reloads every table over the same
`source.basePath` on the page, and the body is not read. Any other answer is
shown to the viewer and nothing reloads.
