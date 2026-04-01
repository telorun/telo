# Claude

Use `pnpm run telo ./manifest.yaml` for testing.
Use `pnpm run test` to run the full test suite (runs all `tests/*.yaml` via bun).

Follow this strictly:

- never build anything.
- never add underscores to unused function arguments.
- never look at commit history.
- never stash changes to investigate anything.
- never fix linting problems.
- never implement logic that swallows errors
- kernel MUST be type safe
- never use `cat` nor `sed` to read files - read them directly.

## Architecture

Telo is a declarative runtime: YAML manifests describe desired state, the kernel resolves resource dependencies via a multi-pass init loop, and controllers implement each resource kind. CEL expressions in `${{ }}` are compiled before execution.

## Monorepo Structure

| Path                          | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `kernel/nodejs/src/`          | Core runtime — orchestration, loading, controllers, init loop            |
| `cli/nodejs/`                 | CLI wrapper around kernel (`bin/telo.mjs`)                               |
| `sdk/nodejs/src/`             | Public API for building modules (contexts, capabilities, types)          |
| `modules/`                    | Standard library — HTTP, SQL, Flow, scripting, config, etc.              |
| `yaml-cel-templating/nodejs/` | CEL + YAML directive engine (`$let`, `$if`, `$for`, `$eval`, `$include`) |
| `analyzer/nodejs/`            | Static manifest validator (schema checks, alias resolution)              |
| `apps/telo-editor/`           | Desktop editor — Next.js + Tauri                                         |
| `ide/vscode/`                 | VS Code extension — YAML diagnostics via analyzer                        |
| `tests/`                      | Integration tests (YAML manifests run via kernel)                        |
| `examples/`                   | Sample manifests                                                         |

## Kernel Internals (`kernel/nodejs/src/`)

| File                                      | Role                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `kernel.ts`                               | Main orchestrator — boot sequence, multi-pass init loop, event bus                    |
| `loader.ts`                               | YAML loading + CEL-YAML compilation; accepts `compileContext` param                   |
| `evaluation-context.ts`                   | `EvaluationContext`, `ModuleContext` — variable/secret/resource scoping               |
| `resource-context.ts`                     | Bridge methods: `getModuleContext()`, `registerModuleImport()`                        |
| `module-context-registry.ts`              | Per-module store for variables, secrets, resources, imports                           |
| `controller-registry.ts`                  | Maps resource kinds to controller implementations                                     |
| `controllers/module/module-controller.ts` | Handles `kind: Kernel.Module` (includes, module scope)                                |
| `controllers/module/import-controller.ts` | Handles `kind: Kernel.Import` (external modules, export CEL eval)                     |
| `controllers/resource-definition/`        | Handles `kind: Kernel.Definition` and parameterized templates                         |
| `capabilities/`                           | Base interfaces: `runnable`, `invokable`, `listener`, `provider`, `template`, `mount` |
| `event-stream.ts`                         | Event bus                                                                             |
| `manifest-schemas.ts`                     | JSON Schema for YAML validation                                                       |

## Modules (`modules/<name>/`)

Each module owns specific resource kinds. Structure: `module.yaml` (module def with `kind: Kernel.Module` + inline `kind: Kernel.Definition` docs), `src/` (TS controllers).

Key modules: `http-server`, `http-client`, `sql`, `javascript`, `config`, `run`, `assert`, `console`.

## SDK vs Kernel

- **Kernel** (`kernel/nodejs/src/`) — internal runtime, not for external consumption
- **SDK** (`sdk/nodejs/src/`) — public surface for module authors; re-exports contexts and capability interfaces

---

## Kernel Resource Kinds

### `kind: Kernel.Module`

Declares a module's identity, inputs, and targets. Every module file must start with exactly one.

```yaml
kind: Kernel.Module
metadata:
  name: my-module # kebab-case; becomes the kind prefix (e.g. MyModule.*)
  namespace: std # optional grouping prefix (used for x-telo-ref resolution)
  version: "1.0.0"
lifecycle: shared # "shared" (default) | "isolated"
keepAlive: false # prevent kernel from exiting when idle (default false)
variables: # JSON Schema property map — passed in by importers
  port: { type: integer, default: 8080 }
secrets: # same shape; values are redacted in logs/events
  apiKey: { type: string }
targets: # run these after all resources init (format: "Kind.Name")
  - Console.MyLogger
exports:
  kinds: # which kinds importers may reference
    - Server
    - Api
```

Required by all modules, including those only providing `kind: Kernel.Definition` resources. Fields `variables`/`secrets` act as the public contract — importers must provide all keys without a `default`.

### `kind: Kernel.Import`

