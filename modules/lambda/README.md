# AWS Lambda

Run your Telo manifest as an AWS Lambda function. One manifest equals one Lambda artifact — the manifest declares which AWS event sources the Lambda accepts and what each handler does; Telo owns the AWS-facing transport.

## Why use this

- **One artifact, multiple sources** — a single `Lambda.Function` lists HTTP API, SQS, and direct handlers; Telo routes each event to the matching one.
- **Source-shaped handler kinds** — `Lambda.HttpApi`, `Lambda.Sqs`, and `Lambda.Direct` each carry the right matcher, inputs, and returns/catches contract for their source.
- **Two runtime models, one manifest** — managed Node.js (`nodejs24.x`) or custom (`provided.al2023` / containers); pick a model by which bootstrap file you copy.
- **Partial-batch SQS** — `Lambda.Sqs` emits the standard `batchItemFailures` envelope so retries scope to failed messages.
- **Cold-start friendly** — `x-telo-scope` lets you defer expensive resource init until the first request that needs it.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Lambda.Function` | Represents the AWS Lambda function (one ARN). Required in every manifest. |
| `Lambda.HttpApi` | API Gateway HTTP API v2 trigger — routes, matchers, returns/catches rendering, CORS. |
| `Lambda.Sqs` | SQS queue trigger with partial-batch-failure support. |
| `Lambda.Direct` | Catch-all for synchronous invokes (SDK, Step Functions, EventBridge Scheduler, internal RPC). |
| `Lambda.Handler` | Abstract dispatch contract every concrete handler kind extends. |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-lambda, version: 1.0.0 }
imports:
  Lambda: aws/lambda@1.0.1
  JS: std/javascript@0.5.0
targets: [ !ref Main ]
---
kind: JS.Script
metadata: { name: Worker }
code: |
  function main(input) {
    return { ok: true, received: input.payload };
  }
---
kind: Lambda.Direct
metadata: { name: AdminTools }
handler: { kind: JS.Script, name: Worker }
inputs:
  payload: "${{ event }}"
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.Direct, name: AdminTools }
```

## Reference

- [`Lambda.HttpApi`](docs/http-api.md) — routes, request matching, response rendering, CORS.
- [`Lambda.Sqs`](docs/sqs.md) — batch handling, partial-batch failures.
- [`Lambda.Direct`](docs/direct.md) — synchronous invokes, returns matching.
- [Deploying to AWS Lambda](docs/deploying.md) — packaging, both runtime models, SAM / CDK / Terraform snippets.
- [Cold Starts](docs/cold-starts.md) — keeping init time under AWS's budget, `x-telo-scope` patterns.

## Picking a Handler Kind

| Source | Use |
| --- | --- |
| HTTP request via API Gateway HTTP API v2 | `Lambda.HttpApi` |
| SQS message batch | `Lambda.Sqs` |
| Synchronous SDK invoke, Step Functions, EventBridge Scheduler, internal RPC | `Lambda.Direct` |

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
| --- | --- | --- |
| Managed Node (`nodejs24.x`) | `cp node_modules/@telorun/lambda/managed.mjs ./index.mjs` | Most cases. AWS owns the outer loop and calls your exported handler. |
| Custom (`provided.al2023` / container image) | `cp node_modules/@telorun/lambda/custom.mjs ./bootstrap` | Containers, SnapStart-incompatible runtimes, anywhere you want full control over the boot sequence. |

The same manifest runs under either model — Telo detects which one AWS is using and adapts. You only change which bootstrap you copy.

## Examples

Working manifests under [`examples/aws/lambda/`](https://github.com/telorun/telo/tree/main/examples/aws/lambda):

- [`direct.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/direct.yaml) — minimal `Lambda.Direct` setup.
- [`http-api.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/http-api.yaml) — two HTTP routes with CORS and structured error rendering.
- [`sqs.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/sqs.yaml) — SQS batch handling with per-message retry reporting.
- [`multi-kind.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/multi-kind.yaml) — one Lambda artifact serving all three event sources.
