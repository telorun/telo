# Telo Kernel Resource References Specification

## Overview

Resource references are the mechanism by which one resource declares a dependency on another. References are a kernel-owned contract: the reference shape, kind constraints, and validation rules are all defined by the kernel. Module definition authors declare which kind a reference slot requires via `x-telo-ref` in a schema node; the kernel enforces it at startup.

---

## 1. Reference Value Shape

Every resource reference in a YAML manifest has the same structure:

```yaml
kind: Alias.KindName # alias-prefixed kind of the target resource
name: ResourceName # name of the target resource (metadata.name)
```

Both fields are required. The kind constraint is declared in the definition schema via `x-telo-ref`, not in the reference value itself — the constraint is kernel-enforced at startup, not structurally encoded in the YAML value.

`metadata.module` and import aliases remain plain strings — they are namespace identifiers, not resource references, and are outside of this contract.

---

## 2. The `x-telo-ref` Schema Keyword

`x-telo-ref` is a custom JSON Schema keyword that marks a field as a resource reference slot and declares the kind constraint. Its value uses the format `"<module-identity>#<TypeName>"`:

```yaml
x-telo-ref: "std/http-server#Server"   # fully-qualified: namespace/module-name#TypeName
x-telo-ref: "kernel#Invocable"         # kernel built-ins use "kernel" as their identity
```

**Why not the dot format.** Definition schemas are authored by module authors and must be alias-independent — they cannot assume anything about how the user has imported modules. The dot format used in manifests (`Http.Server`, `Kernel.Invocable`) is alias-prefixed and varies per manifest. Using the same format in `x-telo-ref` would be visually indistinguishable from an alias-dependent reference. The `#` separator makes it unambiguously a canonical, alias-free reference.

**Why `#` separates the module identity from the type name.** The module identity is a slash-separated path (`std/http-server`, `kernel`) that may contain multiple segments as namespaces are added. Using `/` for both the namespace separator and the module/type separator would make parsing ambiguous — the last segment could be either a type name or a module name segment depending on convention. `#` splits the string into exactly two parts with no ambiguity regardless of how deep the namespace path is. This mirrors the convention in JSON Schema `$ref` (`"other-schema.json#/definitions/Foo"`), where `#` separates the document identity from the location within it.

**Module identity.** The left side of `#` is always the fully-qualified module identity: `namespace/module-name`. Both segments come from the module's own `Kernel.Application` or `Kernel.Library` declaration (`metadata.namespace` and `metadata.name`). Every module must declare a namespace — short-form references using only the module name are not permitted. The kernel built-ins use `"kernel"` as their identity (no namespace segment). The kernel rejects any `x-telo-ref` value whose left side does not match a registered fully-qualified identity.

**How the lookup works.** When a module is loaded, the kernel registers its fully-qualified identity (`namespace/module-name`) alongside its canonical module name (`metadata.module`). The field map builder (Phase 1) stores `x-telo-ref` strings as-is — no identity resolution occurs at that point, because modules are still being loaded concurrently. Resolution is deferred to Phase 3, when all imports are guaranteed to be registered. At Phase 3, each `x-telo-ref` string is split on `#`, the left side is looked up in the identity table to get the canonical module name, and the `DefinitionRegistry` key is constructed as `canonicalModule.TypeName`:

```text
"std/http-server#Server"  →  module "std/http-server"  →  canonical "Http"   →  registry key "Http.Server"
"kernel#Invocable"        →  module "kernel"            →  canonical "Kernel" →  registry key "Kernel.Invocable"
```

AJV ignores unknown keywords in `strict: false` mode (already the project default), so schemas containing `x-telo-ref` are passed to AJV as-is — no materialization or resolver plugin is needed. The field map builder detects reference slots by checking for the presence of `x-telo-ref` in a schema node.

---

## 3. Using References in Definition Schemas

Any schema node with `x-telo-ref` marks a reference slot:

