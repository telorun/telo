# ApprovalApp

A request that waits for a human decision, from one declaration. Describe what
a request carries, which requests skip review, and what happens once one is
decided; the endpoints, the wait and its recovery come with the blueprint.

```yaml
imports:
  ApprovalApp: oci://ghcr.io/telorun/blueprints/approval-app@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref approvals
---
kind: ApprovalApp.App
metadata:
  name: approvals
port: 8850
request:
  type: object
  required: [employee, amountCents]
  properties:
    employee: { type: string }
    amountCents: { type: integer }
autoApprove: !cel "request.body.amountCents < 10000"
onApproved:
  kind: Run.Sequence
  steps: [ … pay it … ]
onRejected:
  kind: Run.Sequence
  steps: [ … tell the requester … ]
```

## Fields

| Field | Meaning |
|---|---|
| `port` | TCP port the server listens on. |
| `title` | Title of the generated OpenAPI document (default `Approvals`). |
| `request` | JSON Schema of a submission. It validates `POST /requests` and reaches both handlers as `inputs.request`. |
| `autoApprove` | CEL over the submission (`request.body`); a request it holds for is approved without review, `decidedBy: policy`. Default: every request is reviewed. |
| `timeout` | How long a request waits for a reviewer before it is rejected, `decidedBy: deadline` (default `168h`). Counted from submission and kept across restarts. |
| `journal` | Directory the requests and their progress are recorded in — required, an absolute path. Pass it from your application's own variable declared `x-telo-type: Telo.HostPath` (default e.g. `.telo/approvals`), which resolves it against the working directory. |
| `onApproved` / `onRejected` | What runs once the decision is in — any invocable, declared inline or as `!ref`. Each receives `id`, `request`, `decidedBy` and `note`. |

## Endpoints

| Endpoint | Answer |
|---|---|
| `POST /requests` | `202 { id, status }` — the request is recorded and, unless approved by the rule, waits. A body failing `request` is `400`. |
| `GET /requests/{id}` | `200 { id, status, decision }` — `status` is `pending` while it waits, `completed` once decided; `decision` is `{ approved, decidedBy, note }` or `null`. An unknown id is `404`. |
| `POST /requests/{id}/approve` | `202` with `{ decidedBy, note? }`; `409` when the request is not waiting — unknown, or already decided. |
| `POST /requests/{id}/reject` | As `approve`, deciding the other way. |

## What it builds

A durable workflow per request, recorded in a file journal: the rule's verdict
and the reviewer's answer are both part of the record, so a restart while a
request waits continues at the wait, and a handler that already ran does not run
again. A poller picks up requests whose process stopped and continues each one
once its decision is delivered. One `Http.Server` on `port` serves the four
endpoints with an OpenAPI document titled `title`.

See [`example/`](./example/telo.yaml) for expense claims and [`tests/`](./tests)
for each path a request can take.
