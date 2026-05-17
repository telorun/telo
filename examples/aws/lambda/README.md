# AWS Lambda examples

Working manifests for each of the Lambda handler kinds, plus one that combines
all three on a single AWS Lambda artifact. Every import pins a published
registry version so `telo install` resolves against the public registry without
any local workspace setup.

| Example | What it shows |
|---|---|
| [`direct.yaml`](./direct.yaml) | `Lambda.Direct` — synchronous SDK invokes, Step Functions tasks, EventBridge Scheduler events, or anything that needs a catch-all handler. |
| [`http-api.yaml`](./http-api.yaml) | `Lambda.HttpApi` — API Gateway HTTP API v2 trigger with two routes, CORS, and a `catches:` block that renders structured error responses. |
| [`sqs.yaml`](./sqs.yaml) | `Lambda.Sqs` — SQS queue trigger with per-message retry reporting via `partialBatchResponse`. |
| [`multi-kind.yaml`](./multi-kind.yaml) | One Lambda artifact, three event sources: API Gateway + SQS + direct invokes routed to the matching handler based on event shape. |

## Running locally

Each example is a complete `Telo.Application`. To package and run one:

```bash
cd examples/aws/lambda
telo install ./direct.yaml
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
# Then either zip + deploy, or run under the AWS Lambda Runtime Interface
# Emulator (RIE) for local testing.
```

See [Deploying](../../../modules/lambda/docs/deploying.md) for the full
packaging flow and AWS-side configuration.
