---
description: "Node.js SDK: module interfaces, context types, and shared primitives; distinguishes operational vs domain failures via InvokeError"
---

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

## Errors

Telo distinguishes two kinds of failure from an `Invocable` / `Runnable`:

- **Operational failures** — plain `Error` or `RuntimeError` throws. Propagate to the kernel's infrastructure layer (HTTP → Fastify 5xx, sequence → bubbles up). These represent bugs or environment failure.
- **Domain failures** — `InvokeError` throws. Part of the invocable's public contract. Route handlers match on `error.code` via `catches:` entries; sequences handle them in `try`/`catch`.

```ts
import { InvokeError, isInvokeError } from "@telorun/sdk";

// In a controller:
throw new InvokeError("UNAUTHORIZED", "Token missing or invalid", {
  reason: "expired",
});

// Anywhere a thrown value crosses a boundary:
if (isInvokeError(err)) {
  // err.code, err.message, err.data
}
```

Use `isInvokeError(err)` for recognition — it's dual-realm-safe (survives pnpm hoist splits, registry-loaded modules with their own SDK copy, and future sandbox isolation). `instanceof InvokeError` is not reliable across package boundaries.

Controllers that throw `InvokeError` **must** declare their codes in their `Telo.Definition`:

```yaml
kind: Telo.Definition
metadata: { name: VerifyToken }
capability: Telo.Invocable
throws:
  codes:
    UNAUTHORIZED: { description: Missing or invalid token. }
    EXPIRED:
      description: Token is past its expires_at.
      data:
        type: object
        properties:
          expiredAt: { type: string, format: date-time }
        required: [expiredAt]
```

Undeclared codes emit an `${kind}.${name}.InvokeRejected.Undeclared` observability event — the analyzer catches these statically.

Composers that propagate rather than originate codes can declare:

```yaml
throws:
  inherit: true   # union of everything I call (requires x-telo-step-context)
  # or
  passthrough: true   # union is whatever my inputs.code resolves to (Run.Throw-style)
```

`inherit` is driven by the analyzer's dataflow pass over `x-telo-step-context` arrays; future composers opt in by declaring both the annotation and `inherit: true`. See [modules/run/docs/structured-errors.md](../../modules/run/docs/structured-errors.md) for the end-to-end flow.

## Related Docs

- Kernel overview: [kernel/README.md](../../kernel/README.md)
- Built‑in modules: [modules/](../../modules/)
- SDKs index: [sdk/README.md](../README.md)
