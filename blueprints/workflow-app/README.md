# WorkflowApp

A complete workflow application from one declaration. List the workflows; each
one is served over HTTP at its own endpoint.

```yaml
imports:
  WorkflowApp: oci://ghcr.io/telorun/blueprints/workflow-app@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref app
---
kind: WorkflowApp.App
metadata:
  name: app
port: 8848
workflows:
  - request: { path: /greet, method: POST }
    inputs:
      name: !cel "request.body.name"
    handler:
      kind: Run.Sequence
      steps:
        - name: greeting
          value: !cel "'Hello, ' + inputs.name + '!'"
      outputs:
        greeting: !cel "steps.greeting.result"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result"
```

## Fields

| Field | Meaning |
|---|---|
| `port` | TCP port the server listens on. |
| `title` | Title of the generated OpenAPI document (default `Workflows`). |
| `workflows[].request` | `path`, `method`, and an optional `schema:` (`params`, `query`, `body`, `headers`) that validates the request and types `request.*` in `inputs`. A request failing it is answered `400`. |
| `workflows[].inputs` | CEL mapping from the request onto the workflow's inputs. |
| `workflows[].handler` | The workflow: a `Run.Sequence`, a durable workflow, or any invocable, declared inline or as `!ref`. |
| `workflows[].returns` | How the result is rendered — the `Http.Api` route `returns:` list. |

A workflow item is exactly an `Http.Api` route: the kind forwards the list to
its router unchanged, which is what carries each handler reference through. So
every route field is accepted (`catches:`, `summary:`, `operationId:`, …), and
`telo check` validates each workflow as the router validates a route — its
request matcher, its `returns:` entries and the CEL in `inputs:` / `returns:` —
reporting any problem on the workflow's own line.

## What it builds

One `Http.Server` on `port`, publishing an OpenAPI document titled `title`, with
one `Http.Api` mounted at `/` whose routes are the workflows. Nothing else.

See [`example/`](./example/telo.yaml) for a two-workflow app and
[`tests/`](./tests) for how it is exercised.
