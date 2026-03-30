# Telo Core Concepts — Architectural Problems

## 1. `Kernel.Module` Has an Identity Crisis

`Kernel.Module` is simultaneously two different things:

- A **package descriptor** — `name`, `version`, `variables`, `secrets`, `exports`
- A **runtime entrypoint** — `targets`, `include`

`targets` is intentionally minimal — the equivalent of `main()` in imperative languages. It names the entry point; if startup logic requires ordering, conditionality, or error handling, the user points `targets` at a `Run.Sequence` (or any runnable). That is the designed escape hatch, not a limitation.

The actual problem in `Kernel.Module` is `include`. `package.json` never says "pull these other package.json files into my scope" — Node.js uses `require`/`import` at code level. Telo's `include` is a metadata-level file assembly mechanism, which means the same resource file changes meaning depending on how it's loaded (included vs. standalone). A resource's module scope is no longer determinable from the resource itself; it depends on who includes the file.

This also breaks the analyzer: because `include` assembles resources into a merged graph before analysis runs, errors can only be reported on the entry manifest. The analyzer has no reliable path back to the originating file. Source location is lost at the assembly seam.

### Solution

Invert ownership. Instead of a module claiming files via `include`, each resource declares its module:

```yaml
# server.yaml
kind: Kernel.Definition
metadata:
  name: Server
  module: http-server # scope declared on the resource, not assigned by loader
capability: Service
controllers:
  - pkg:npm/...
```

The module descriptor becomes a pure contract — no file references, no scope assignment:

```yaml
kind: Kernel.Module
metadata:
  name: http-server
  version: 1.1.0
variables: ...
exports:
  kinds: [Server, Api]
```

File discovery becomes a separate, scope-free transport mechanism. The entry manifest can carry a `files:` list that tells the loader what URLs to fetch, resolved relative to the manifest's own URL — exactly how HTML resolves `<script src>`. Fetching `files:` entries has no effect on resource scope:

```yaml
kind: Kernel.Module
name: http-server
version: 1.1.0
files: # transport manifest — fetch these, assign nothing
  - server.yaml
  - api.yaml
exports:
  kinds: [Server, Api]
```

This enables `telo https://example.com/myapp/module.yaml` to work as a clean fetch chain with no filesystem assumptions: entry manifest → `files:` entries resolved against base URL → `source:` imports resolved against their own base URLs. Scope is always read from the resource, never inferred from context.

When `module:` is omitted, the resource belongs to the root/default module — the same ergonomic default Kubernetes uses for `namespace`.

The analyzer benefit is immediate: each file is analyzed as a standalone document. Errors point to the correct file at the correct line with no source-location threading required.

## 2. `metadata` Has Naming Inconsistencies

`metadata.module` on a resource is the correct place for a placement directive — Kubernetes does the same with `metadata.namespace` and it is a well-established pattern. That is not the problem.

The problem is a single naming inconsistency:

- **Two names for the same concept.** `Kernel.Module` itself uses `metadata.namespace` (e.g. `namespace: std`) while every other resource uses `metadata.module` to declare its scope. The same concept — "which namespace does this belong to" — has two different field names depending on which `kind` you're writing.

### Solution

Use a flat top-level `module:` field on all resources, not `metadata.module` or `metadata.namespace`.

