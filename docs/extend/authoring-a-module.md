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
  version: 0.9.0
exports:
  resources:
    - writeLine
```

`metadata.name` becomes the kind prefix — definitions in this file are referenced as `Console.<Kind>` by importers. See [Module System](/reference/kernel/modules) for imports, aliases, and exports.

### Provenance

`metadata` also takes optional descriptive fields — `description`, `repository`, `homepage`, `license`, and `documentation`:

```yaml
metadata:
  name: console
  version: 0.9.0
  description: Write lines to stdout and read them back from stdin.
  repository: https://github.com/telorun/telo
  homepage: https://telo.run/modules/console
  license: Apache-2.0
  documentation: https://hub.telo.run/?q=Console.WriteLine
```

These are purely descriptive. Nothing resolves, fetches, caches, or publishes by them — a module's location is its ref, never its metadata — so they are safe to change without affecting how anyone imports the module.

Because nothing in the kernel branches on them, a mistyped one has no failure mode that would ever surface it — so `telo check` validates the block instead: known fields are type-checked, and an unrecognized key is reported only when it is a near-miss of a known one (`licence:` → did you mean `license`). The vocabulary stays open, so a key of your own passes untouched.

There is no `authors` or `maintainers` field, deliberately. Registration is open and unauthenticated, so a self-declared author verifies nothing; the hub derives a **publisher** from the ref's host and organisation instead, because ownership is a property of the host that serves the module.

Publishing projects them into the destination's own metadata surface. An OCI publish maps them onto the standard `org.opencontainers.image.*` annotations (`repository` → `source`, `license` → `licenses`), which is what makes a published package show a description and link back to its source in registry UIs.

Note the field is `repository`, not `source`: inside the `imports` map, `source:` already means "where to fetch a dependency from", and reusing the word for "where this module is developed" in the same file would be ambiguous.

### Categories

`metadata.categories` says what your module is about. The hub groups its browse view by it, and the editor filters the "add resource" picker with it, so a reader who does not know your module exists can still land on it:

```yaml
metadata:
  name: cache-redis
  categories: [Performance, Storage]
```

Write them as you want them read — they are display labels, not identifiers. The hub derives the matching key itself (`AI` → `ai`), so casing and punctuation never split a group, and a filter URL stays clean (`?category=ai`) while the UI still prints `AI`.

The list is unordered — entries carry equal weight, and the module appears under each. The vocabulary is **open**: a category is any string, and whatever labels modules declare are the groups that exist. Nothing validates them against a list, because no such list is anyone's to own. Reuse the labels the standard library already uses (`AI`, `Compute`, `Configuration`, `Coordination`, `Data`, `Observability`, `Performance`, `Reliability`, `Scheduling`, `Storage`, `Streaming`, `Testing`, `Transport`) when one fits — a synonym still splits a group, which normalization cannot fix — and coin your own when none does.

A `Telo.Definition` / `Telo.Abstract` may declare its own `categories`, which **replace** its module's for that kind. Use it when a kind belongs somewhere other than the module around it (a retry helper inside a compute module), not to repeat what the module already says.

Categories are the *declared* grouping axis. The other one is derived and needs nothing from you: a kind's `extends` target identifies the contract it implements, so every backend of one abstract is discoverable together — see [Kind Inheritance](/extend/kind-inheritance).

### Deprecating a module or a kind

When something is superseded, say so where a machine can read it. `metadata.deprecated` takes a `reason` and an optional `replacedBy`, on a module doc or on any `Telo.Definition` / `Telo.Abstract`:

```yaml
kind: Telo.Definition
metadata:
  name: Migration
  description: A single standalone schema-migration script.
  deprecated:
    reason: Declare migrations inline in the keyed `migrations` map instead.
    replacedBy: Self.Migrations
```

The point is that a sentence buried in a description cannot be badged, linked, or warned about — nothing can tell "this kind mentions the word deprecated" from "this kind is deprecated". Declared, the hub badges it and links the replacement.

**`replacedBy` is resolvable, and its form follows the level.** On a kind, it is an alias-qualified kind — the same grammar `kind:`, `extends:` and `x-telo-ref` use — resolved through this file's own `imports:`: `Self.<Kind>` for a sibling, `<Alias>.<Kind>` for an imported one, `Telo.<Kind>` for a kernel built-in. On a module doc it is a **module ref**, addressed exactly as an `imports:` source would be. `telo check` reports a replacement that does not resolve, because one a reader cannot follow is no better than none.

`replacedBy` is optional: a module superseded by a kernel built-in has no module to point at, so the `reason` carries the instruction on its own.

A kind whose replacement lives in a module this one does not import cannot be named — there is no alias for it. Deprecate at module level with a module ref instead; adding a real dependency purely to name a replacement would be worse.

Deprecating is not removing. The kind keeps working exactly as before — this only tells readers what to write instead.

## Step 1 — declare the kind

Add a `Telo.Definition` document for the new kind:

```yaml
kind: Telo.Definition
metadata:
  name: WriteLine
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/console.mjs&local_path=./nodejs/src/index.ts#WritelineController
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
- **`controllers`** — a [Package URL](/reference/kernel/controllers) locating the implementation. `pkg:telo/local/js` means the controller **ships inside the module's own artifact** as a bundle: `path=` is the built `.mjs` a published module carries, and `local_path=` is the TypeScript source it was built from, which the kernel builds on demand while the module is a working copy (Step 3). List one PURL per format or platform to ship a polyglot kind.

  A module is **one bundle**, and `#WritelineController` names the export inside it that this kind's controller is. Every kind of a module therefore points at the same `path=` / `local_path=` and differs only in its fragment. That is what keeps a module's shared state one module scope: two bundles compiled from one source file are two scopes, and anything the module keeps beside its instances — a registry, a `WeakMap` — silently becomes two of them.
