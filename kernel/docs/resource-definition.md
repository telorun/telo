# `Kernel.Definition` Specification

## Overview

A `Kernel.Definition` is the schema, contract, and execution specification for a named resource kind. Every resource in a Telo manifest is an instance of a definition. The definition tells the kernel how to validate, execute, and relate instances of that kind; it tells the analyzer what is valid to write; and it tells the editor how to render and edit instances visually.

A definition is composed of several independent **facets**, each serving a distinct layer:

| Facet               | Field(s)            | Purpose                                                         | Consumed by                         |
| ------------------- | ------------------- | --------------------------------------------------------------- | ----------------------------------- |
| Identification      | `metadata`          | Names the type within a module                                  | All                                 |
| Capability          | `capability`        | The lifecycle role the type fulfills                            | Kernel runtime                      |
| Structural pattern  | `topology`          | How the type is internally composed                             | Kernel execution, analyzer, editor  |
| Config schema       | `schema`            | Shape of properties instances accept, including all annotations | Kernel validation, analyzer, editor |
| Invocation contract | `inputs`, `outputs` | Parameters and return shape when invoked                        | Kernel runtime, analyzer            |
| Execution           | `controllers`       | Implementation of runtime behavior                              | Kernel execution                    |

Facets are orthogonal. Any combination is valid. A definition need not declare all facets.

---

## 1. Identification

```yaml
kind: Kernel.Definition
metadata:
  name: Api # PascalCase type name, unique within the module
  module: Http # Module namespace this type belongs to
```

The fully-qualified kind name is `<module>.<name>` — e.g. `Http.Api`. Resource instances reference the type by this qualified name in their `kind` field.

`metadata.module` uses the module's kebab-case slug.

---

## 2. Capability (`capability`)

`capability` assigns a single lifecycle role to instances of this type. The kernel uses this role to determine when and how to interact with instances during the init loop, run phase, and shutdown.

```yaml
capability: Runnable
```

Capabilities are mutually exclusive — a definition declares exactly one. See [capabilities.md](capabilities.md) for the full specification.

### Built-in capabilities

| Capability  | Kernel behavior                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Runnable`  | The kernel starts the instance by calling `run()`. The instance may terminate naturally.                                                  |
| `Service`   | Like `Runnable`, but the kernel expects the instance to run indefinitely and treats early termination as a fault.                         |
| `Invocable` | The instance can be called with inputs and returns a result. Other resources may reference it as a handler or step target.                |
| `Mount`     | The instance can be attached to a `Service` instance at a declared prefix or path.                                                        |
| `Provider`  | The instance provides values consumed by other resources. All CEL expressions referencing its outputs are fully expanded at compile time. |
| `Template`  | A meta-type used for system-level kinds such as `Module`, `Definition`, `Import`, and `Abstract`. Not for application use.                |

---

## 3. Structural Pattern (`topology`)

`topology` names the structural composition pattern of the type. It is an annotation consumed by the kernel's built-in execution engine (when no controller is present), by the analyzer for structural validation, and by the editor for topology-aware UI rendering.

```yaml
topology: Router
```

`topology` and `capability` are orthogonal — they describe different things and may be freely combined.

For the full specification of known topologies, topology role annotations (`x-telo-topology-role`), and the execution model, see [topology.md](topology.md).

---

## 4. Config Schema (`schema`)

`schema` describes the shape of properties that instances of this type may declare. It follows JSON Schema with Telo-specific extension keywords for resource semantics that JSON Schema cannot express natively.

```yaml
schema:
  type: object
  properties:
    host:
      type: string
      default: "0.0.0.0"
    port:
      type: integer
    routes:
      type: array
      items:
        type: object
        properties:
          handler:
            x-telo-ref: Kernel.Invocable
  required:
    - port
    - routes
```

### Extension keywords

#### `x-telo-ref`

Marks a field as a reference to another resource. The value is the fully-qualified capability or kind name the referenced resource must fulfill.

```yaml
handler:
  x-telo-ref: Kernel.Invocable # must reference an invocable resource
```

At runtime, the field value is the live instance of the referenced resource rather than a plain identifier. The analyzer validates that the referenced resource exists and fulfills the declared contract.

To accept multiple capability alternatives:

```yaml
invoke:
  anyOf:
    - x-telo-ref: Kernel.Invocable
    - x-telo-ref: Kernel.Runnable
