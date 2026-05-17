# AWS Lambda

Run your Telo manifest as an AWS Lambda function. One manifest = one Lambda artifact. The manifest declares which AWS event sources the Lambda accepts (HTTP requests, SQS messages, direct invokes, ...) and what each handler does; Telo owns the AWS-facing transport so you don't write boilerplate.

## How it fits together

```yaml
kind: Telo.Application
metadata: { name: my-lambda, version: 1.0.0 }
targets: [Main]
---
kind: Telo.Import
metadata: { name: Lambda }
source: aws/lambda@0.2.1
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

`Lambda.Function` represents the AWS Lambda itself. The handler kinds (`Direct`, `HttpApi`, `Sqs`) describe what the Lambda does per incoming event. List them under `Lambda.Function.handlers` and Telo routes each event to the right one.

## Picking a handler kind

| Source | Use | Reference |
|---|---|---|
| HTTP request via API Gateway HTTP API v2 | `Lambda.HttpApi` | [Lambda.HttpApi](./docs/http-api.md) |
| SQS message batch | `Lambda.Sqs` | [Lambda.Sqs](./docs/sqs.md) |
| Synchronous SDK invoke, Step Functions, EventBridge Scheduler, internal RPC | `Lambda.Direct` | [Lambda.Direct](./docs/direct.md) |

A single `Lambda.Function` can list multiple handler kinds. Bind the AWS-side event source mappings (API Gateway, SQS, etc.) to the same Lambda ARN and Telo routes each event to the matching handler:

```yaml
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.HttpApi, name: WebApi }
  - { kind: Lambda.Sqs, name: OrderProcessor }
  - { kind: Lambda.Direct, name: AdminTools }
```

## Deployment

Telo supports both AWS Lambda runtime models. The manifest is identical across them — you pick a model by which bootstrap file you copy into the artifact.

| Runtime | Bootstrap | When to use |
|---|---|---|
| Managed Node (`nodejs24.x`) | `cp node_modules/@telorun/lambda/managed.mjs ./index.mjs` | Most cases. AWS owns the outer loop and calls your exported handler. |
| Custom (`provided.al2023` / container image) | `cp node_modules/@telorun/lambda/custom.mjs ./bootstrap` | Containers, SnapStart-incompatible runtimes, anywhere you want full control over the boot sequence. |

The same manifest runs under either model — Telo detects which one AWS is using and adapts. You only change which bootstrap you copy.

See [Deploying](./docs/deploying.md) for the full packaging flow and platform-specific deploy templates (SAM, CDK, Terraform).

## Examples

Working manifests under [`examples/aws/lambda/`](https://github.com/telorun/telo/tree/main/examples/aws/lambda) — copy one as a starting point:

- [`direct.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/direct.yaml) — minimal `Lambda.Direct` setup.
- [`http-api.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/http-api.yaml) — two HTTP routes with CORS and structured error rendering.
- [`sqs.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/sqs.yaml) — SQS batch handling with per-message retry reporting.
- [`multi-kind.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/multi-kind.yaml) — one Lambda artifact serving all three event sources.

## Reference

- [Lambda.HttpApi](./docs/http-api.md) — routes, request matching, response rendering, CORS.
- [Lambda.Sqs](./docs/sqs.md) — batch handling, partial-batch failures.
- [Lambda.Direct](./docs/direct.md) — synchronous invokes, returns matching.
- [Deploying](./docs/deploying.md) — packaging, both runtime models, SAM / CDK / Terraform snippets.
- [Cold Starts](./docs/cold-starts.md) — keeping init time under AWS's budget, `x-telo-scope` patterns.

## Kinds at a glance

| Kind | What it does |
|---|---|
| `Lambda.Function` | Represents your AWS Lambda function. Required in every manifest. |
| `Lambda.HttpApi` | API Gateway HTTP API v2 trigger — routes, request matching, response rendering. |
| `Lambda.Sqs` | SQS queue trigger with partial-batch-failure support. |
| `Lambda.Direct` | Catch-all for synchronous invokes and event sources without a dedicated kind. |
