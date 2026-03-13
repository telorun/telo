# Telo Kernel

**Status:** Early prototype. The API surface — including YAML shapes — may change at any time without notice.

**Target:** Node.js (Rust/Go ports planned)

**Input:** A module manifest YAML file or a directory of YAML files

## 1. Core Concepts

The Telo Kernel is a **declarative execution host**. You describe resources in YAML; the kernel loads them, wires up controllers, and keeps the process alive until all work is done.

The kernel performs three functions:

- **Loader:** Reads YAML files, compiles them through the CEL-YAML templating engine, and resolves controller entrypoints.
- **Registry:** Indexes resource instances by a composite key of `module.Kind.name`.
- **Kernel:** Orchestrates the boot sequence, manages the event bus, and routes invocations.

**Module loading and resource discovery** happen during the load phase, before any resource is initialized.

## 3. CEL-YAML Templating

Before a manifest object is processed, it is compiled by the **CEL-YAML templating engine** (`@telorun/yaml-cel-templating`). This runs as part of loading — any compilation error halts the boot sequence immediately.

The compile step provides `{ env: process.env }` as the initial context, so environment variables are available everywhere:

```yaml
resources:
  - ${{ env.MY_MANIFEST_PATH }}
```

### 3.2 Interpolation

String values support two equivalent syntaxes:

- `${{ expr }}` — primary syntax used throughout Telo

When the entire string is a single interpolation, the result preserves the CEL type (integer, boolean, etc.). Mixed strings are coerced to string.

**See [../yaml-cel-templating/README.md](../yaml-cel-templating/README.md) for full directive reference.**

## 4. Boot Sequence

### 4.1 Overview

````

loadFromConfig(path)
└── loadBuiltinDefinitions() # register Kernel.Definition + Kernel.Module controllers
└── loader.loadManifest(path) # yaml.loadAll → compile() → queue

start()
├── register() # call register() on all known controllers
├── initializeResources() # multi-pass create + init loop (max 10 passes)
├── emit Kernel.Initialized
├── emit Kernel.Starting
├── runInstances() # call run() on all instances
├── emit Kernel.Started
├── waitForIdle() # block until hold count reaches 0
└── [finally]
├── emit Kernel.Stopping
├── teardownResources() # call teardown() on all instances
└── emit Kernel.Stopped

```

### 4.2 Step 1 — Load

`loadFromConfig(path)` first registers two built-in controllers:

- `Kernel.Definition` — handles resource type definitions that load and register controllers dynamically.
- `Kernel.Module` — handles module manifests that import other modules and resources.

It then calls `loader.loadManifest(path)`, which:

1. Reads the file and parses all YAML documents with `yaml.loadAll()`.
2. Passes each raw document through `compile(doc, { context: { env } })` from `@telorun/yaml-cel-templating`. All directives (`$let`, `$if`, `$for`, etc.) are evaluated and all interpolations are resolved. **Any compilation error halts boot immediately.**
3. Places the compiled manifests into the initialization queue.

`loadDirectory(dir)` works the same way but walks the directory for `*.yaml` / `*.yml` files, additionally running template expansion for `TemplateDefinition` resources (see [Section 8](#8-built-in-templatedefinition)).

### 4.3 Step 2 — Register

Before initializing any resource, `start()` calls `register(ctx)` on every controller that has been registered so far. Controllers use this hook to subscribe to events or perform one-time setup.

### 4.4 Step 3 — Multi-Pass Initialization (max 10 passes)

Resources may depend on other resources being initialized first (e.g. `Kernel.Module` registers new kinds, which other resources need). The kernel resolves this with a multi-pass loop:

```

unhandled = all resources in initialization queue
pass = 1

while pass <= 10 and unhandled is not empty:
handledThisPass = []

