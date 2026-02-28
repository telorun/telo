# Telo SDK (Node.js)

The Node.js SDK provides the authoring surface for Telo modules. It defines the shared contracts (types and lifecycle interfaces) that modules use to plug into the kernel, so module code stays consistent across implementations.

## What It Provides

- **Module interfaces** for registering resources and handling execution.
- **Context types** for accessing the kernel, registry, and events.
- **Shared primitives** used by Telo modules and tooling.

## Status

Early prototype. APIs and contracts are still evolving. The API surface - including YAML shapes - may change at any time without notice.

## When to Use It

Use the SDK when building or extending Telo modules. It is not the kernel itself; it is the contract layer that keeps module behavior consistent and predictable.

## Related Docs

- Kernel overview: [kernel/README.md](../../kernel/README.md)
- Built‑in modules: [modules/](../../modules/)
- SDKs index: [sdk/README.md](../README.md)
