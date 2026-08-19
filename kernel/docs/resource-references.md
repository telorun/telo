---
description: "v1.0 spec for resource references: x-telo-ref keyword, module identity lookup, kind constraints, and resolution phases"
---

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

`metadata.module` and import aliases remain plain strings — they are module identifiers, not resource references, and are outside of this contract.

---

## 2. The `x-telo-ref` Schema Keyword

`x-telo-ref` is a custom JSON Schema keyword that marks a field as a resource reference slot. It declares two things: which kinds the slot accepts, and **what the declaring resource does with the target**.

```yaml
x-telo-ref:
  kind: KvStore.Store        # one alias-qualified kind, or a list of them
  use: dependency            # what this resource does with the target
  inputs: /inputs            # optional: JSON Pointer to this call's arguments
```

`kind` is an **alias-qualified kind** — the same grammar `kind:`, `extends:` and `capability:` use: an alias from this file's `imports:` map, `Self.<Kind>` for a kind in this same library, or `Telo.<Kind>` for a built-in. Give it a **list** for a slot that accepts several (`kind: [Telo.Runnable, Telo.Service]`).

The **bare string form** (`x-telo-ref: KvStore.Store`) is still accepted and declares no `use`. Every analysis that asks "does control reach this target?" reads such a slot conservatively — as if control does — which is what the walkers this replaced already assumed.

### `use` — when control reaches the target

`use` names when control reaches the target **relative to the declaring resource's own invocation**. That single fact is what every analysis derives from, which is why there is one axis rather than a family of per-concern annotations.

| `use` | Meaning |
| --- | --- |
| `schema` | Names a shape; no runtime instance exists. No edge of any kind. |
| `dependency` | Held and read; control never transfers to its entry point. Init-order edge only. |
| `call` | Control transfers during my invocation and returns to me. |
| `detached` | Control transfers through the kernel's detach primitive; I do not await it. |
| `trigger.inbound` | I register the target; control reaches it after my invocation, driven by a request or a timer, with a guaranteed-fresh ambient context. |
| `trigger.consumer` | I register it; control reaches it when someone drains a value I returned, so no guarantee holds either way. |

The line between `dependency` and `call` is **bound entry point, not method call**. The entry points are `invoke()` / `provide()` / `run()` — the methods the kernel dispatches, traces, contract-checks and zone-tracks. A `Sql.Connection` slot is a `dependency` even though the controller calls `query()` on it, and so is an `Embedding` model whose `embed()` does the real work — a domain method is not dispatch, no matter how much it does. An `Ai.Text` / `Ai.Agent` model slot is a `call` because the controller drives the bound `invoke()`; the streaming variants hold the same kind as a `dependency`, because `stream()` is a convention method nothing in the kernel can observe.

The trigger source lives **inside the value** rather than in a sibling key: a sibling can be omitted, has no place in a case map, and would need its own diagnostic to police what an enum enforces structurally.

**`use` is a set.** A slot may dispatch its target more than one way within a single invocation — `Cache.View` calls inline on a miss and refreshes detached on a stale hit — so it writes `use: [call, detached]`. Each consumer states its own reduction: exceptions propagate if **any** member is `call`, an ambient scope's lifetime extends only if **every** member is.

**A slot whose mode is chosen by configuration declares a case map** keyed on a sibling field:

```yaml
invoke:
  x-telo-ref:
    kind: Telo.Executable
    use:
      by: /detach
      cases: { false: call, true: detached }
```