for each resource in unhandled:
controller = lookup controller for resource.kind
if not found: skip (try next pass)

    validate resource against controller.schema   # FAIL on error
    instance = controller.create(resource, ctx)   # FAIL on error
    if instance:
      instance.init(ctx)                          # FAIL on error (if defined)
      store instance in registry
      mark resource as handled

remove handled resources from unhandled
if nothing was handled this pass: break
pass++

if unhandled is not empty: FAIL boot with list of unresolved resources

```

**Key invariants:**

- Schema validation runs before `create()` — a resource with an invalid shape never reaches its controller.
- Each resource is created and initialized exactly once.
- `init()` is called immediately after `create()`, before the next resource in the same pass.
- If any step throws, boot halts immediately with context.

### 4.4.1 Resource Lifecycle Architecture

The Kernel uses a centralized **`InstanceFactory`** pattern to manage resource creation. Instead of passing a factory function per-call, the Kernel injects its `_createInstance` method into the `ModuleContextRegistry` at construction. Every `ModuleContext` receives this factory and uses it uniformly across all initialization passes:

**Benefits:**

- The `ResourceInstantiator` type is removed from the public API (used only internally by `_createInstance`).
- Eliminates duplicated initialization logic — the Kernel no longer maintains a separate `initializationQueue` and private loop.
- Every context type (`ModuleContext`, `ExecutionContext`, child contexts spawned via `spawnChildContext()`) uses the same resource lifecycle pattern.

For the complete architecture and design philosophy, see [evaluation-context.md](evaluation-context.md#5-resource-instantiation-architecture).

### 4.5 Step 4 — Run

After all resources are initialized, the kernel calls `run()` on every instance that defines it. `run()` is where long-lived work starts (HTTP listeners, queue consumers, etc.).

### 4.6 Event Order Example

```

Kernel.Initialized # all create()+init() done
Kernel.Starting # about to call run()
Kernel.Started # all run() called
Kernel.Blocked # first hold acquired
...
Kernel.Unblocked # last hold released
Kernel.Stopping
Kernel.Stopped

```

### 4.7 Error Scenarios

All of the following halt boot immediately:

1. **Compilation error** — CEL expression fails, assertion fails, or schema validation fails during the compile step.
2. **Schema validation error** — resource fields don't match the controller's declared schema.
3. **Creation failure** — `controller.create()` throws.
4. **Initialization failure** — `instance.init()` throws.
5. **Unhandled resource** — after 10 passes, a resource's kind has no controller.

## 7. Runtime Events

All events are namespaced as `Module.Event` or `Module.Kind.Name.Event`.

### 7.1 Kernel Lifecycle Events

| Event                | When                                      |
| -------------------- | ----------------------------------------- |
| `Kernel.Initialized` | All `create()` + `init()` calls completed |
| `Kernel.Starting`    | About to call `run()` on instances        |
| `Kernel.Started`     | All `run()` calls completed               |
| `Kernel.Blocked`     | Hold count went from 0 → 1                |
| `Kernel.Unblocked`   | Hold count returned to 0                  |
| `Kernel.Stopping`    | Teardown phase beginning                  |
| `Kernel.Stopped`     | Teardown complete; process will exit      |

### 7.2 Resource Events

Controllers can emit events via `ctx.emit(event, payload)`. If `event` contains no dot, the current kind is used as the namespace prefix automatically.

Teardown events are emitted by the kernel:

```

{module}.{Kind}.{name}.Teardown

````

### 7.3 Kernel Holds (Keepalive Leases)

The kernel exits when there is no more work to do. Modules and resources prevent exit by acquiring a **hold**:

```typescript
const release = ctx.acquireHold("http-server");
// ...later, on shutdown:
release();
```

- First hold acquired → `Kernel.Blocked` emitted.
- Last hold released → `Kernel.Unblocked` emitted; kernel proceeds to teardown.

### 7.4 Exit Codes

Controllers request a non-zero exit code via `ctx.requestExit(code)`. The kernel uses the highest requested code on exit.