- **`inputType` / `outputType`** — the typed contract the analyzer checks CEL against. `schema` validates the resource's own config fields. Both carry [`x-telo-*` annotations](/reference/kernel/resource-definition) (`x-telo-eval`, `x-telo-ref`, `x-telo-type`, …) that the analyzer and editor resolve generically.

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

> **Reading an `x-telo-ref` slot.** The kernel injects the live instance into a ref field before `init()`, so `this.resource.store` is usually already the target. Read it with `ctx.resolveRef(this.resource.store, isMyContract, () => 'My.Kind "name": \'store\'', 'Cache.Store')` rather than a bare lookup: it duck-type-checks the target with your guard — so a mis-wired ref fails with a coded, actionable error naming the resource, the slot and the expected contract instead of `undefined is not a function` — and still resolves the slots injection doesn't reach. Type the field as `MyContract | KindRef<MyContract>`.

> **Host environment.** A controller must not read host configuration from the ambient `process.env` — once the kernel boots it installs a guardrail over `process.env`, so a host-config key reads back `undefined` (with a warning) even when it is set. Read host configuration through `ctx.env` (the sanctioned snapshot the kernel threads in) or, preferably, declare it as a resource field the manifest fills from a typed `variables` / `secrets`. When spawning a child process, pass `ctx.env` as its environment rather than inheriting the guarded one. (Runtime conventions like `NODE_ENV` pass through unchanged, so libraries keep their prod/dev behavior.)

The instance implements the method that matches the declared capability:

| Capability | Implement | For |
|---|---|---|
| `Telo.Invocable` | `invoke(inputs, ctx?)` | request handlers, scripts |
| `Telo.Runnable` | `run(ctx?)` | one-shot tasks, pipelines |
| `Telo.Provider` | `init?()` + `provide()` | config / secret / value sources |
| `Telo.Service` | `init()` + `run()` | long-lived servers, pools |
| `Telo.Mount` | mounted into a Service | HTTP APIs, middleware |

Any instance may also implement optional `init()` and `snapshot()` (the snapshot is what `resources.<name>` exposes in CEL). Cleanup is not a method — `init()` and `run()` return it (see below).

### Undoing what you allocate

**There is no `teardown()`.** `init()` and `run()` *return* the effects they
perform, and the runtime undoes them:

```ts
init(ctx) {
  return ctx.effect("connection pool", async () => {
    const pool = await openPool(resource.url);
    return { result: pool, inverse: () => pool.end() };
  });
}
```

Each `.effect(...)` extends the chain, and receives the previous step's result —
which is how an inverse gets the handle it has to close, without a field existing
only to carry it between two methods:

```ts
run(ctx) {
  return ctx
    .effect("kernel hold", async () => ({ result: undefined, inverse: ctx.acquireHold() }))
    .effect("listening", async () => {
      const socket = await listen(this.port);
      return { result: socket, inverse: () => socket.close() };
    });
}
```

The chain is **lazy** — nothing runs until the runtime executes it — and it is a
plain value, so branches and loops build it like any other:

```ts
let chain = ctx.effect("core", …);
if (resource.cors) chain = chain.effect("cors", …);
for (const mount of mounts) chain = chain.effect(`mount ${mount.path}`, …);
return chain;
```

Inverses run last-in-first-out when the resource unwinds — a failed `init()`, a
failed `run()`, a teardown. Three consequences worth knowing:

- **A failed `init()` recovers and the instance is discarded**, so the multi-pass
  loop's next attempt builds a fresh one. Write `init()` as if it runs once; it
  does. (Bookkeeping to make a second `init()` call safe is no longer needed.)
- **A subclass extends its parent's chain** (`super.init(ctx).effect(…)`), and
  unwinding is the reverse of construction automatically.
- **`acquireHold()` is an effect**, so a hold you forget to release is reclaimed
  when the resource unwinds instead of keeping the process alive.

Use the generator form when one step allocates several things — each `yield`
registers that allocation's inverse the moment it completed:

```ts
ctx.effect("plugins", async function* () {
  for (const plugin of plugins) {
    await register(plugin);
    yield () => plugin.dispose();
  }
});
```

For an allocation whose lifetime is one *operation* rather than the resource (a
hold taken per run of a workflow, inside `invoke()`), execute the chain in place
and dispose it when the operation ends:

```ts
const { dispose } = await ctx.effect("run hold", …).perform();
try { … } finally { await dispose(); }
```

Disposal is idempotent and unordered. Full contract:
`kernel/specs/revertible-effects.md`.

## Step 3 — wire the build

The controller ships as a bundle inside the module artifact, so the `nodejs/`
package is **private and never published**. It exists for two reasons only: to
declare the dependencies esbuild inlines, and to type-check the sources, which
esbuild does not do.

The module's entry point re-exports one namespace per kind, which is what the PURL
fragments select:

```ts
// nodejs/src/index.ts
export * as WritelineController from "./writeline-controller.js";
export * as ReadlineController from "./readline-controller.js";
```

```json
{
  "name": "@telorun/console-build",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.lib.json"
  },
  "devDependencies": { "@telorun/sdk": "workspace:*" }
}
```

The `build` script only **type-checks**. The kernel builds the bundle itself — on
the run path from `local_path`, and on the publish path through the same builder —
so the bytes a contributor runs are the bytes that ship, with no staged artifact
to go stale.

`@telorun/sdk` stays **external** rather than inlined: the bundle ships with no
`node_modules`, so the kernel symlinks the SDK to its own copy beside the bundle
at load time. That collapses identity as well as resolution, keeping `Stream` /
`InvokeError` `instanceof` checks true across the kernel/controller boundary.
Authors write a plain `import { … } from "@telorun/sdk"`.

**A library another module owns is external too.** If your controller imports a
module you declare in `imports:`, that module's own `exports.code:` entry says
which bare specifier it is imported by, and the kernel resolves the import to *its*
entry point rather than copying its source into your bundle — so the library runs
as one module scope across every consumer. Declaring it on the library side, once,
beside the kinds it already exports:

```yaml
# the library's telo.yaml
exports:
  kinds:
    - Store
  code:
    - specifier: "@telorun/kv-store"
      format: js
      path: ./nodejs/kv-store.mjs
      source: ./nodejs/src/index.ts
```

Only module-owned libraries work this way — `kysely` or `pg` have no module
artifact to resolve against and are inlined as before. Reaching a sibling's sources
by another route (a relative path into its tree, one of its subpaths) is a build
error rather than a silent second copy.

**There is no build step during development.** `telo run` against a module on
disk builds the controller from its `local_path` source on first use and caches
it, so editing `src/*.ts` and re-running picks the edit up. The `build` script
exists so CI and `telo publish` can materialize what ships, and to type-check.

> **A dependency that resolves a file next to itself cannot be inlined.** If a
> package reads an asset relative to its own module URL — `${__dirname}/…`, or
> `import.meta.url` — the flattened bundle looks for that file beside the bundle
> instead, where it is not. Such a module keeps a `pkg:npm` candidate until it
> ships the asset in its own layer.

## Step 4 — export and consume

List the kind (and any ready-made singleton instances) in `exports`, then importers reference it across the module boundary:

```yaml
imports:
  Console: oci://ghcr.io/telorun/console@<version>
targets:
  - invoke: !ref Console.writeLine
    inputs:
      output: "Hello from Telo!"
```

Run it with `telo ./manifest.yaml` ([CLI](/learn/installation-and-cli)) and cover it with a [test manifest](/build/testing).

## Errors

Throw an `InvokeError` for domain failures that are part of your kind's contract, and declare its codes in the definition's `throws:` block. Plain `Error` throws are operational failures that propagate to the kernel. See [Node.js SDK → Errors](/extend/sdk/nodejs) for the full contract.

## Publish

`telo publish ./modules/<name>/telo.yaml oci://<host>/<repo> --bump=minor` partitions the module into layers — `telo.yaml` alone, one controller layer per selector, a `library` layer for the entry point dependents import, assets, and everything else — and pushes them as an OCI artifact to the target registry (e.g. `oci://ghcr.io/acme/telo-console`). Importers then reference it as `oci://<host>/<repo>@<version>`; nothing is fetched from npm at load. A controller's `path=` entry joins the payload automatically, so `files:` is only for what the manifest cannot otherwise name.

Publish refuses to ship changed bytes at an unchanged `metadata.version`: it compares each built layer's content digest against the one already published under that version. A bundle inlines its dependencies, so a fix in a shared library changes a module's bytes while touching no file the module owns — bumping the version is what makes that fix reach consumers.

To make the module discoverable, register its ref with the [hub](https://hub.telo.run). See the [CLI reference](/learn/installation-and-cli).

## See also

- [Resource Definition](/reference/kernel/resource-definition) — every `Telo.Definition` field and `x-telo-*` annotation.
- [Capabilities](/reference/kernel/capabilities) — the lifecycle roles a kind can take.
- [Controllers](/reference/kernel/controllers) — PURL format, `local_path`, entry resolution, and the loader contract.
- [Node.js SDK](/extend/sdk/nodejs) · [Rust SDK](/extend/sdk/rust) — the per-language authoring surface.
