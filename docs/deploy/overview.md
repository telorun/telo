---
sidebar_label: Overview
slug: /deploy
description: How to deploy a Telo manifest — Docker image (recommended), a standalone packaged binary, AWS Lambda for serverless, or the bare telo CLI under a process supervisor.
---

# Deploy

A Telo manifest is a runnable artifact: anything that can execute `telo manifest.yaml` can host your application. Four deployment shapes cover the common cases.

## Pick a model

| Model | When it fits | How to package |
| --- | --- | --- |
| **Bare CLI** | VMs, bare metal, dev boxes, CI agents. `telo` invoked under systemd / pm2 / Docker Compose / your supervisor. | `npm install -g @telorun/cli`, then run `telo /path/to/manifest.yaml`. |
| **Docker image** | Long-running services (HTTP servers, workers, schedulers). Most workloads. | `FROM telorun/node:<ver>-slim` + your manifest. See [Docker image](/deploy/docker). |
| **Standalone binary** | A machine with nothing installed, a single file to copy, or an image without Node. | `telo package`; see [Packaging an application](/learn/packaging-an-app). |
| **AWS Lambda** | Event-driven serverless (HTTP, SQS, EventBridge). Scale-to-zero, per-invocation billing. | Lambda-specific bootstrap + zip or container image. See [AWS Lambda](/deploy/lambda). |

The default recommendation is **Docker**: hermetic, reproducible, portable across hosts, and the `telorun/node` image already ships the kernel — your Dockerfile only adds the manifest and its pre-installed controller cache.

**Which kernel runs.** The `telorun/node` image, the npm CLI and the standalone binary all run the Node kernel. The Rust kernel (`kernel/rust`, with its own `telo` binary in `cli/rust`) is deliberately narrow — it hosts `Telo.Invocable` kinds only, and no need types — and is not a production path today.

**Which Kubernetes path.** Deploy an application to Kubernetes as an ordinary workload you write yourself — a `Deployment`, or a `StatefulSet` when it keeps state — around the image from this page; [Running in production](/deploy/production#kubernetes) has the manifest. `apps/k8s-runner` and its Helm chart are something else: a service that runs *sandboxed editor and cloud sessions*, creating a pod and a volume per session for the studio. It is not how you deploy your own application.

## Shared prep

Every deployment model shares the same preparation steps:

1. **Author the manifest.** A `Telo.Application` with `targets:` listing what to run, declaring `variables:` / `secrets:` against host env vars — see [Application Environment Variables](/reference/kernel/application-env-variables).
2. **Warm the cache** with `telo install ./manifest.yaml`. Pre-downloads every controller and every imported module into the `.telo/` cache root, so the production host never touches the network at boot. Run this in your build pipeline, not at deploy time.
3. **Ship the manifest and its `.telo/` tree together.** The root is `.telo/` beside the manifest — or, when a `telo-workspace.yaml` sits above it, beside that marker instead, so a monorepo has one cache. Copy whichever directory holds it, or pin the location with `TELO_CACHE_DIR`. See [where the cache lands](/deploy/docker#where-the-cache-lands).
4. **Provide needs.** Run `telo needs report ./manifest.yaml` — it boots nothing — and give every need it lists to the host: a `Telo.DurableDirectory` a volume (or one `TELO_HOST_STATE_DIR`), a `Telo.PublicUrl` an address (or the two URL templates), every other need its `TELO_NEED_…` variables. An application with a required need nothing supplies fails at load with `ERR_NEED_UNMET`, naming the variables. See [Providing needs](/learn/providing-needs).
5. **Configure runtime env** so the manifest's `variables:` and `secrets:` resolve at load, and start with `--no-input` so a missing value is a refusal, not a prompt. Every variable the runtime itself reads is in [Environment variables](/reference/environment-variables).

The pages that follow walk through each model. Three of them apply whichever you pick:

- [**Running in production**](/deploy/production) — how the process starts and stops, what it exits with, how to probe it, run it unprivileged, keep state, and watch it.
- [**Upgrades & version skew**](/deploy/upgrades) — moving module pins and the kernel image without stranding one behind the other.
- [**Security & supply chain**](/deploy/security) — what a module can reach on your host, how import pins are verified end to end, and the licence terms for self-hosting.

## Licensing for self-hosting

You may self-host Telo to run your own commercial products and services. Offering Telo itself as a managed service needs a commercial licence; the terms are in [Licensing](/learn/licensing).

## Maturity

Telo is pre-1.0 and not yet recommended for production use. Breaking changes ship in minor releases, so pin your imports and expect to update manifests on upgrade — see [Upgrades & version skew](/deploy/upgrades).