### 9.2 Kernel.Definition Resource

Modules declare the resource kinds they handle using `Kernel.Definition`:

```yaml
kind: Kernel.Definition
metadata:
  name: Server # becomes Http.Server when module namespace is Http
  module: Http
capabilities: # required — one or more of: provider, listener, handler, executable, type, template, component
  - listener
  - provider
schema: # JSON Schema — validated against each resource before create()
  type: object
  properties:
    port: { type: integer }
    host: { type: string }
  required: [port]
controllers:
  # Ordered list of Package URL (PURL) candidates — first match for the current runtime is used
  - pkg:npm/@telorun/pipeline@>=1.0.0?local_path=./nodejs#job
  - pkg:cargo/telorun-pipeline@>=1.0.0?local_path=./rust#job
  - pkg:golang/github.com/telorun/pipeline@>=1.0.0?local_path=./go#job
```

When a `Kernel.Definition` instance initializes, it resolves and loads the controller module
and registers it with the kernel. For the full resolution algorithm (local path, host
node_modules, registry cache) and PURL format, see [controllers.md](controllers.md).

## 10. Error Codes

| Code                         | Meaning                                           |
| ---------------------------- | ------------------------------------------------- |
| `ERR_RESOURCE_NOT_FOUND`     | `invoke()` target does not exist                  |
| `ERR_RESOURCE_NOT_INVOKABLE` | Instance has no `invoke()` method                 |
| `ERR_MODULE_MISSING`         | Kind exists but no controller is registered       |
| `ERR_DUPLICATE_RESOURCE`     | Two resources share the same module/kind/name     |
| `ERR_EXECUTION_FAILED`       | Controller threw during execution                 |
| `ERR_CONTROLLER_INVALID`     | Controller exists but has no `create()` method    |
| `ERR_CONTROLLER_NOT_FOUND`   | After all passes, resource kind has no controller |
| `ERR_INVALID_VALUE`          | Schema validation failed on a value               |

## 11. Resource URIs

Every resource gets a `metadata.uri` assigned by the Loader:

- **File-based:** `file:///path/to/resources.yaml#Kind.name`
- **Template-generated:** `http://localhost/template/DefinitionName#Kind.name`
- **Nested template:** the fragment path grows with each generation level

Additional metadata fields set by the Loader:

```typescript
interface ResourceMetadata {
  name: string; // user-provided
  module: string; // which Kernel.Module owns this resource
  uri: string; // loader-assigned absolute URI
  generationDepth: number; // 0 = loaded from file; 1+ = template-generated
  source: string; // absolute path of the source file
  [key: string]: any;
}
```

## 12. Debugging and Observability

### 12.1 CLI Usage

```bash
telo [--verbose] [--debug] [--snapshot-on-exit] <module.yaml|directory>
```

| Flag        | Effect                                           |
| ----------- | ------------------------------------------------ |
| `--verbose` | Log all events to stdout                         |
| `--debug`   | Stream all events to `.digly-debug/events.jsonl` |

### 12.2 Event Streaming

When `--debug` is set, every event is written as a JSONL line to `.digly-debug/events.jsonl`:

```json
{ "timestamp": "2026-01-01T00:00:00.000Z", "event": "Kernel.Started", "payload": {} }
```

**Programmatic use:**

```typescript
const kernel = new Kernel();
await kernel.enableEventStream("./debug.jsonl");
// ...
const events = await kernel.getEventStream().readAll();
const started = await kernel.getEventStream().getEventsByType("Kernel.Started");
```

### 12.3 Custom Resource Snapshots

Resource instances can expose internal state for diagnostics by implementing `snapshot()`:

```typescript
const instance: ResourceInstance = {
  async init(ctx) {
    /* ... */
  },

  async snapshot() {
    return {
      activeConnections: this.connections.size,
      uptime: Date.now() - this.startTime,
    };
  },
};
```