Loads an external module into the current scope under an alias.

```yaml
kind: Kernel.Import
metadata:
  name: Http # PascalCase alias — used as kind prefix: Http.Server
source: ../modules/http-server # relative path; resolved to module.yaml automatically
variables:
  port: "${{ variables.port }}" # pass values into the child module's variables
secrets:
  apiKey: "${{ secrets.apiKey }}"
```

- The import controller validates the target module statically before loading it.
- Required variables without defaults must be provided; extras are rejected.
- Creates a child `EvaluationContext` with isolated `variables`/`secrets`/`resources`.
- Child resources are **not** visible to the root scope — only `exports.kinds` can be referenced.
- After `init()`, stores `{ variables, secrets }` in the declaring module's `resources.<alias>` snapshot.

### `kind: Kernel.Definition`

Registers a new resource kind with a capability, JSON Schema, and controller implementation(s). Defined inline in a module's `module.yaml`.

```yaml
kind: Kernel.Definition
metadata:
  name: Server # kind suffix — full kind = "<module-name>.Server"
capability: Kernel.Service # one of the known capabilities (see below)
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server
schema:
  type: object
  properties:
    port: { type: integer, x-telo-eval: compile }
    mounts: { type: array, x-telo-eval: compile }
  required: [port, mounts]
```

`controllers` is a `pkg:npm` locator; `local_path` is a relative fallback for local development.

---

## Capabilities

Every `Kernel.Definition` declares exactly one `capability` that determines its runtime interface:

| Capability         | Runtime interface                               | Typical use                                                                    |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `Kernel.Service`   | `init(): Promise<void>` + optional `teardown()` | Long-lived servers, pools                                                      |
| `Kernel.Runnable`  | `run(): Promise<void>`                          | One-shot tasks, pipelines                                                      |
| `Kernel.Invocable` | `invoke(inputs): Promise<output>`               | Request handlers, scripts                                                      |
| `Kernel.Provider`  | `init(): Promise<void>`                         | Config/secret providers; all schema fields get implicit `x-telo-eval: compile` |
| `Kernel.Mount`     | (parent-defined)                                | HTTP APIs, middleware — mounted into a Service                                 |
| `Kernel.Type`      | (none)                                          | Pure schema definitions, no runtime instance                                   |

These map to `Kernel.Abstract` entries in `builtins.ts`. The kernel uses them in `x-telo-ref` validation and topological sort. `targets` in `Kernel.Module` must reference a `Kernel.Runnable` or `Kernel.Service`.

---

## x-telo-\* Schema Annotations

These are JSON Schema extensions recognized by the kernel and analyzer. They live inside a `Kernel.Definition`'s `schema` block.

### `x-telo-eval: "compile" | "runtime"`

Controls when `${{ }}` expressions inside a resource's field are evaluated.

```yaml
schema:
  properties:
    port: { type: integer, x-telo-eval: compile } # expanded at load time
    body: { type: string, x-telo-eval: runtime } # re-evaluated per invocation
```

- **compile** — Expanded in `loader.loadModule()` before `controller.create()`. The controller receives plain values. `Kernel.Provider` capability implies compile on all fields.
- **runtime** — The kernel wraps `invoke()` and re-evaluates the field on each call.
- Without this annotation, `${{ }}` strings are passed through as raw strings.

### `x-telo-ref: "namespace/module-name#TypeName" | "kernel#TypeName"`

Declares that a field must be a named reference (`{ kind, name }`) to a resource implementing the given capability or type.

```yaml
handler:
  x-telo-ref: "kernel#Invocable" # must point to an Invocable resource
  oneOf:
    - type: string
    - type: object
      properties:
        kind: { type: string }
```

- Validated in Phase 3 (reference validation): structural form, kind compatibility, resource existence, and scope visibility.
- At Phase 5 (init), the kernel replaces the reference object with the live `ResourceInstance`.
- Multiple refs via `anyOf` branches are all collected.
- Inline resource objects (no `name` key but have other keys) are extracted into first-class manifests during Phase 2 (normalization).

### `x-telo-scope: "/json/pointer" | ["/path1", "/path2"]`

Marks a field as an **execution scope** — resources declared inside it are initialized on-demand at runtime, not at boot.

```yaml
with:
  type: array
  x-telo-scope: "/steps" # resources inside `with` are visible to x-telo-ref slots at `steps`
```

- Scoped resources are excluded from the boot-time dependency DAG.
- The JSON Pointer(s) declare the visibility path: `x-telo-ref` slots inside that path may resolve to resources in this scope.
- The controller receives a `ScopeHandle` and calls `.run(fn)` to open the scope at runtime.