`metadata.namespace` cannot be the answer because `namespace` in Telo is already a distinct concept: the registry org under which a module is published (equivalent to npm's `@org/package` scope). Reusing that field name for runtime placement would mean `metadata.namespace` has different semantics depending on which `kind` you're writing — registry scope on `Kernel.Module`, runtime placement on everything else.

`metadata.module` works but buries a structural fact inside a bag of descriptive fields. The three most important facts about any resource are its type, its runtime placement, and its name. Placing two of those at the top level (`kind:`) and one inside `metadata` creates an asymmetry without a good reason.

Flat `module:` at the top level makes placement explicit and structurally equivalent to `kind:`:

```yaml
kind: Http.Server
module: my-app # runtime placement, first-class alongside kind
metadata:
  name: ExampleServer
port: 8080
```

`metadata` then holds only what it should: identity (`name`) and descriptive annotations (`labels`, `description`). When `module:` is omitted the resource belongs to the root module, preserving the ergonomic default.

## 3. `Kernel.Definition` Is a God Object

A single definition carries:

- `capability` — lifecycle role
- `schema` — instance shape
- `controllers` — implementation binding
- `expand` — compile/runtime hooks
- `x-telo-*` extensions scattered in schema

The structural concern that remains: does `Kernel.Mount`'s position as the only capability with extra framework-level semantics point toward a deeper split — or are all capabilities now structurally uniform since `x-telo-context` moved scope injection into the schema?

## 4. `capability` Values Have a Naming Inconsistency

Inside a `Kernel.Definition`, `capability` values use the `Kernel.` prefix:

```yaml
kind: Kernel.Definition
capability: Kernel.Service
```

The `Kernel.` prefix appears redundantly — you're already inside a `Kernel.Definition`, so `Kernel.Service` ≡ `Service`. But current module definitions use `capability: Kernel.Service` (with prefix) vs some docs using `capability: Mount` (no prefix). This inconsistency bleeds into the analyzer and generates confusing error messages.

## 5. No Type Inheritance or Interface Composition

If you want an `AuthenticatedApi` that extends `Http.Api` with auth middleware injected, there's no mechanism. Options are:

- Duplicate the schema entirely
- Use parametric templates (parametric typing, not inheritance)
- Wrap with an adapter (composition, but awkward in this model)

The `x-telo-ref: Kernel.Invocable` mechanism hints at interface-like contracts but it's read-only — you can say "this field must be Invocable" but you can't say "this type extends X and adds Y".

## 6. `sdk` Package Contains the Core Runtime

`@telorun/sdk` is named as a public authoring API — the surface module authors use to write controllers. But it actually contains the core runtime engine:

- `EvaluationContext` — the full multi-pass init loop, teardown tree, scope handles
- `ModuleContext` — variables/secrets/resources namespaces, kind alias resolution
- `ExecutionContext` — per-trigger execution overlay
- `ResourceContext` interface — the full kernel service contract

This is the opposite of what an SDK should be. An SDK should expose stable, minimal, outward-facing types that module authors depend on (`ResourceInstance`, `ResourceContext`, capability interfaces). The runtime engine — `EvaluationContext`, `ModuleContext`, the init loop — is an internal implementation detail that module authors should never need to import directly.

The current arrangement has two concrete consequences:

- **Compilation is blocked.** Extracting a kernel-free compiled runtime requires `EvaluationContext` and the init loop to be importable without pulling in the full kernel. Since they live in `sdk`, they appear to be a public contract, creating confusion about what is stable surface vs internal machinery.
- **SDK stability is undermined.** Every internal refactor of `EvaluationContext` (init loop changes, scope handle semantics, context tree changes) is technically a breaking change to a public package. The boundary between "stable API" and "internal engine" is invisible.

### Solution

Move `EvaluationContext`, `ModuleContext`, `ExecutionContext`, the init loop, scope handles, and `CompiledValue` back into `@telorun/kernel` where they belong. The SDK (`@telorun/sdk`) is then reduced to what a public authoring API should be: `ResourceContext` interface, `ResourceInstance`, capability interfaces (`Invocable`, `Runnable`, `Provider`), `ScopeHandle`, `KindRef`.

Controllers import only `@telorun/sdk`. The kernel imports its own internal engine directly — no circular dependency, no leaking of init loop internals into a public package.

## Summary

| Concept             | Core Problem                                                                              | Direction                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Kernel.Module`     | Conflates descriptor + entrypoint + file loader                                           | Split into package manifest and startup plan                              |
| `Kernel.Definition` | Capability mixes schema and controllers; `Kernel.Mount` is the odd one out                | Clarify whether `Kernel.Mount` warrants a distinct top-level kind         |
| `metadata`          | `namespace` vs `module` naming split; can't use `metadata.namespace` (registry collision) | Flat top-level `module:` field on all resources                           |
| `capability` values | Inconsistent prefix usage                                                                 | Drop `Kernel.` prefix inside Definition; use enum                         |
| Type inheritance    | Missing entirely                                                                          | At minimum: `extends:` for schema composition                             |
| `sdk` package       | Contains core runtime, not a public authoring API                                         | Move runtime internals back to kernel; SDK exposes only authoring surface |
