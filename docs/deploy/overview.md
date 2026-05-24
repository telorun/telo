---
sidebar_label: Overview
slug: /deploy
description: How to deploy a Telo manifest — Docker image (recommended), AWS Lambda for serverless, or the bare telo CLI under a process supervisor.
---

# Deploy

A Telo manifest is a runnable artifact: anything that can execute `telo manifest.yaml` can host your application. Three deployment shapes cover the common cases.

## Pick a model

| Model | When it fits | How to package |
| --- | --- | --- |
| **Bare CLI** | VMs, bare metal, dev boxes, CI agents. `telo` invoked under systemd / pm2 / Docker Compose / your supervisor. | `npm install -g @telorun/cli`, then run `telo /path/to/manifest.yaml`. |
| **Docker image** | Long-running services (HTTP servers, workers, schedulers). Most workloads. | `FROM telorun/node:<ver>-slim` + your manifest. See [Docker image](/deploy/docker). |
| **AWS Lambda** | Event-driven serverless (HTTP, SQS, EventBridge). Scale-to-zero, per-invocation billing. | Lambda-specific bootstrap + zip or container image. See [AWS Lambda](/deploy/lambda). |

The default recommendation is **Docker**: hermetic, reproducible, portable across hosts, and the `telorun/node` image already ships the kernel — your Dockerfile only adds the manifest and its pre-installed controller cache.

## Shared prep

Every deployment model shares the same preparation steps:

1. **Author the manifest.** A `Telo.Application` with `targets:` listing what to run, declaring `variables:` / `secrets:` against host env vars — see [Application Environment Variables](/reference/kernel/application-env-variables).
2. **Warm the cache** with `telo install ./manifest.yaml`. Pre-downloads every controller and `Telo.Import` into `.telo/` next to the manifest, so the production host never touches the network at boot. Run this in your build pipeline, not at deploy time.
3. **Ship the manifest and its `.telo/` tree together.** They are co-located by design — `COPY` the manifest directory and both caches travel with it; no environment variable points at the cache.
4. **Configure runtime env** so the manifest's `variables:` and `secrets:` resolve at `kernel.load()`.

The pages that follow walk through each model.
