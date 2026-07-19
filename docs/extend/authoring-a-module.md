---
sidebar_label: Authoring a Module
slug: /extend/authoring-a-module
description: Add new resource kinds to Telo — declare a Telo.Definition, implement a controller, and wire them together so the kernel can run your kind.
---

# Authoring a module

Everything Telo runs is a resource of some *kind* — `Http.Server`, `Run.Sequence`, `Console.WriteLine`. A module adds new kinds to the runtime. Each kind has two halves:

1. **Declaration** — one `Telo.Definition` document per kind in the module's `telo.yaml`. It registers the kind, names its [capability](/reference/kernel/capabilities), points at a controller, and declares the typed input/output schemas.
2. **Implementation** — a *controller* package (Node.js, Rust, …) that exports a `create()` function returning an instance which implements the capability's method.

The kernel binds them: when a resource of your kind is initialized, it loads the controller named by the definition's PURL and calls `create()` to get the live instance.

This guide covers the controller-backed path. Two ways skip the controller entirely and build a kind in YAML: if your kind is a **composition of kinds that already exist**, see [Templated Definitions](/extend/templated-definitions); if it is **one existing kind, specialized** (a preconfigured client, a narrowed variant), `extends` that kind and map its config with `base:` — see [Kind Inheritance](/extend/kind-inheritance). Prefer either whenever it fits; reach for a controller when you need a runtime API the kernel doesn't expose.

This guide walks the smallest real example — `Console.WriteLine` — from declaration to a published, importable kind. For the field-by-field reference, see [Resource Definition](/reference/kernel/resource-definition).

## The module file

A reusable module is a `Telo.Library` (importable). Its first document declares identity and what it exports:

```yaml
kind: Telo.Library
metadata:
  name: console
  namespace: std
  version: 0.9.0
exports:
  resources:
    - writeLine
```

`metadata.name` becomes the kind prefix — definitions in this file are referenced as `Console.<Kind>` by importers. See [Module System](/reference/kernel/modules) for imports, aliases, and exports.

### Provenance

`metadata` also takes optional descriptive fields — `description`, `repository`, `license`, and `documentation`:

```yaml
metadata:
  name: console
  version: 0.9.0
  description: Write lines to stdout and read them back from stdin.
  repository: https://github.com/telorun/telo
  license: Apache-2.0
  documentation: https://telo.run/reference/std/console
```

These are purely descriptive. Nothing resolves, fetches, caches, or publishes by them — a module's location is its ref, never its metadata — so they are safe to change without affecting how anyone imports the module.

Publishing projects them into whatever the destination surfaces. An OCI publish maps them onto the standard `org.opencontainers.image.*` annotations (`repository` → `source`, `license` → `licenses`), which is what makes a published package show a description and link back to its source in registry UIs. An HTTP registry publish stores the manifest verbatim, so the fields are preserved as declared.

Note the field is `repository`, not `source`: inside the `imports` map, `source:` already means "where to fetch a dependency from", and reusing the word for "where this module is developed" in the same file would be ambiguous.

## Step 1 — declare the kind

Add a `Telo.Definition` document for the new kind:

```yaml
kind: Telo.Definition
metadata:
  name: WriteLine
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/console@0.8.0?local_path=./nodejs#writeline
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      output:
        type: string
        description: Text written to standard output.
    required: [output]
    additionalProperties: false
schema:
  type: object
  additionalProperties: false
```

- **`capability`** — the lifecycle role the kernel will drive (`Telo.Invocable` here). See the [capability list](/reference/kernel/capabilities).
- **`controllers`** — a [Package URL](/reference/kernel/controllers) locating the implementation. `local_path=./nodejs` resolves the package directory during development; `#writeline` selects the package export entry (Step 3). List one PURL per language to ship a polyglot kind.
- **`inputType` / `outputType`** — the typed contract the analyzer checks CEL against. `schema` validates the resource's own config fields. Both carry [`x-telo-*` annotations](/reference/kernel/resource-definition) (`x-telo-eval`, `x-telo-ref`, `x-telo-stream`, …) that the analyzer and editor resolve generically.

## Step 2 — implement the controller

A controller module exports `create()` (required) and optionally `register()`:

