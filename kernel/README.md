# Telo Kernel

The Telo Kernel is the declarative execution host for Telo manifests. It loads YAML, compiles CEL expressions, resolves and registers controllers, indexes resource instances, and orchestrates the boot/teardown lifecycle of every kind it knows about.

**Target:** Node.js (Rust/Go ports planned)

**Input:** A module manifest YAML file or a directory of YAML files

## 1. Core Concepts

The Telo Kernel is a **declarative execution host**. You describe resources in YAML; the kernel loads them, wires up controllers, and keeps the process alive until all work is done.

The kernel performs three functions:

- **Loader:** Reads YAML files, compiles `${{ }}` CEL expressions, and resolves controller entrypoints.
- **Registry:** Indexes resource instances by a composite key of `module.Kind.name`.
- **Kernel:** Orchestrates the boot sequence, manages the event bus, and routes invocations.

**Module loading and resource discovery** happen during the load phase, before any resource is initialized.

---

## 2. Resource Definitions

Every resource in a manifest is an instance of a `Telo.Definition`. A definition declares several orthogonal facets:

| Facet         | Field          | Purpose                                                                             |
| ------------- | -------------- | ----------------------------------------------------------------------------------- |
| `capability`  | Lifecycle role | One of `Runnable`, `Service`, `Invocable`, `Mount`, `Provider` — mutually exclusive |
| `topology`    | Composition    | How the kind is structured internally: `Sequence`, `Router`, `Workflow`             |
| `extends`     | Inheritance    | Abstract interface this kind fulfills (cross-module plugin pattern)                 |
| `controllers` | Execution      | PURL-referenced controller implementations                                          |

### Capability

`capability` assigns a single lifecycle role. The kernel uses it to determine when to call `init()`, `run()`, or `invoke()` on the controller. A definition declares exactly one capability.

→ [docs/capabilities.md](docs/capabilities.md)

### Topology

`topology` names the structural composition pattern of a kind — how it is assembled internally from steps, routes, or nodes. It drives built-in execution when no controller is declared, structural validation in the analyzer, and canvas rendering in the editor.

→ [docs/topology.md](docs/topology.md) _(design proposal — not yet implemented)_

### Inheritance

`extends` declares that a definition fulfills an abstract interface (`Telo.Abstract`) declared by another module. This is the plugin pattern for subsystems like workflow backends.

→ [docs/inheritance.md](docs/inheritance.md)

For the complete `Telo.Definition` field reference, see [docs/resource-definition.md](docs/resource-definition.md).

---

## 3. CEL Interpolation

Before a manifest object is processed, every `${{ ... }}` expression is compiled. This runs as part of loading — any compilation error halts the boot sequence immediately.

Host environment variables reach CEL only through typed root entries: declare a `variables:`/`secrets:`/`ports:` entry with an `env:` key and read it as `${{ variables.X }}` / `${{ secrets.X }}` / `${{ ports.X }}`.

```yaml
variables:
  manifestPath:
    env: MY_MANIFEST_PATH
    type: string
resources:
  - ${{ variables.manifestPath }}
```

### Interpolation

- `${{ expr }}` — the interpolation syntax used throughout Telo

When the entire string is a single interpolation, the result preserves the CEL type (integer, boolean, etc.). Mixed strings are coerced to string.

---

## 4. Telo.Definition

Modules declare the resource kinds they handle using `Telo.Definition`:

```yaml
kind: Telo.Definition
metadata:
  name: Server # fully-qualified kind: Http.Server
  module: Http
capability: Service # one of: Runnable, Service, Invocable, Mount, Provider, Template
schema: # JSON Schema — validated against each resource before create()
  type: object
  properties:
    port: { type: integer }
    host: { type: string }
  required: [port]
controllers:
  # Ordered list of Package URL (PURL) candidates — first match for the current runtime is used
  - pkg:npm/@telorun/run@>=1.0.0?local_path=./nodejs#sequence
  - pkg:cargo/telorun-run@>=1.0.0?local_path=./rust#sequence
  - pkg:golang/github.com/telorun/run@>=1.0.0?local_path=./go#sequence
```

When a `Telo.Definition` instance initializes, it resolves and loads the controller module
and registers it with the kernel. For the full resolution algorithm (local path, host
node_modules, registry cache) and PURL format, see [controllers.md](docs/controllers.md).
