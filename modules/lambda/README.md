# AWS Lambda

`aws/lambda@0.1.0` — per-source handler kinds dispatched by a `Lambda.Function` `Telo.Service`. One Telo manifest declares one Lambda artifact (one ARN); the Function owns the AWS-facing transport and dispatches incoming events to whichever concrete handlers (`Lambda.Direct` in v1; `Lambda.HttpApi` / `Lambda.Sqs` follow) the user listed.

## Shape

```yaml
kind: Telo.Application
metadata: { name: my-lambda, version: 1.0.0 }
targets: [Main]
---
kind: Telo.Import
metadata: { name: Lambda }
source: aws/lambda@0.1.0
---
kind: Lambda.Direct
metadata: { name: Worker }
handler: { kind: My.Handler }
inputs:
  payload: !cel "event"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.Direct, name: Worker }
```

`Lambda.Function` is the AWS-facing service — it owns the runtime transport (managed-runtime handler export, or custom-runtime AWS Runtime API poll loop). Concrete handler kinds (`Direct`, future `HttpApi`, `Sqs`) are `Telo.Invocable`s with no AWS-facing transport of their own — they only receive `{ event, context }` payloads when the Function dispatches into them. The Function classifies events by structural shape; the kind IS the source.

## Deployment

Two runtime modes; same manifest works for both. Pick by which bootstrap you copy:

**Managed (`nodejs24.x`)** — AWS owns the outer loop:

```bash
telo install ./telo.yaml
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
zip -r function.zip telo.yaml index.mjs .telo node_modules
# Then deploy with AWS handler = index.handler, runtime = nodejs24.x.
```

**Custom (`provided.al2023` / container)** — Telo runs the loop against the AWS Runtime API:

```bash
telo install ./telo.yaml
cp node_modules/@telorun/lambda/custom.mjs ./bootstrap && chmod +x ./bootstrap
zip -r function.zip telo.yaml bootstrap .telo node_modules
# Then deploy with runtime = provided.al2023.
```

The Function controller observes `$AWS_LAMBDA_RUNTIME_API` at runtime and picks the right adapter; the manifest itself is identical across modes.

## v1 Surface

| Kind | Capability | Reference |
|---|---|---|
| `Lambda.Handler` | `Telo.Abstract` (Invocable) | Dispatch contract; concrete kinds `extend` it |
| `Lambda.Function` | `Telo.Service` | AWS-facing transport, event classifier, dispatcher |
| `Lambda.HttpApi` | `Telo.Invocable` | [Lambda.HttpApi](./docs/http-api.md) — API Gateway HTTP API v2 trigger |
| `Lambda.Sqs` | `Telo.Invocable` | [Lambda.Sqs](./docs/sqs.md) — SQS queue trigger, partial-batch-failure envelope |
| `Lambda.Direct` | `Telo.Invocable` | [Lambda.Direct](./docs/direct.md) — catch-all for synchronous invokes, Step Functions, internal RPC |

See also:
- [Deploying](./docs/deploying.md) — packaging flow (zip + image; managed + custom runtimes).
- [Cold Starts](./docs/cold-starts.md) — budget guidance, `x-telo-scope` patterns.
- [Plan](./plans/lambda-function.md) — design rationale.

Out-of-scope follow-ups: response streaming (`mode: stream`), additional handler kinds (`Lambda.RestApi`, `Lambda.FunctionUrl`, `Lambda.EventBridge`, `Lambda.S3`, `Lambda.Schedule`), SnapStart, X-Ray tracing via `@telorun/observability-aws`.