The selector **must be statically resolvable** — a literal or a schema default (a `Lease.Critical` that omits `detach:` takes the schema's `default: false` and classifies as `call`). A CEL value there is `X_TELO_REF_DYNAMIC_SELECTOR`: a call graph known only at runtime is not statically analyzable, which is the property this design exists to protect. There is deliberately **no fallback**, because no single value is conservative for every consumer — the throws union must assume `call` to keep an error path, while a scope requirement must assume the opposite to avoid inventing one. The annotation's own validity is enforced by `validate-ref-slots.ts`: an unrecognized `use` token (`X_TELO_REF_INVALID_USE`), a structured form missing `use` or `kind`, and `anyOf` branches whose declared uses disagree (`X_TELO_REF_USE_CONFLICT`) are all diagnostics, scoped to the entry's own modules.

A case map and a set answer different questions and do not substitute for each other: the map says *the configuration decides which relation holds*, the set says *several hold at once*.

**Pointers are relative to the object enclosing the slot** — the resource root for a resource-level slot, the array item for a slot inside one, so a route's `handler` can name its siblings. Nothing can address across an array boundary.

**`use` is never cross-checked against the target's capability.** `Ai.Model` declares `capability: Telo.Provider` and no schema at all, exposing its entry points as an ai-module convention, and its slot is genuinely `use: call`. The kernel tests method presence at dispatch; a static test can only read a declared capability. Capability says nothing about whether a slot transfers control.

**One grammar for every kind reference.** A definition schema is authored by a module author, and the alias it names is the author's own — declared in the same file's `imports:` map, resolved in the declaring module's scope, never the consumer's. So the constraint is pinned to a specific module *version* (the one the import source resolves to) and stays correct no matter what alias the consumer picks for the same library. The prefix is an ordinary import alias, so `Self` reaches the declaring library's own kinds and `Telo` reaches the built-ins.

**How the lookup works.** Before a definition is registered, the analyzer rewrites each `x-telo-ref` in its schema to the canonical `<module>.<Kind>` key, resolving the alias against the declaring module's import map — the same pre-resolution `extends:` receives. Downstream, the `DefinitionRegistry` answers a ref query with a plain lookup and needs no module context:

```text
KvStore.Store   →  alias "KvStore" → module "KeyValueStore" →  registry key "KeyValueStore.Store"
Telo.Invocable  →  alias "Telo"    → module "Telo"          →  registry key "Telo.Invocable"
```

A ref naming an alias the declaring file never imported does not resolve, and the constraint is skipped rather than enforced — the same lenient behaviour as any other partial-context lookup.

**Legacy identity form.** Module versions published before the alias form wrote their constraints as `"<namespace>/<module>#<Kind>"` (`std/http-server#Server`, `telo#Invocable`), resolved through an identity table fed by `metadata.namespace`. Those still resolve, so an already-published dependency keeps working; using the form in a new manifest raises `X_TELO_REF_LEGACY_IDENTITY`. `metadata.namespace` exists for nothing else and is not written by current manifests.

AJV ignores unknown keywords in `strict: false` mode (already the project default), so schemas containing `x-telo-ref` are passed to AJV as-is — no materialization or resolver plugin is needed. The field map builder detects reference slots by checking for the presence of `x-telo-ref` in a schema node.

---

## 3. Using References in Definition Schemas

Any schema node with `x-telo-ref` marks a reference slot:

```yaml
# modules/http-server/http-server.yaml
kind: Telo.Definition
metadata:
  name: Server
  module: Http
extends: Telo.Service
schema:
  type: object
  properties:
    notFoundHandler:
      type: object
      properties:
        invoke:
          # registered now, driven later by an inbound request
          x-telo-ref: { kind: Telo.Executable, use: trigger.inbound }
    middlewares:
      type: array
      items:
        x-telo-ref: { kind: Http.Middleware, use: trigger.inbound }
    mounts:
      type: array
      items:
        type: object
        properties:
          path:
            type: string
          mount:
            # held, never dispatched by the server
            x-telo-ref: { kind: Telo.Service, use: dependency }
```

```yaml
# modules/run/telo.yaml
schema:
  properties:
    steps:
      items:
        properties:
          invoke:
            x-telo-ref:
              kind: Telo.Executable
              use: call
              inputs: /inputs
```

---

## 4. Kind-Level Narrowing

Referencing a concrete kind (`kind: Http.Middleware`) constrains a slot to that resource kind **or any kind that transitively `extends` it** (general single inheritance — subtypes are substitutable). Referencing an abstract kind accepts every kind that transitively extends it. Both use the same transitive subtype index; the constraint is enforced semantically in Phase 3 by resolving the value and comparing the alias-resolved kind against the target kind and its descendants. All reference shapes are structurally identical.

For slots that accept multiple kinds, give `kind` a **list**:

```yaml
handler:
  x-telo-ref:
    kind: [Http.Middleware, Js.Script]
    use: trigger.inbound
```

Phase 3 validates that the reference's resolved kind satisfies at least one entry.

**Why a list and not `anyOf`.** An `anyOf` puts each `x-telo-ref` in its own branch, so once the annotation is structured, a branch could carry a *different* `use` than its neighbour — a disagreement with no meaning, since which kinds are acceptable is a property of the target while `use` is a fact about the slot. One slot, one `use`, several acceptable kinds. The analyzer always unioned those branches into a single list internally, so the list simply makes the surface match the model that was already underneath.

The older `anyOf` spelling still resolves for already-published modules; its branches are unioned exactly as a list. Do not use `oneOf` or `allOf` in reference slot positions.

### `Telo.Executable`

`Telo.Executable` is a built-in abstract, the parent of `Telo.Invocable` and `Telo.Runnable`: "control can be transferred to this". A slot that accepts either writes `kind: Telo.Executable` rather than listing both.

It is a **slot constraint, never a lifecycle role** — `capability: Telo.Executable` is rejected, because it names no entry point a controller could implement. And it never gates `use`: a slot may declare `use: call` against any kind at all, which is what keeps a Provider exposing conventional entry points (`Ai.Model`) expressible.

**`Telo.Service` is deliberately outside it.** A service's `run()` is a lifecycle start the kernel dispatches differently — with no ambient scope, so inbound work roots its own trace — and a step's `invoke:` must keep rejecting it. Slots that genuinely accept both, like boot targets, stay lists: `kind: [Telo.Runnable, Telo.Service]`.

---

## 5. Dependent Schema Typing

Two mechanisms handle schema references across definitions. Which to use depends on whether the target type is known statically at definition authoring time.

### Static cross-module references via `$ref` + `$id`

Every `Telo.Definition` schema is automatically assigned an `$id` by the analyzer when the definition is loaded — derived from the module name and the type name — the same `telo://<module>/<Name>` scheme a named `Telo.Type` registers under. Authors never declare `$id` manually. This makes all definition schemas addressable by standard JSON Schema `$ref`:

```yaml
kind: Telo.Definition
metadata:
  name: Connection
  module: SQLPostgres
extends: Sql.Connection
schema:
  # $id: "telo://sql-postgres/Connection" — assigned automatically by the analyzer
  properties:
    url: { type: string }
  $defs:
    PoolOptions:
      type: object
      properties:
        max: { type: integer }
        idleTimeout:
          type: object
          properties:
            millis: { type: integer }
```

`$defs` entries are type definitions, not instance properties — a `SQLPostgres.Connection` resource instance only declares `url`. `PoolOptions` is exposed for consumers and never appears in instance data.

Any definition schema can reference types from another module using a standard `$ref`:

```yaml
$ref: "telo://sql-postgres/Connection#/$defs/PoolOptions"
$ref: "telo://http-server/Server#/properties/headers"
```

The analyzer loads all definition schemas into AJV's schema store keyed by their implicit `$id`. Cross-module `$ref` resolution is handled by AJV directly.

### Open-set dependent typing via `x-telo-schema-from`

Static `$ref` requires the target type to be known at definition authoring time. This breaks when the schema must depend on which resource a field references at manifest authoring time — the set of valid kinds is open and extensible by third-party modules.

`x-telo-schema-from` is a custom JSON Schema keyword that resolves a field's schema dynamically by following a property path to the referenced resource's definition schema:

```yaml
# Illustrative: a statement whose pooling options are typed by whichever
# engine's connection it happens to reference.
kind: Telo.Definition
metadata:
  name: Query
  module: SQL
schema:
  properties:
    connection:
      x-telo-ref:
        kind: Self.Connection
        use: dependency
    statements:
      type: array
      items:
        type: object
        properties:
          pool:
            x-telo-schema-from: "connection/$defs/PoolOptions"
```

`connection/$defs/PoolOptions` is a path expression: `connection` names an `x-telo-ref` property, `/$defs/PoolOptions` is a JSON Pointer into the resolved kind's schema. When `connection` references a `SQLPostgres.Connection` resource, `pool` validates against that kind's `PoolOptions`. When it references a connection kind from a third-party module written long after `SQL.Query` — an engine nobody had in mind here — it validates against *that* kind's `PoolOptions` instead. That open set is the whole point: a static `$ref` would have to name every engine in advance.

**Path scope:** the first segment is resolved relative to the schema location where `x-telo-schema-from` appears. A leading `/` makes the path absolute — resolved from the resource root. No leading `/` means relative — resolved from the nearest enclosing `properties` block (sibling).

Relative — `x-telo-ref` is a sibling property at the same schema level:

```yaml
statements:
  type: array
  items:
    type: object
    properties:
      connection:
        x-telo-ref: { kind: Self.Connection, use: dependency }
      pool:
        x-telo-schema-from: "connection/$defs/PoolOptions" # relative: sibling connection
```

Absolute — `x-telo-ref` is at the resource root:

```yaml
schema:
  properties:
    connection:
      x-telo-ref: { kind: Self.Connection, use: dependency }
    statements:
      type: array
      items:
        type: object
        properties:
          pool:
            x-telo-schema-from: "/connection/$defs/PoolOptions" # absolute: root connection
```

AJV ignores this keyword during its standard validation pass — the dependent schema check is an explicit Phase 3 step run by the analyzer after all references are resolved (see Section 9).

The abstract base kind acts as a nominal type tag — it constrains the `x-telo-ref` slot without declaring any schema contract:

```yaml
kind: Telo.Abstract
metadata:
  name: Connection
  module: SQL
capability: Telo.Provider
# a Telo.Abstract never declares controllers — it cannot be instantiated
```

Concrete implementations extend it and declare their `$defs` slots independently. If one does not declare the expected `$defs` path, `x-telo-schema-from` resolution fails at validation time.

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

The canonical use case is `Telo.Runnable`: start an HTTP server inside the scope, run test steps against it, and have the server torn down automatically when the job completes — without keeping the process alive. The pattern is not exclusive to runnables; any resource kind can declare a scoped field under any name it chooses.

### Declaring a scoped field with `x-telo-scope`

A definition author marks a field as an execution scope using the `x-telo-scope` custom schema keyword. Its value is a JSON Pointer (RFC 6901) declaring where in the parent resource's config the scope is visible — all x-telo-ref resolutions within that path have access to the scoped resources. A scope visible in multiple paths uses an array.

**JSON Pointer visibility is a prefix match.** A ref slot is considered "within the scope" if its field path, expressed as a JSON Pointer, starts with the declared pointer. For example, `x-telo-scope: /steps` covers `/steps/0/invoke`, `/steps/1/handler`, and any deeper path under `/steps`. Both the analyzer (deciding which refs check the scope when resolving names) and Phase 5 (deciding which ref slots to skip at boot) use this same prefix rule. The field value is an array of resource manifests, including `Telo.Import` entries:

```yaml
# Telo.Runnable definition schema
kind: Telo.Definition
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
            x-telo-ref: Telo.Invocable
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
  - kind: Telo.Import
    metadata:
      name: Http
    source: oci://ghcr.io/telorun/http-client
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

`Injected<T>` transforms `x-telo-scope` fields from `ResourceManifest[]` to `ScopeHandle`, the same way it transforms `x-telo-ref` fields from `{kind, name}` to live instances. This pattern is not specific to `Telo.Runnable` or `run()` — any resource kind that declares an `x-telo-scope` field receives a `ScopeHandle` and manages it as it sees fit.

### Lifetime

Scoped resources are initialized when `ScopeHandle.run()` is called and torn down when it returns. They are never pre-initialized at boot. Each call to `run()` gets a fresh initialization — resources do not carry state across calls.

Outer (singleton-scoped) resources are already initialized when a scope opens. Scoped resources may therefore hold `x-telo-ref` slots pointing to outer resources — injection works normally because the targets exist at scope initialization time. Outer resources cannot hold injected references to scoped resources — they are initialized at boot, before any scope exists.

References from the parent's config into the scope (such as `steps[].invoke`) are not injected at boot. The controller resolves them at runtime via `scope.getInstance(name)`.

### Static validation

`x-telo-scope` fields are excluded from AJV validation of the parent resource — the kernel strips them before schema validation, then validates their contents separately as a child manifest set:

- Each declaration in the scope is validated against its definition schema.
- `Telo.Import` entries in the scope are resolved and their definitions registered for scope-local use.
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
  invoke: KindRef<Invocable>;    // x-telo-ref: Telo.Invocable
  server: KindRef<HttpServer>;   // x-telo-ref: Http.Server
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
  invoke: Ref<Invocable>(Telo.Invocable),
  server: Ref<HttpServer>(Http.Server),
  with:   Scope("/steps"),
  port:   Type.Integer(),
});

async function create(config: Injected<Static<typeof MyConfig>>, ctx: ResourceContext) {
  await config.invoke.invoke(payload); // Invocable
  config.server.listen();              // HttpServer
  await config.with.run(async (scope) => { ... }); // ScopeHandle
}
```

The TypeBox schema object can be used directly as the `schema` field in a `Telo.Definition`. **The exported `schema` is the source of truth for validation.** The TypeBox approach is recommended because it keeps the JSON Schema and TypeScript types in sync automatically.

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

`Telo.Import` resources are resolved during `loadFromConfig`, not lazily during the init loop. Each import's child manifests — including their definitions — are loaded and registered before `start()` is called. `Telo.Import` entries declared inside `x-telo-scope` fields are also resolved eagerly, so all definitions from all scopes are registered and known before Phase 3 validation runs. The scoped resources themselves are not initialized at load time — only their definitions are registered.

### Phase 1 — Field map construction

When a `Telo.Definition` is registered during `loadFromConfig`, `buildReferenceFieldMap` traverses its schema once. It records two kinds of entries:

- A node containing `x-telo-ref` is a **reference slot**. All `x-telo-ref` values from `anyOf` branches are collected into `refs`.
- A node containing `x-telo-scope` is a **scope slot**. The JSON Pointer visibility path is recorded alongside the field path.

The field map is cached on the `DefinitionRegistry` entry:

```text
fieldPath       → { refs,                                                              isArray }
───────────────────────────────────────────────────────────────────────────────────────────────
invoke          → { refs: [Telo.Invocable],                                        false   }
middlewares[]   → { refs: [Http.Middleware],                              true    }
mounts[].mount  → { refs: ["Telo.Service"],                                          true    }
server          → { refs: [Http.Server],                                  false   }
handler         → { refs: [Http.Middleware, Js.Script],     false   }
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

For each reference field, the value must satisfy at least one `ref` entry in the field map (`anyOf` semantics). Per entry, validation dispatches on whether the target is a `Telo.Abstract` or `Telo.Definition`:

1. **Structural validation** — the reference object has both `kind` and `name` fields of type string.
2. **Kind validation** — dispatched per ref value:
   - `Telo.Abstract` target → `registry.getByExtends(targetKind)` must include the referenced resource's definition.
   - `Telo.Definition` target → the alias-resolved reference `kind` must equal the target's canonical kind.
3. **Scope validation** — uses the `AliasResolver` from `AnalysisContext`:
   - Scoped resources may reference outer (singleton-scoped) resources — outer resources are initialized before any scope opens.
   - Outer resources may not hold injected references to scoped resources — they are initialized at boot before any scope exists. References from the parent's config into a scope (within the JSON Pointer path declared by `x-telo-scope`) are validated for name and kind but are not injection-time dependencies.
   - Cross-module references without an explicit `Telo.Import` are rejected at any scope level.
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
notFoundHandler.invoke  → { refs: [Telo.Invocable]                                        }
mounts[].mount          → { refs: ["Telo.Service"]                                          }
middlewares[]           → { refs: [Http.Middleware]                              }
steps[].invoke          → { refs: [Telo.Invocable]                                        }
handler                 → { refs: [Http.Middleware, Js.Script]     }
```

At interaction time, when a user focuses a reference field, the editor performs one lookup per ref and unions the results:

```text
for each ref in refs:
  if ref resolves to Telo.Abstract:
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

### `ensureKindRef` and `withManifests`

`ctx.ensureKindRef()` handles inline resource registration at controller `init()` time — it inspects a config value, registers it as a manifest if it has fields beyond `kind`/`name`, and returns a normalized `{kind, name}` reference. (It was called `resolveChildren`; that name is deprecated and now delegates here.) `ctx.withManifests()` handles scoped execution at controller `run()` time — it creates a child `EvaluationContext`, initializes the provided manifests in it, runs a callback, then tears the child context down. Controllers like `Run.Sequence` call both manually.

Once Phase 2 normalization and `x-telo-scope` injection are in place, both are superseded by the kernel: inline resources are registered before `init()` is called, and scoped fields are injected as `ScopeHandle` objects. Both methods can be removed from the `ResourceContext` API.
