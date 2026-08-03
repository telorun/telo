---
sidebar_label: Getting Started
slug: /learn/getting-started
---

# Getting Started

Telo is a runtime for declarative backends. You describe what your system
should do in YAML, and Telo runs it — no imperative glue code.

This guide walks through installing Telo, running a minimal manifest, and
understanding what just happened.

## Install

Currently Telo kernel is written only in NodeJS (Rust version is planned next). Install it globally with npm or pnpm:

```bash
npm install -g @telorun/cli
# or
pnpm add -g @telorun/cli
```

The CLI installs as `telo`. Verify with:

```bash
telo --version
```

Prefer not to install globally? Run Telo via Docker:

```bash
docker run -v .:/srv -w /srv telorun/node:latest-slim ./manifest.yaml
```

## Your first manifest

Create `hello.yaml`:

```yaml
kind: Telo.Application
metadata:
  name: HelloConsole
  version: 1.0.0
imports:
  Console: oci://ghcr.io/telorun/console@<version>
targets:
  - invoke: !ref Console.writeLine
    inputs:
      output: "Hello from Telo!"
```

This declares:

- A **`Telo.Application`** — the runnable root, with `writeLine` as its target.
- One **`imports:` entry** — pulling in the `Console` module from the standard library.
- Inputs to the `Console.writeLine` target — a single string to print.

## Run it

```bash
telo ./hello.yaml
```

You should see:

```
Hello from Telo!
```

## What just happened

When you ran `telo ./hello.yaml`, the kernel:

1. **Loaded** the YAML, resolved each import, and compiled any
   `!cel "…"` / `${{ … }}` CEL expressions into an in-memory registry.
2. **Resolved** the resource dependency graph — `Main` references
   `Console.writeLine`, the singleton exported by the imported `Console` module.
3. **Initialized** each resource in dependency order, calling its
   controller's lifecycle hook.
4. **Dispatched** the `targets` declared on the Application — here,
   `Main` — and ran the sequence to completion.

Telo itself doesn't know what a console _is_. Each `kind:` is owned by a
controller module (loaded over npm at boot) that implements the resource's
lifecycle. The kernel just orchestrates loading, init order, references,
and dispatch.

## Add something runtime-shaped

A console one-shot is the simplest possible Telo manifest, but the runtime
really shines once you wire long-running services together.
[**Your first HTTP API**](/learn/first-http-api) is the next step: a server with
a validated route, a typed response, and configuration bound to the
environment — about fifteen minutes, and it covers every piece an ordinary Telo
application is made of.

## What's next

- [Standard library](/reference/standard-library) — the modules you import
  from: HTTP, SQL, AI, MCP, caching, scheduling, and the rest.
- [Kernel reference](/reference/kernel) — resources, capabilities, modules, and
  the CEL evaluation model.
- [Style guide](/guides/style-guide) — naming, structure, and CEL
  conventions.
- [CLI reference](/learn/installation-and-cli) — `telo run`, `telo check`,
  `telo install`, `telo upgrade`, `telo publish` (to OCI), and watch mode.
- [Catching errors before they run](/learn/static-analysis) — what `telo check`
  finds, and how to debug what it cannot.