```

#### `x-telo-scope`

Marks a field as a **scope container**. Resources declared under this field are locally scoped to the parent resource's lifetime — they are initialized before they are needed and torn down when the parent completes or is torn down.

```yaml
with:
  x-telo-scope: /steps # resources under "with" are scoped to /steps execution
```

The value is a JSON Pointer to the field whose execution the scoped resources are contained within.

#### `x-telo-topology-role`

Maps a schema field to a named structural role within the resource's topology. Required for both built-in execution (so the kernel can locate the correct fields) and for editor rendering (so the editor can generically render topology-aware UI without per-kind plugins).

```yaml
routes:
  x-telo-topology-role: entries
  items:
    properties:
      request:
        x-telo-topology-role: matcher
      handler:
        x-telo-topology-role: handler
        x-telo-ref: Kernel.Invocable
```

Role annotations are required whenever a `topology` is declared, regardless of whether a controller is also present. The controller replaces runtime execution but the editor and analyzer still read role annotations.

For the role names defined per topology, see [topology.md § Topology Role Annotations](topology.md#topology-role-annotations).

#### `x-telo-schema-from`

Derives the schema for a field dynamically from the schema of another resource's definition. The value is a reference path of the form `<refField>/$defs/<TypeName>`.

```yaml
options:
  x-telo-schema-from: backend/$defs/NodeOptions
```

The analyzer resolves the path by finding the resource referenced by the `backend` field and navigating to the `$defs/NodeOptions` sub-schema within its definition's schema. This allows option fields whose shape is determined by a user-selected backend resource to be validated correctly.

---

## 5. Invocation Contract (`inputs`, `outputs`)

When the type has `capability: Invocable`, `inputs` and `outputs` declare the invocation contract as JSON Schema.

```yaml
inputs:
  type: object
  properties:
    userId: { type: string }
    includeDeleted: { type: boolean, default: false }
  required:
    - userId

outputs:
  type: object
  properties:
    user: { type: object }
    found: { type: boolean }
```

The kernel validates invocation arguments against `inputs` before calling the controller, and validates the return value against `outputs` before returning it to the caller. This catches malformed data at the boundary — particularly important when controllers wrap external APIs or LLM structured outputs, where the returned shape is not guaranteed. The analyzer additionally uses both schemas statically: `inputs` to validate call site arguments, `outputs` to validate downstream CEL expressions that access the return value.

---

## 6. CEL Evaluation Contexts (`x-telo-context`)

CEL expressions in resource instances evaluate against a variable context — a set of named values available at that point. The CEL context for a field is declared directly on that field in the schema using the `x-telo-context` annotation.

This keeps context declarations co-located with the fields they apply to. The schema is the single source of truth for everything about a field — its shape, its resource reference, its topology role, and its CEL evaluation context.

```yaml
schema:
  type: object
  properties:
    routes:
      type: array
      items:
        type: object
        properties:
          handler:
            x-telo-ref: Kernel.Invocable
            x-telo-context:
              type: object
              properties:
                request:
                  type: object
                  properties:
                    path: { type: string }
                    method: { type: string }
                    query: { type: object }
                    body: { type: object }
                result:
                  type: object
                  additionalProperties: true
              additionalProperties: false
```

The value of `x-telo-context` is a JSON Schema object. Its top-level properties are the variable names accessible to CEL expressions at that field's location in an instance. The annotation may appear on any field — not only invocable references, but also plain string fields that contain CEL expressions.

The analyzer validates that:

- CEL expressions at the annotated field only access variables present in the context schema (when `additionalProperties: false`).
- Resources referenced from an annotated field have `inputs` schemas compatible with the declared context.

### Context schema annotations

#### `x-telo-context-from`

Replaces a context node's properties at analysis time with values read from the **manifest instance** at the given slash-separated path. Use this to narrow an otherwise open context variable to exactly the fields declared by the resource author.

```yaml
handler:
  x-telo-context:
    type: object
    additionalProperties: false
    properties:
      request:
        # Replace this node with the contents of request.schema from the manifest instance
        x-telo-context-from: "request/schema"
        type: object
