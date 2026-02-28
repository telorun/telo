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

## 2. Resource Format

Every YAML document must have `kind` and `metadata.name`. All configuration lives at the top level — there is no `spec` wrapper.

```typescript
interface RuntimeResource {
  kind: string; // e.g. "Http.Server", "JavaScript.Script"
  metadata: {
    name: string; // unique within kind + module
    module: string; // which Kernel.Module declared this resource
    [key: string]: any; // custom labels or annotations
  };
  [key: string]: any; // kind-specific configuration fields
}
```

Multiple YAML documents can live in one file, separated by `---`.

## 3. CEL-YAML Templating

Before a manifest object is processed, it is compiled by the **CEL-YAML templating engine** (`@telorun/yaml-cel-templating`). This runs as part of loading — any compilation error halts the boot sequence immediately.

The compile step provides `{ env: process.env }` as the initial context, so environment variables are available everywhere:

```yaml
resources:
  - ${{ env.MY_MANIFEST_PATH }}
```

### 3.1 Directives

Directives are keys that start with `$`. They are evaluated in a fixed priority order within any YAML mapping:

| Directive                 | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `$schema`                 | Validate parent-scope data against a JSON Schema              |
| `$let`                    | Define variables scoped to the current object and descendants |
| `$assert` / `$msg`        | Fail with an error if a CEL condition is false                |
| `$if` / `$then` / `$else` | Conditional blocks                                            |
| `$for` / `$do`            | Iterate over a collection                                     |
| `$include` / `$with`      | Include an external YAML file _(not yet implemented)_         |

### 3.2 Interpolation

String values support two equivalent syntaxes:

- `${{ expr }}` — primary syntax used throughout Telo
- `${ expr }` — alternate shorthand

When the entire string is a single interpolation, the result preserves the CEL type (integer, boolean, etc.). Mixed strings are coerced to string.

**See [../yaml-cel-templating/README.md](../yaml-cel-templating/README.md) for full directive reference.**

## 4. Boot Sequence

### 4.1 Overview

```
loadFromConfig(path)
  └── loadBuiltinDefinitions()       # register Kernel.Definition + Kernel.Module controllers
  └── loader.loadManifest(path)      # yaml.loadAll → compile() → queue

start()
  ├── register()                     # call register() on all known controllers
  ├── initializeResources()          # multi-pass create + init loop (max 10 passes)
  ├── emit Kernel.Initialized
  ├── emit Kernel.Starting
  ├── runInstances()                 # call run() on all instances
  ├── emit Kernel.Started
  ├── waitForIdle()                  # block until hold count reaches 0
  └── [finally]
      ├── emit Kernel.Stopping
      ├── teardownResources()        # call teardown() on all instances
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

### 4.5 Step 4 — Run

After all resources are initialized, the kernel calls `run()` on every instance that defines it. `run()` is where long-lived work starts (HTTP listeners, queue consumers, etc.).

### 4.6 Event Order Example

```
Kernel.Initialized                            # all create()+init() done
Kernel.Starting                               # about to call run()
Kernel.Started                                # all run() called
Kernel.Blocked                                # first hold acquired
...
Kernel.Unblocked                              # last hold released
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

## 5. Controller Interface

A controller module exports some or all of:

```typescript
// Called once before any resource is initialized
export function register(ctx: ControllerContext): void | Promise<void>;

// Called once per resource of this kind; return null to skip instance tracking
export function create(
  resource: RuntimeResource,
  ctx: ResourceContext,
): ResourceInstance | null | Promise<ResourceInstance | null>;
```

The returned `ResourceInstance` may define any of:

```typescript
type ResourceInstance = {
  init?(ctx?: ResourceContext): void | Promise<void>;
  run?(): void | Promise<void>;
  invoke?(input: any): any | Promise<any>;
  teardown?(): void | Promise<void>;
  snapshot?(): Record<string, any> | Promise<Record<string, any>>;
};
```

Lifecycle order: `create()` → `init()` → `run()` → _(process alive)_ → `teardown()`.

### 5.1 ControllerContext

Passed to `register()`:

```typescript
interface ControllerContext {
  on(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void;
  once(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void;
  off(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void;
  emit(event: string, payload?: any): void;
  acquireHold(reason?: string): () => void;
  requestExit(code: number): void;
  evaluateCel(expression: string, context: Record<string, any>): unknown;
  expandValue(value: any, context: Record<string, any>): any;
}
```

### 5.2 ResourceContext

Passed to `create()` and `init()` — extends `ControllerContext` with resource-level operations:

```typescript
interface ResourceContext extends ControllerContext {
  // Intelo another resource
  invoke(kind: string, name: string, ...args: any[]): Promise<any>;

  // Query the registry
  getResources(kind: string): RuntimeResource[];
  getResourcesByName(kind: string, name: string): RuntimeResource | null;

  // Dynamically register resources during initialization (used by Kernel.Module)
  registerManifest(resource: any): void;
  registerController(moduleName: string, kindName: string, controller: any): Promise<void>;
  registerDefinition(definition: any): void;

  // Schema helpers
  validateSchema(value: any, schema: any): void;
  createSchemaValidator(schema: any): DataValidator;

  // Event helpers
  emitEvent(event: string, payload?: any): Promise<void>;
}
```

## 6. Invocation Model

Resources call each other through `ctx.invoke()`. The kernel routes the call to the named instance's `invoke()` method:

```typescript
// From inside a controller — same-module invocation:
const result = await ctx.invoke("Http.Server", "Example");

// Cross-module invocation — prefix the kind with the module name:
const result = await ctx.invoke("OtherModule.Http.Server", "Example");
```

If the target instance doesn't exist or has no `invoke()` method, a `RuntimeError` is thrown.

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
```

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

## 8. Built-in TemplateDefinition

`TemplateDefinition` is a built-in resource kind that generates concrete resources at load time using CEL-based control flow. Expansion happens inside `loadDirectory()` before the kernel sees any resources.

```yaml
kind: TemplateDefinition
metadata:
  name: ApiServer
schema:
  type: object
  properties:
    name: { type: string, default: "api" }
    port: { type: integer, default: 8080 }
    regions:
      type: array
      items: { type: string }
      default: ["us-east", "eu-west"]
  required: [name, port]
resources:
  - for: "region in regions"
    kind: Http.Server
    metadata:
      name: "${{ name }}-${{ region }}"
    port: ${{ port }}
    region: "${{ region }}"
```

The expansion loop runs up to 10 iterations to support templates that instantiate other templates.

**For full template documentation see [../yaml-cel-templating/README.md](../yaml-cel-templating/README.md).**

## 9. Module System

### 9.1 Kernel.Module Resource

A `Kernel.Module` resource declares a module's imports and resource files:

```yaml
kind: Kernel.Module
metadata:
  name: MyApp # module namespace — propagated as metadata.module on all owned resources
  version: 1.0.0
imports: # directories to load as sub-modules (via loadDirectory)
  - ./my-module
  - ../../shared/http-module
definitions: # definition YAML files (Kernel.Definition resources)
  - definitions/my-type.yaml
resources: # resource YAML files
  - resources/config.yaml
  - resources/routes.yaml
```

`imports` are resolved with `loader.loadDirectory()` (walks for YAML files, expands templates). `definitions` and `resources` are resolved with `loader.loadManifest()` (compiles through yaml-cel-templating).

The `Kernel.Module` controller itself returns `null` from `create()` — it has no runtime instance, only load-time side effects.

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
node_modules, registry cache) and PURL format, see [CONTROLLERS.md](CONTROLLERS.md).

### 9.3 Module Loading Flow

```
Kernel.Module resource initialized
  ├── imports:     loadDirectory(path) for each import path
  ├── definitions: loadManifest(path) for each definition file
  └── resources:   loadManifest(path) for each resource file
```

All resulting resources are pushed into the initialization queue and picked up in subsequent passes of the multi-pass loop.

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

| Flag                 | Effect                                           |
| -------------------- | ------------------------------------------------ |
| `--verbose`          | Log all events to stdout                         |
| `--debug`            | Stream all events to `.digly-debug/events.jsonl` |
| `--snapshot-on-exit` | _(reserved; not yet implemented)_                |

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

## 13. Implementer Summary

- **Resource key:** `module.Kind.name` — all three parts are required.
- **Schema-agnostic kernel:** The kernel validates resources against the controller's declared schema but does not interpret field semantics.
- **Multi-pass initialization:** Up to 10 passes allow modules that register new kinds to be processed before resources of those kinds.
- **Invocation, not URN dispatch:** Resources call each other via `ctx.invoke(kind, name, ...args)`, not via URN strings.
- **Hold-based keepalive:** The process exits when all holds are released. Long-lived resources must acquire a hold in `init()` or `run()` and release it in `teardown()`.
- **CEL-YAML compile step:** Every YAML document is fully compiled before it reaches the kernel. Controllers receive clean, resolved objects — no `$`-directives remain at runtime.