```yaml
# modules/http-server/http-server.yaml
kind: Kernel.Definition
metadata:
  name: Server
  module: Http
extends: Kernel.Service
schema:
  type: object
  properties:
    notFoundHandler:
      type: object
      properties:
        invoke:
          x-telo-ref: "kernel#Invocable" # any Kernel.Invocable resource
    middlewares:
      type: array
      items:
        x-telo-ref: "std/http-server#Middleware" # specifically Http.Middleware
    mounts:
      type: array
      items:
        type: object
        properties:
          path:
            type: string
          mount:
            x-telo-ref: "kernel#Service" # any Kernel.Service resource
```

```yaml
# modules/run/telo.yaml
schema:
  properties:
    steps:
      items:
        properties:
          invoke:
            x-telo-ref: "kernel#Invocable"
```

---

## 4. Kind-Level Narrowing

Referencing a concrete kind (`x-telo-ref: "std/http-server#Middleware"`) constrains a slot to a specific resource kind. All reference shapes are structurally identical — the constraint is enforced semantically in Phase 3 by resolving the value and comparing the alias-resolved kind.

For slots that accept multiple specific kinds, use `anyOf`. Place `x-telo-ref` inside each branch:

```yaml
handler:
  anyOf:
    - x-telo-ref: "std/http-server#Middleware"
    - x-telo-ref: "std/javascript#Script"
```

Phase 3 validates that the reference's resolved kind satisfies at least one branch (`anyOf` semantics: one or more branches may match). Do not use `oneOf` (exactly one match) or `allOf` (all branches must match) in reference slot positions — both are semantically incorrect for multi-kind slots and the kernel does not support them there.

---

## 5. Dependent Schema Typing

Two mechanisms handle schema references across definitions. Which to use depends on whether the target type is known statically at definition authoring time.

### Static cross-module references via `$ref` + `$id`

Every `Kernel.Definition` schema is automatically assigned an `$id` by the analyzer when the definition is loaded — derived from the module's canonical identity and the type name. Authors never declare `$id` manually. This makes all definition schemas addressable by standard JSON Schema `$ref`:

```yaml
kind: Kernel.Definition
metadata:
  name: Backend
  module: Temporal
extends: Workflow.Backend
schema:
  # $id: "std/temporal/Backend" — assigned automatically by the analyzer
  properties:
    namespace: { type: string }
  $defs:
    NodeOptions:
      type: object
      properties:
        scheduleToClose: { type: string }
        retryPolicy:
          type: object
          properties:
            maxAttempts: { type: integer }
```

`$defs` entries are type definitions, not instance properties — a `Temporal.Backend` resource instance only declares `namespace`. `NodeOptions` is exposed for consumers and never appears in instance data.

Any definition schema can reference types from another module using a standard `$ref`:

```yaml
$ref: "std/temporal/Backend#/$defs/NodeOptions"
$ref: "std/http-server/Server#/properties/headers"
```

The analyzer loads all definition schemas into AJV's schema store keyed by their implicit `$id`. Cross-module `$ref` resolution is handled by AJV directly.

### Open-set dependent typing via `x-telo-schema-from`

Static `$ref` requires the target type to be known at definition authoring time. This breaks when the schema must depend on which resource a field references at manifest authoring time — the set of valid kinds is open and extensible by third-party modules.

`x-telo-schema-from` is a custom JSON Schema keyword that resolves a field's schema dynamically by following a property path to the referenced resource's definition schema:

```yaml
kind: Kernel.Definition
metadata:
  name: Graph
  module: Workflow
schema:
  properties:
    backend:
      x-telo-ref: "std/workflow#Backend"
    nodes:
      type: array
      items:
        type: object
        properties:
          options:
            x-telo-schema-from: "backend/$defs/NodeOptions"
```

`backend/$defs/NodeOptions` is a path expression: `backend` names an `x-telo-ref` property, `/$defs/NodeOptions` is a JSON Pointer into the resolved kind's schema. When `backend` references a `Temporal.Backend` resource, `options` validates against `Temporal.Backend`'s `NodeOptions`. When it references a `Prefect.Backend` resource — defined in a third-party module written after `Workflow.Graph` — it validates against `Prefect.Backend`'s `NodeOptions` instead.