### `x-telo-schema-from: "refProp/$defs/Name"`

Derives a field's validation schema dynamically from the referenced resource's definition schema.

```yaml
options:
  type: object
  x-telo-schema-from: "backend/$defs/NodeOptions"
```

- `backend` is a sibling `x-telo-ref` property; the path after the first `/` is a JSON Pointer into the referenced kind's schema.
- An absolute path (starting with `/`) navigates from the root `x-telo-ref` field.
- Used for polymorphic config that depends on which kind is chosen.

### `x-telo-context: <JSON Schema>`

Annotates an `x-telo-ref` handler field with the CEL context schema available to expressions inside that handler. Used by the static analyzer to type-check `${{ }}` expressions.

```yaml
handler:
  x-telo-ref: "kernel#Invocable"
  x-telo-context:
    type: object
    properties:
      request:
        type: object
        properties:
          query: { type: object, additionalProperties: true }
          body: { type: object, additionalProperties: true }
          path: { type: string }
          method: { type: string }
```

- No runtime effect — purely for analyzer type inference.
- CEL expressions inside the handler's YAML are checked against this schema.

---

## CEL Templates (`${{ }}`)

String values in manifests may embed CEL expressions inside `${{ }}`. The `yaml-cel-templating` engine also provides YAML-level directives (object keys starting with `$`).

### Expression interpolation

```yaml
port: "${{ variables.port }}" # pure expression → typed value
greeting: "Hello ${{ variables.name }}!" # inline in string → string result
url: "${{ 'http://localhost:' + string(port) }}"
```

### CEL evaluation context

The variables available inside `${{ }}` depend on scope:

| Name                  | Available                 | Contents                                                         |
| --------------------- | ------------------------- | ---------------------------------------------------------------- |
| `variables`           | Always                    | Module's `variables` inputs                                      |
| `secrets`             | Always                    | Module's `secrets` inputs                                        |
| `resources.<name>`    | After `<name>.snapshot()` | Resource's snapshot fields                                       |
| `steps.<step>.result` | Inside Run.Sequence steps | Result of a previous step                                        |
| `request`             | Inside handler CEL        | HTTP request fields (query, body, params, headers, path, method) |

Root module gets `env: process.env` in compile context. Child modules (imported via `Kernel.Import`) do **not** get `env` — they are isolated from the host environment.

---

## Module File Pattern

```yaml
# module.yaml — starts with Kernel.Module, then inline Kernel.Definition docs
kind: Kernel.Module
metadata:
  name: my-module
  namespace: my-org
  version: "1.0.0"
variables:
  port: { type: integer, default: 8080 }
exports:
  kinds: [Server, Api]
---
kind: Kernel.Definition
metadata:
  name: Server
capability: Kernel.Service
controllers:
  - pkg:npm/@my-org/my-module@>=1.0.0?local_path=./nodejs#server
schema:
  type: object
  properties:
    port: { type: integer, x-telo-eval: compile }
  required: [port]
---
kind: Kernel.Definition
metadata:
  name: Api
capability: Kernel.Mount
controllers:
  - pkg:npm/@my-org/my-module@>=1.0.0?local_path=./nodejs#api
schema:
  type: object
  properties:
    routes:
      type: array
      items:
        type: object
        properties:
          handler:
            x-telo-ref: "kernel#Invocable"
```

```yaml
# manifest.yaml — consuming the module
kind: Kernel.Module
metadata:
  name: my-app
targets:
  - Run.Main
---
kind: Kernel.Import
metadata:
  name: MyModule
source: ../modules/my-module
variables:
  port: 9000
---
kind: MyModule.Server
metadata:
  name: server
port: "${{ variables.port }}"
```

---

## Where to Look

- **Runtime bug / init order issue** → `kernel.ts`, `loader.ts`
- **Module/import scoping** → `evaluation-context.ts`, `module-context-registry.ts`, `import-controller.ts`
- **New resource kind** → add `Kernel.Definition` in the module's `module.yaml`, controller in `src/`
- **CEL template syntax** → `yaml-cel-templating/nodejs/`
- **Schema validation errors** → `manifest-schemas.ts`, `analyzer/nodejs/`
- **x-telo-ref / scope / topology** → `analyzer/nodejs/src/reference-field-map.ts`, `dependency-graph.ts`, `validate-references.ts`
- **CEL type checking** → `analyzer/nodejs/src/validate-cel-context.ts`, `cel-environment.ts`
- **Test a manifest** → add to `tests/`, run `pnpm run test`

## Keep CLAUDE.md up to date

Every time when there is a significant architectural change sync it to this file to align it with the codebase.
