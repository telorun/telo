---
sidebar_label: AWS Lambda
slug: /deploy/lambda
description: Package a Telo manifest as an AWS Lambda function — the managed and custom runtime bootstraps, handler kinds per event source, and the packaging flow.
---

# Deploying to AWS Lambda

One manifest is one Lambda artifact. The manifest declares which AWS event
sources the function accepts and what each handler does; the `aws/lambda`
module owns the AWS-facing transport.

This is the deployment shape for event-driven, scale-to-zero workloads. For a
long-running service, use the [Docker image](/deploy/docker) instead.

```yaml
imports:
  Lambda: oci://ghcr.io/telorun/aws/lambda@0.9.1
```

The module is published from the [connectors
repository](https://github.com/telorun/connectors), so it versions on its own
cadence — check the [hub](https://hub.telo.run/?q=Lambda.Function) for the
current version and the full field reference of every kind below, and pin what
you deploy. This page covers packaging and the AWS-side wiring.

## One function, several event sources

`Lambda.Function` is the AWS-facing transport: it represents the function (one
ARN), classifies each incoming event by shape, and dispatches it to whichever
handler matches. Each handler kind carries the matcher, inputs and response
contract of its own source.

| Kind | Capability | Event source |
| --- | --- | --- |
| `Lambda.Function` | `Telo.Service` | The function itself — required in every Lambda manifest. |
| `Lambda.HttpApi` | `Telo.Invocable` | API Gateway HTTP API v2 — routes, request matching, `returns:`/`catches:` rendering, CORS. |
| `Lambda.Sqs` | `Telo.Invocable` | SQS queue trigger, with the standard `batchItemFailures` partial-batch envelope. |
| `Lambda.Direct` | `Telo.Invocable` | Synchronous SDK invokes, Step Functions tasks, EventBridge Scheduler — the catch-all. |
| `Lambda.Handler` | abstract | The contract every concrete handler kind extends. |

Because dispatch is by event shape, one artifact can serve all three at once —
bind API Gateway, the SQS event-source mapping and direct invokes to the same
ARN:

```yaml
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - !ref WebApi
  - !ref OrderProcessor
  - !ref AdminTools
```

A handler's `handler:` slot takes any `Telo.Invocable` or `Telo.Runnable`, so
the work itself is ordinary Telo — a `Run.Sequence`, a `JS.Script`, a `Crud`
resource — and is not Lambda-specific.

## Packaging

Two runtime models. The manifest is identical in both; what differs is which
bootstrap file you copy into the artifact root.

| AWS runtime | Bootstrap | When |
| --- | --- | --- |
| Managed Node (`nodejs20.x` / `nodejs24.x`) | `cp node_modules/@telorun/lambda/managed.mjs ./index.mjs`, then set the AWS handler to `index.handler` | Most cases. AWS owns the outer loop and calls the exported handler per invocation. |
| Custom (`provided.al2023`, container images) | `cp node_modules/@telorun/lambda/custom.mjs ./bootstrap && chmod +x ./bootstrap` | Containers, or anywhere you want control over the boot sequence. The function polls the AWS Runtime API itself. |

The full flow:

```bash
cd my-lambda
telo install ./telo.yaml                                  # bake controllers + imports into .telo/
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs   # managed-runtime bootstrap
zip -r function.zip telo.yaml index.mjs .telo node_modules
```

`telo install` is not optional here: it materializes every controller and every
imported manifest into `.telo/` beside the manifest, so a cold start performs no
network I/O. Ship that directory inside the artifact.

**The bootstrap looks for a `Lambda.Function` named `Main`.** That is the only
convention it hardcodes; if your function resource has a different name, copy
the bootstrap and edit the literal in it.

Test locally with the [AWS Lambda Runtime Interface Emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator)
against a synthetic event payload for the source you are wiring.

## Cold starts

The kernel boots once per execution environment, not once per invocation:
`load()` and `boot()` run in the bootstrap, and each invoke only dispatches. To
keep that boot inside AWS's init budget, defer expensive resources — a resource
declared inside an `x-telo-scope` block is constructed on first use rather than
at boot.

## Environment and secrets

Lambda environment variables bind exactly as anywhere else: declare
`variables:` / `secrets:` on the `Telo.Application` with an `env:` key, and set
them in the function configuration. Values resolve at load, so a missing
required one fails the init — visibly, at cold start, rather than at the first
request. See [Application environment variables](/reference/kernel/application-env-variables)
and [Security & supply chain](/deploy/security).

`ports:` has no meaning here — there is no inbound socket. API Gateway is the
listener.

## Worked examples

Runnable manifests, one per source:

- [`direct.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/direct.yaml) — `Lambda.Direct`, the minimal setup.
- [`http-api.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/http-api.yaml) — two routes, CORS, and a `catches:` block rendering a structured 400.
- [`sqs.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/sqs.yaml) — per-message retry reporting via `partialBatchResponse`.
- [`multi-kind.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/multi-kind.yaml) — all three sources on one artifact.

## See also

- [Deploy overview](/deploy) — choosing a deployment model.
- [Docker image](/deploy/docker) — the long-running alternative.
- [Running in production](/deploy/production) — signals, exit codes, health checks.