**Path scope:** the first segment is resolved relative to the schema location where `x-telo-schema-from` appears. A leading `/` makes the path absolute — resolved from the resource root. No leading `/` means relative — resolved from the nearest enclosing `properties` block (sibling).

Relative — `x-telo-ref` is a sibling property at the same schema level:

```yaml
nodes:
  type: array
  items:
    type: object
    properties:
      backend:
        x-telo-ref: "std/workflow#Backend"
      options:
        x-telo-schema-from: "backend/$defs/NodeOptions" # relative: sibling backend
```

Absolute — `x-telo-ref` is at the resource root:

```yaml
schema:
  properties:
    backend:
      x-telo-ref: "std/workflow#Backend"
    nodes:
      type: array
      items:
        type: object
        properties:
          options:
            x-telo-schema-from: "/backend/$defs/NodeOptions" # absolute: root backend
```

AJV ignores this keyword during its standard validation pass — the dependent schema check is an explicit Phase 3 step run by the analyzer after all references are resolved (see Section 9).

The abstract base kind acts as a nominal type tag — it constrains the `x-telo-ref` slot without declaring any schema contract:

```yaml
kind: Kernel.Definition
metadata:
  name: Backend
  module: Workflow
extends: Kernel.Provider
# no controllers — cannot be instantiated directly
```

Concrete backends extend it and declare their `$defs` slots independently. If a backend does not declare the expected `$defs` path, `x-telo-schema-from` resolution fails at validation time.

---

## 6. Inline Resources

A reference slot accepts two forms: a named reference or an inline resource definition.

**Named reference** — `kind` + `name` only:

```yaml
invoke:
  kind: JavaScript.Script
  name: MyHandler
```

**Inline definition** — `kind` + the resource's own config fields (no `name` required):

```yaml
invoke:
  kind: JavaScript.Script
  outputSchema:
    sum:
      type: number
  code: |
    function main({ a, b }) { return { sum: a + b } }
```

Inline resources are detected during the normalization phase (Phase 2) by the presence of keys beyond `kind`/`name`/`metadata`. They are extracted into first-class manifests with deterministic names and replaced in-place with a `{kind, name}` reference before Phase 3 runs. By the time Phase 3 begins, all inline resources are registered and indistinguishable from named resources.

### Naming scheme

Inline resource names are derived from the parent resource name and the field path, joined by underscores. Array items use the item's `name` field when available, otherwise the index:

```text
{parentName}_{pathSegment}[_{itemName|index}]_{fieldName}

TestBasicAddition_steps_AddTwoNumbers_invoke
TestBasicAddition_steps_0_invoke              # when step has no name
```

Names must satisfy `^[a-zA-Z_][a-zA-Z0-9_]*$`.

---

## 7. Scoped Resources

### Concept

Resources in Telo have one of two lifetimes. Most resources are **singleton-scoped**: initialized once at kernel boot and torn down when the kernel stops. But some resources are **execution-scoped**: they exist only for the duration of a single operation, initialized when the operation starts and torn down when it ends. Each invocation of the operation gets a fresh set.

The canonical use case is `Kernel.Runnable`: start an HTTP server inside the scope, run test steps against it, and have the server torn down automatically when the job completes — without keeping the process alive. The pattern is not exclusive to runnables; any resource kind can declare a scoped field under any name it chooses.

### Declaring a scoped field with `x-telo-scope`

A definition author marks a field as an execution scope using the `x-telo-scope` custom schema keyword. Its value is a JSON Pointer (RFC 6901) declaring where in the parent resource's config the scope is visible — all x-telo-ref resolutions within that path have access to the scoped resources. A scope visible in multiple paths uses an array.

**JSON Pointer visibility is a prefix match.** A ref slot is considered "within the scope" if its field path, expressed as a JSON Pointer, starts with the declared pointer. For example, `x-telo-scope: /steps` covers `/steps/0/invoke`, `/steps/1/handler`, and any deeper path under `/steps`. Both the analyzer (deciding which refs check the scope when resolving names) and Phase 5 (deciding which ref slots to skip at boot) use this same prefix rule. The field value is an array of resource manifests, including `Kernel.Import` entries:

```yaml
# Kernel.Runnable definition schema
kind: Kernel.Definition
metadata:
  name: Runnable
  module: Kernel
schema:
  type: object
  properties:
    with:
      x-telo-scope: /steps # resources in 'with' are visible to x-telo-ref fields within /steps
    steps:
      type: array
      items:
        type: object
        properties:
          invoke:
            x-telo-ref: "kernel#Invocable"
```

### Example

```yaml
kind: Run.Sequence
metadata:
  name: DataSync
  module: MyApp
steps:
  - name: Fetch
    invoke:
      kind: Http.Request
      name: FetchData # resolved against the 'with' scope
with:
  - kind: Kernel.Import
    metadata:
      name: Http
    source: std/http-client
  - kind: Http.Request
    metadata:
      name: FetchData
    url: "https://api.example.com/data"
```

### Runtime injection — `ScopeHandle`

`x-telo-scope` fields participate in Phase 5 injection alongside `x-telo-ref` fields. Rather than injecting a live resource instance, the kernel replaces the raw manifest array with a `ScopeHandle` — an object the controller calls to open the scope:

```typescript
export interface ScopeHandle {
  run<T>(fn: (scope: ScopeContext) => Promise<T>): Promise<T>;
}

export interface ScopeContext {
  /** Returns the initialized instance for the given name.
   *  Throws synchronously if the name was not declared in the scope —
   *  this is always a programming error; all scope members are statically
   *  validated in Phase 3 before the kernel ever reaches runtime. */
  getInstance(name: string): ResourceInstance;
}
```

`ScopeHandle.run()` initializes all declared resources in the scope, executes the callback with a `ScopeContext` giving access to those instances by name, then tears them down when the callback resolves or rejects. Each call to `run()` produces a fresh initialization. The controller decides when and how many times to open the scope — the kernel has no involvement in that decision:

```typescript
async run() {
  await this.config.with.run(async (scope) => {
    const fetcher = scope.getInstance("FetchData");
    await fetcher.invoke(inputs);
  });
}
```

`Injected<T>` transforms `x-telo-scope` fields from `ResourceManifest[]` to `ScopeHandle`, the same way it transforms `x-telo-ref` fields from `{kind, name}` to live instances. This pattern is not specific to `Kernel.Runnable` or `run()` — any resource kind that declares an `x-telo-scope` field receives a `ScopeHandle` and manages it as it sees fit.

### Lifetime

Scoped resources are initialized when `ScopeHandle.run()` is called and torn down when it returns. They are never pre-initialized at boot. Each call to `run()` gets a fresh initialization — resources do not carry state across calls.

Outer (singleton-scoped) resources are already initialized when a scope opens. Scoped resources may therefore hold `x-telo-ref` slots pointing to outer resources — injection works normally because the targets exist at scope initialization time. Outer resources cannot hold injected references to scoped resources — they are initialized at boot, before any scope exists.

References from the parent's config into the scope (such as `steps[].invoke`) are not injected at boot. The controller resolves them at runtime via `scope.getInstance(name)`.

### Static validation

`x-telo-scope` fields are excluded from AJV validation of the parent resource — the kernel strips them before schema validation, then validates their contents separately as a child manifest set:

- Each declaration in the scope is validated against its definition schema.
- `Kernel.Import` entries in the scope are resolved and their definitions registered for scope-local use.
- References between scoped resources are validated within the scope.
- References from scoped resources to outer resources are validated normally.
- References from a scoped resource to a resource declared in a **different** scope (a sibling scope belonging to another parent resource, or a scope at a different nesting level) are rejected. Each scope is self-contained with respect to other scopes; the only cross-boundary direction allowed is scoped → outer.
- For any x-telo-ref field within the JSON Pointer path declared by `x-telo-scope`, the analyzer includes the scope's resources when resolving references — if the referenced name is not found in the outer manifest set, the scope is checked before reporting an error.

---

## 8. Package Responsibilities