```ts
import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";

export function register(ctx: ControllerContext): void {}

interface WriteLineInputs {
  output: string;
}

class ConsoleWriteLine implements ResourceInstance<WriteLineInputs, string> {
  constructor(readonly ctx: ResourceContext) {}

  async invoke(inputs: WriteLineInputs): Promise<string> {
    this.ctx.stdout.write(String(inputs.output) + "\n");
    this.ctx.emit("LineWritten", { line: inputs.output });
    return inputs.output;
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ConsoleWriteLine> {
  return new ConsoleWriteLine(ctx);
}
```

- **`create(resource, ctx)`** runs once per resource. `resource` is the parsed manifest document; `ctx` is the [`ResourceContext`](/extend/sdk/nodejs) — the kernel surface (`ctx.stdout`, `ctx.emit(...)`, `ctx.args`, `ctx.invoke(...)`, cancellation, spans). Return the instance.
- **`register(ctx)`** runs once before any resource of the kind is created — use it for one-time setup; omit it if there's nothing to do.

> **Host environment.** A controller must not read host configuration from the ambient `process.env` — once the kernel boots it installs a guardrail over `process.env`, so a host-config key reads back `undefined` (with a warning) even when it is set. Read host configuration through `ctx.env` (the sanctioned snapshot the kernel threads in) or, preferably, declare it as a resource field the manifest fills from a typed `variables` / `secrets`. When spawning a child process, pass `ctx.env` as its environment rather than inheriting the guarded one. (Runtime conventions like `NODE_ENV` pass through unchanged, so libraries keep their prod/dev behavior.)

The instance implements the method that matches the declared capability:

| Capability | Implement | For |
|---|---|---|
| `Telo.Invocable` | `invoke(inputs, ctx?)` | request handlers, scripts |
| `Telo.Runnable` | `run(ctx?)` | one-shot tasks, pipelines |
| `Telo.Provider` | `init?()` + `provide()` | config / secret / value sources |
| `Telo.Service` | `init()` + `teardown?()` | long-lived servers, pools |
| `Telo.Mount` | mounted into a Service | HTTP APIs, middleware |

Any instance may also implement optional `init()`, `teardown()`, and `snapshot()` (the snapshot is what `resources.<name>` exposes in CEL).

## Step 3 — wire the package export

The PURL `#writeline` fragment maps to a `"./writeline"` key in the package's export map:

```json
{
  "name": "@telorun/console",
  "type": "module",
  "exports": {
    "./writeline": {
      "bun": "./src/writeline-controller.ts",
      "import": "./dist/writeline-controller.js"
    }
  },
  "peerDependencies": { "@telorun/sdk": "*" }
}
```

`@telorun/sdk` is a peer dependency — the kernel injects a single shared copy at load time so class identities (e.g. `Stream`) stay consistent across the kernel and every controller.

## Step 4 — export and consume

List the kind (and any ready-made singleton instances) in `exports`, then importers reference it across the module boundary:

```yaml
imports:
  Console: std/console@0.9.0
targets:
  - invoke: !ref Console.writeLine
    inputs:
      output: "Hello from Telo!"
```

Run it with `telo ./manifest.yaml` ([CLI](/learn/installation-and-cli)) and cover it with a [test manifest](/build/testing).

## Errors

Throw an `InvokeError` for domain failures that are part of your kind's contract, and declare its codes in the definition's `throws:` block. Plain `Error` throws are operational failures that propagate to the kernel. See [Node.js SDK → Errors](/extend/sdk/nodejs) for the full contract.

## Publish

`telo publish ./modules/<name>/telo.yaml --bump=minor` builds and publishes the controller packages, rewrites the PURL versions to exact pins, and pushes the manifest to the registry. See the [CLI reference](/learn/installation-and-cli).

## See also

- [Resource Definition](/reference/kernel/resource-definition) — every `Telo.Definition` field and `x-telo-*` annotation.
- [Capabilities](/reference/kernel/capabilities) — the lifecycle roles a kind can take.
- [Controllers](/reference/kernel/controllers) — PURL format, `local_path`, entry resolution, and the loader contract.
- [Node.js SDK](/extend/sdk/nodejs) · [Rust SDK](/extend/sdk/rust) — the per-language authoring surface.