```

At analysis time the analyzer walks from the manifest item (e.g. the route object) along `request → schema` and merges the keys found there as named properties into the context node, closing it with `additionalProperties: false`. If the path resolves to nothing, the node is left open.

This is the mechanism used to make query-string typos (`request.query.nonExistentKey`) a static error when the route declares an explicit query schema.

#### `x-telo-context-ref-from`

Replaces a context node at analysis time with the **`outputSchema`** (or any sub-path) of a resource referenced by a sibling field of the manifest item. Use this to give downstream CEL expressions precise type information about the result an invocable returns.

```yaml
response:
  type: array
  x-telo-context:
    type: object
    additionalProperties: false
    properties:
      result:
        # Replace this node with the outputSchema of the resource referenced by "handler"
        x-telo-context-ref-from: "handler/outputSchema"
        type: object
        additionalProperties: true # fallback when outputSchema is not declared
```

The value is `<refField>/<subpath>`. The analyzer resolves `refField` to the manifest value of that sibling key (expected to be a `{ kind, name }` resource reference), looks up that resource in the manifest set, and navigates `subpath` within it to find the schema to substitute. Falls back to the declared fallback schema (typically `additionalProperties: true`) when the referenced resource has no such path.

This is the mechanism that types the `result` variable in HTTP response body CEL expressions based on the `outputSchema` declared on the handler resource (e.g. `Sql.Select`).

---

## 7. Execution (`controllers`)

`controllers` lists one or more Package URL (PURL) candidates identifying the controller that implements runtime behavior for this type. The kernel selects the first candidate compatible with the current runtime.

```yaml
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server-api
  - pkg:cargo/telorun-http-server@>=0.1.0?local_path=./rust#http-server-api
```

**When `controllers` is present:** the controller handles all runtime execution. The topology annotation remains fully active — the editor and analyzer still use it. The controller replaces only the execution layer.

**When `controllers` is omitted:** the kernel uses the built-in execution engine for the declared topology. This is the mechanism for defining resource kinds without writing code. If no topology is declared or the topology is unknown, `controllers` is required.

For the full specification of PURL format, resolution order, entry points, and the controller module interface, see [controllers.md](controllers.md).

---

## 8. Complete Example

A definition that combines all facets:

```yaml
kind: Kernel.Definition
metadata:
  name: Api
  module: Http

# Capability contract: instances are mounted onto a Service
capability: Mount

# Structural pattern: the editor renders a route table; the analyzer validates handler refs
topology: Router

# Execution: Fastify controller overrides built-in Router dispatch
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server-api

# Config schema with topology role annotations and resource references
schema:
  type: object
  properties:
    routes:
      x-telo-topology-role: entries
      type: array
      items:
        type: object
        properties:
          request:
            x-telo-topology-role: matcher
            type: object
            properties:
              path: { type: string }
              method: { type: string }
          handler:
            x-telo-topology-role: handler
            x-telo-ref: Kernel.Invocable
            # CEL context available to the handler invocable and its inputs
            x-telo-context:
              type: object
              properties:
                request:
                  type: object
                  properties:
                    path: { type: string }
                    method: { type: string }
                    query: { type: object }
                    body: { type: object }
                result:
                  type: object
                  additionalProperties: true
              additionalProperties: false
          response:
            type: array
            items:
              type: object
              properties:
                status: { type: integer }
                when:
                  type: string
                  # CEL context for the `when` expression on each response entry
                  x-telo-context:
                    type: object
                    properties:
                      result:
                        type: object
                        additionalProperties: true
                    additionalProperties: false
                body: {}
  required:
    - routes

# Invocation contract: can be invoked with a request, returns a response
inputs:
  type: object
  properties:
    request:
      type: object
      properties:
        path: { type: string }
        method: { type: string }
        body: { type: object }

outputs:
  type: object
  properties:
    status: { type: integer }
    body: { type: object }
```

---

## 9. Facets Are Independent

Each facet is read by different consumers and may be declared independently. The table below shows valid combinations for common kind archetypes:

| Archetype                      | `capability` | `topology` | `schema`               | `inputs`/`outputs` | `controllers` |
| ------------------------------ | ------------ | ---------- | ---------------------- | ------------------ | ------------- |
| Long-running service           | `Service`    | —          | ✓                      | —                  | ✓             |
| Invocable function             | `Invocable`  | —          | ✓                      | ✓                  | ✓             |
| Sequence job (no code)         | `Runnable`   | `Sequence` | ✓ with topology roles  | —                  | —             |
| HTTP API                       | `Mount`      | `Router`   | ✓ with roles + context | ✓                  | ✓             |
| Generic event router (no code) | `Invocable`  | `Router`   | ✓ with topology roles  | ✓                  | —             |
| Config provider                | `Provider`   | —          | ✓                      | —                  | ✓             |