Reference injection spans two packages. The split follows a single rule: logic that does not require live `ResourceInstance` objects belongs in the analyzer.

### `@telorun/analyzer` (shared)

The analyzer owns all logic that both the kernel and IDE need:

| Export                                          | Used by                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| `buildReferenceFieldMap(schema)`                | Kernel (Phase 1), IDE (Section 10 field index) |
| `normalizeInlineResources(manifests, registry)` | Kernel (Phase 2)                               |
| `validateReferences(resources, context)`        | Kernel (Phase 3), IDE (diagnostics)            |
| `buildDependencyGraph(resources, registry)`     | Kernel (Phase 4), IDE (cycle warnings)         |

`buildReferenceFieldMap` detects both `x-telo-ref` nodes (reference slots) and `x-telo-scope` nodes (scope slots), recording them separately in the field map. The scope entry captures the JSON Pointer visibility path alongside the field path, so both the kernel (Phase 5) and the IDE know which fields carry scopes and where those scopes are visible.

`validateReferences` takes an `AnalysisContext` as its second parameter — the same type already used by `StaticAnalyzer.analyze()`, carrying both `AliasResolver` and `DefinitionRegistry`.

`buildDependencyGraph` takes a `DefinitionRegistry` and fetches each resource's field map from it by kind — the caller does not pre-compute or pass field maps separately.

`DefinitionRegistry` is extended in two ways:

1. `register(definition)` runs `buildReferenceFieldMap` and caches the field map alongside the definition — callers never re-traverse.
2. `getByExtends(abstractKind): ResourceDefinition[]` — returns all definitions that transitively extend the given abstract kind, following the `extends` chain to any depth (equivalent to `instanceof` in OOP). A definition `D` is included if `D.extends === abstractKind`, or if `D.extends` is itself a kind that extends `abstractKind` through any number of hops. The lookup walks the registered inheritance graph at query time. Used by Phase 3 abstract kind validation and the editor dropdown.

### `@telorun/sdk` — `KindRef<T>`, `Ref()`, `ScopeRef`, and `Scope()`

The SDK exports type markers and TypeBox builders for both reference slots and scope slots as separate named exports to avoid type/value collisions.

`Injected<T>` transforms the raw config shape into the controller's view — `KindRef<U>` fields become live instances and `ScopeRef` fields become `ScopeHandle` objects:

```typescript
// SDK
export interface KindRef<T extends ResourceInstance = ResourceInstance> {
  readonly kind: string;
  readonly name: string;
}

/** Marker type for x-telo-scope fields. Has no runtime value — used only
 *  as a discriminant for Injected<T> to transform the field to ScopeHandle. */
export interface ScopeRef {
  readonly __scope: true;
}

export type Injected<T> = {
  [K in keyof T]: T[K] extends KindRef<infer U>
    ? U
    : T[K] extends KindRef<infer U>[]
      ? U[]
      : T[K] extends ScopeRef
        ? ScopeHandle
        : T[K];
};
```

Raw TypeScript interface — author is responsible for keeping the exported `schema` consistent:

```typescript
interface MyConfig {
  invoke: KindRef<Invocable>;    // x-telo-ref: "kernel#Invocable"
  server: KindRef<HttpServer>;   // x-telo-ref: "std/http-server#Server"
  with:   ScopeRef;              // x-telo-scope: /steps
  port:   number;
}

async function create(config: Injected<MyConfig>, ctx: ResourceContext) {
  await config.invoke.invoke(payload); // Invocable
  config.server.listen();              // HttpServer
  await config.with.run(async (scope) => { ... }); // ScopeHandle
}
```

### TypeBox — `Ref()` and `Scope()` builders

`Ref()` emits the correct `x-telo-ref` JSON Schema keyword and the correct `KindRef<T>` TypeScript type from a single declaration. `Scope()` emits the `x-telo-scope` JSON Schema keyword with the JSON Pointer visibility path and the `ScopeRef` TypeScript type — both the schema keyword and the path are emitted from the same call:

```typescript
// SDK
export const Ref = <T extends ResourceInstance>(ref: string) =>
  Type.Unsafe<KindRef<T>>({ "x-telo-ref": ref });

export const Scope = (visibilityPath: string | string[]) =>
  Type.Unsafe<ScopeRef>({ "x-telo-scope": visibilityPath });
```

Usage:

```typescript
import { Type, Static } from "@sinclair/typebox";
import { Ref, Scope, KindRef, ScopeRef, Injected } from "@telorun/sdk";

const MyConfig = Type.Object({
  invoke: Ref<Invocable>("kernel#Invocable"),
  server: Ref<HttpServer>("std/http-server#Server"),
  with:   Scope("/steps"),
  port:   Type.Integer(),
});

async function create(config: Injected<Static<typeof MyConfig>>, ctx: ResourceContext) {
  await config.invoke.invoke(payload); // Invocable
  config.server.listen();              // HttpServer
  await config.with.run(async (scope) => { ... }); // ScopeHandle
}
```

The TypeBox schema object can be used directly as the `schema` field in a `Kernel.Definition`. **The exported `schema` is the source of truth for validation.** The TypeBox approach is recommended because it keeps the JSON Schema and TypeScript types in sync automatically.

### `kernel/nodejs` (kernel-only)

Phase 5 (injection) is kernel-only because it works with live `ResourceInstance` objects that do not exist in the analyzer's domain. The kernel uses the field map from `DefinitionRegistry` to locate both reference fields and scope fields in the resource config, then:

- Replaces each `{kind, name}` reference value with the resolved live instance.
- Replaces each scope field's manifest array with a `ScopeHandle` that the controller calls to open the scope at runtime.

Both replacements happen before `init()` is called.

---

## 9. Startup Phases

Reference injection is implemented across five sequential phases that span `loadFromConfig` and `start()`.

**Phases 1–2 happen during `loadFromConfig`**: Phase 1 during definition registration, Phase 2 after all manifests and definitions are loaded. **Phases 3–5 happen during `start()`**, before `initializeResources()` is called.

### Import loading is eager

`Kernel.Import` resources are resolved during `loadFromConfig`, not lazily during the init loop. Each import's child manifests — including their definitions — are loaded and registered before `start()` is called. `Kernel.Import` entries declared inside `x-telo-scope` fields are also resolved eagerly, so all definitions from all scopes are registered and known before Phase 3 validation runs. The scoped resources themselves are not initialized at load time — only their definitions are registered.

### Phase 1 — Field map construction

When a `Kernel.Definition` is registered during `loadFromConfig`, `buildReferenceFieldMap` traverses its schema once. It records two kinds of entries:

- A node containing `x-telo-ref` is a **reference slot**. All `x-telo-ref` values from `anyOf` branches are collected into `refs`.
- A node containing `x-telo-scope` is a **scope slot**. The JSON Pointer visibility path is recorded alongside the field path.

The field map is cached on the `DefinitionRegistry` entry:

```text
fieldPath       → { refs,                                                              isArray }
───────────────────────────────────────────────────────────────────────────────────────────────
invoke          → { refs: ["kernel#Invocable"],                                        false   }
middlewares[]   → { refs: ["std/http-server#Middleware"],                              true    }
mounts[].mount  → { refs: ["kernel#Service"],                                          true    }
server          → { refs: ["std/http-server#Server"],                                  false   }
handler         → { refs: ["std/http-server#Middleware", "std/javascript#Script"],     false   }
with            → { scope: "/steps" }
```

The `[]` suffix means the field is an array — the kernel iterates each element at injection time.

### Phase 2 — Inline resource normalization

After all manifests are loaded and all field maps are built, the kernel normalizes inline resources using a work queue. The queue is initialized with all top-level resources and all resources declared inside `x-telo-scope` fields. Resources are processed in order; newly extracted resources are appended to the queue and processed in the same pass. The queue is drained to empty — nested inline resources (an inline resource whose own ref slots contain further inline values) are handled automatically because each extracted resource is enqueued immediately.

For each resource dequeued, the kernel walks its ref slots in two passes based on the scope visibility path declared in the same field map:

**Pass A — slots outside all scope visibility paths:** For each ref slot value that has keys beyond `kind`/`name`/`metadata`, the kernel:

1. Assigns a deterministic name using the parent resource name and field path (underscores as separators; array items use the item's `name` field or index).
2. Extracts the value as a new manifest, stamping `metadata.name` and inheriting `metadata.module` from the parent.
3. Replaces the inline value in the parent config with `{kind, name}`.
4. Adds the extracted manifest to the global manifest set and enqueues it.

**Pass B — slots within a scope visibility path (prefix match):** Same extraction steps, but the extracted manifest is added to the parent resource's scope manifest array (the `x-telo-scope` field value) rather than the global set, and inherits `metadata.module` from the parent.

After Phase 2 completes, all reference slot values are `{kind, name}` pairs. Inline resources are indistinguishable from explicitly declared named resources in all subsequent phases.

### Phase 3 — Reference validation

After normalization and before any resource is initialized, the kernel validates every reference value against the field maps using `validateReferences`. Each `x-telo-ref` value is parsed directly.

For each reference field, the value must satisfy at least one `ref` entry in the field map (`anyOf` semantics). Per entry, validation dispatches on whether the target is a `Kernel.Abstract` or `Kernel.Definition`:

1. **Structural validation** — the reference object has both `kind` and `name` fields of type string.
2. **Kind validation** — dispatched per ref value:
   - `Kernel.Abstract` target → `registry.getByExtends(targetKind)` must include the referenced resource's definition.
   - `Kernel.Definition` target → the alias-resolved reference `kind` must equal the target's canonical kind.
3. **Scope validation** — uses the `AliasResolver` from `AnalysisContext`:
   - Scoped resources may reference outer (singleton-scoped) resources — outer resources are initialized before any scope opens.
   - Outer resources may not hold injected references to scoped resources — they are initialized at boot before any scope exists. References from the parent's config into a scope (within the JSON Pointer path declared by `x-telo-scope`) are validated for name and kind but are not injection-time dependencies.
   - Cross-module references without an explicit `Kernel.Import` are rejected at any scope level.
4. **Resolution validation** — a resource with the given `kind` and `name` exists in the visible manifest set.

Failures in any check halt boot immediately with a descriptive error identifying the field path, the reference value, and the violated constraint.

**`x-telo-schema-from` validation** runs as a final step in Phase 3, after all references are resolved. At this point the concrete kind of every referenced resource is known. For each resource whose definition schema contains one or more `x-telo-schema-from` fields, the analyzer:

1. Resolves the path's first segment to its `x-telo-ref` property value — already validated above, so the kind is known.
2. Looks up the resolved kind's definition schema in the registry.
3. Navigates the remainder of the path (a JSON Pointer) into that schema to obtain the target sub-schema.
4. Re-validates the field's value in the resource config against the resolved sub-schema using AJV.

AJV ignores `x-telo-schema-from` as an unknown keyword during the standard schema validation pass. The dependent schema check is a separate explicit validation step driven by the analyzer — not delegated to AJV's keyword processing. If the path does not resolve (the referenced definition has no `$defs` entry at the declared pointer), boot halts with an error identifying the backend kind and the missing path.

### Phase 4 — Dependency graph construction & cycle detection

The kernel builds a directed acyclic graph (DAG) via `buildDependencyGraph`. Each resource is a node; each reference value becomes a directed edge from the referencing resource to the referenced resource. Scoped resources are included as nodes; edges from scoped resources to outer resources are included. Parent → scoped resource edges are not boot-time dependencies and are excluded from the DAG.

If a topological sort of the DAG fails, a circular dependency exists. Boot halts with the full cycle path:

```text
Circular dependency detected:
  Run.Sequence "DataSync"
    → Http.Server "Api"
    → Run.Sequence "DataSync"
```

### Phase 5 — Ordered initialization & injection

Resources are initialized in topological order. Before a resource's `init()` is called, the kernel:

1. Walks the resource config using the definition's field map.
2. For each reference slot whose field path does **not** fall within any scope visibility path (prefix match against all `x-telo-scope` entries in the same field map): resolves `{kind, name}` to the live `ResourceInstance` (already initialized, guaranteed by topological order) and replaces the value.
3. Reference slots whose field path **does** fall within a scope visibility path are skipped — they remain as `{kind, name}` pairs. The controller resolves them at runtime via `ScopeContext.getInstance(name)` after opening the scope.
4. For each scope slot, replaces the manifest array with a `ScopeHandle` the controller calls to open the scope at runtime.

The controller receives a config object where singleton reference fields are live instances, scope-path reference fields are untouched `{kind, name}` pairs, and scope fields are `ScopeHandle` objects. Scoped resources are never initialized at this point — they initialize on demand when the controller calls `ScopeHandle.run()`.

---

## 10. Visual Editor Integration

The visual editor builds a field index once when a definition schema is loaded, reusing the same field map produced in Phase 1:

```text
field path              → { refs }
──────────────────────────────────────────────────────────────────────────────────────
notFoundHandler.invoke  → { refs: ["kernel#Invocable"]                                        }
mounts[].mount          → { refs: ["kernel#Service"]                                          }
middlewares[]           → { refs: ["std/http-server#Middleware"]                              }
steps[].invoke          → { refs: ["kernel#Invocable"]                                        }
handler                 → { refs: ["std/http-server#Middleware", "std/javascript#Script"]     }
```

At interaction time, when a user focuses a reference field, the editor performs one lookup per ref and unions the results:

```text
for each ref in refs:
  if ref resolves to Kernel.Abstract:
    registry.getByExtends(targetKind)   // DefinitionRegistry reverse index
  else:
    registry.getByKind(targetKind)
→ union results, group by kind, render as dropdown
```

For `x-telo-ref` slots, the editor also offers an inline definition form using the referenced definition's schema — the same slot accepts either a name picker or an inline config.

For `x-telo-scope` fields, the editor renders a collapsed block in the detail panel showing the count of resources declared inside the scope, with an **Enter** affordance. Clicking **Enter** is a canvas-level navigation: the breadcrumb gains a new crumb for the scope, the entire canvas switches to show only the resources within that scope, and the sidebar resource tree shows the scope's own resource list. Reference autocomplete within the scope is restricted to resources declared inside the scope plus singleton resources from the outer manifest; resources from sibling scopes are not offered.

This is an O(1) registry lookup. No schema traversal happens at interaction time.

---

## 11. Notes on Existing Mechanisms

### `contexts` / `InvocationContext`

`ResourceDefinition.contexts[]` carries a JSONPath `scope` and `schema` for static invocation context checking. Once reference injection is in place, the `scope` field is redundant — the field map builder derives all call-site paths automatically from `x-telo-ref` nodes in the schema, without authors writing JSONPath manually. The input compatibility check can be performed during Phase 3 using the referenced definition's `inputs` schema directly. `contexts` should be considered for removal once reference injection is complete.

### `DefinitionRegistry` vs `ControllerRegistry`

The kernel maintains two parallel definition stores: `ControllerRegistry.definitionsByKind` and `DefinitionRegistry` (from the analyzer). Both are populated on every `registerResourceDefinition` call. `ControllerRegistry` should be refactored to use `DefinitionRegistry` internally so there is one authoritative store, and `getAnalysisContext()` returns the same instance without a separate sync step.

### `resolveChildren` and `withManifests`

`ctx.resolveChildren()` handles inline resource registration at controller `init()` time — it inspects a config value, registers it as a manifest if it has fields beyond `kind`/`name`, and returns a normalized `{kind, name}` reference. `ctx.withManifests()` handles scoped execution at controller `run()` time — it creates a child `EvaluationContext`, initializes the provided manifests in it, runs a callback, then tears the child context down. Controllers like `Run.Sequence` call both manually.

Once Phase 2 normalization and `x-telo-scope` injection are in place, both are superseded by the kernel: inline resources are registered before `init()` is called, and scoped fields are injected as `ScopeHandle` objects. Both methods can be removed from the `ResourceContext` API.
