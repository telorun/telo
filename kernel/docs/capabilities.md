# Capabilities

A `capability` declaration on `Telo.Definition` assigns a single **lifecycle role** to instances of that kind. The kernel uses this role to determine when and how to interact with instances during the init loop, run phase, and shutdown.

```yaml
kind: Telo.Definition
metadata: { name: Client, module: Http }
capability: Provider
```

Capabilities are **mutually exclusive**. A definition declares exactly one. Each capability corresponds to a distinct execution contract and lifecycle phase — a resource cannot simultaneously be in the init phase (`Provider`) and the run phase (`Runnable`), nor can a single controller implementation correctly satisfy two contracts. When a domain concept requires both, split it into two definitions (e.g. `Http.Client` as `Provider`, `Http.Request` as `Invocable`).

---

## Built-in Capabilities

### `Runnable`

The resource runs a bounded or indefinite process. The kernel calls `run()` after initialization completes. The process may terminate naturally.

**Lifecycle phase:** Run  
**Controller interface:**

```ts
interface Runnable {
  run(): Promise<void>;
}
```

**Kernel behavior:** Calls `run()` once after all providers in the module have initialized. A natural return (resolved promise) is treated as a normal exit. A rejected promise is treated as a fault.

**Typical use:** pipelines, background workers, one-shot jobs.

---

### `Service`

Like `Runnable`, but the kernel expects the instance to run indefinitely. An early return is treated as a fault and may trigger a restart or shutdown depending on kernel policy.

**Lifecycle phase:** Run (long-lived)  
**Controller interface:**

```ts
interface Service {
  run(): Promise<void>;
}
```

**Typical use:** HTTP servers, message queue consumers, persistent listeners.

---

### `Invocable`

The resource can be called on demand with typed inputs and returns typed outputs. Any topology step, route handler, or explicit `invoke` call uses this contract.

**Lifecycle phase:** On-demand (per-call)  
**Controller interface:**

```ts
interface Invocable<TInput, TOutput> {
  invoke(inputs: TInput): Promise<TOutput>;
}
```

**Definition-level contract:** Declares `inputs` and `outputs` as JSON Schema. The kernel validates arguments against `inputs` before calling and validates the return value against `outputs` before returning it to the caller.

**Kernel behavior:** CEL expansion of call-site `inputs` against the current evaluation context, optional retry policy, and `<Kind>.<Name>.Invoked` event emission after success.

See [invocable.md](capabilities/invocable.md) for the full invocation layer specification.

**Typical use:** HTTP request handlers, database query operations, function calls, LLM actions.

---

### `Mount`

The resource can be attached to a `Service` instance at a declared path or prefix. The `Service` delegates matching traffic to the mounted resource.

**Lifecycle phase:** Attach (during init, before `Service` starts)  
**Controller interface:**

```ts
interface Mount {
  mount(server: TServer, prefix: string): Promise<void>;
}
```

**Typical use:** HTTP route groups (mounted onto an HTTP server), middleware layers.

---

### `Provider`

The resource initializes during the kernel's init loop and makes a value or connection available for other resources to reference. All CEL expressions that reference a `Provider` output are fully expanded at compile time.

**Lifecycle phase:** Init  
**Controller interface:**

```ts
interface Provider {
  init(): Promise<void>;
}
```

**Kernel behavior:** Called during the multi-pass init loop before `Runnable` and `Service` resources are started. Compile-time CEL expansion is applied to all fields (`**` path) — this is required because provider outputs must be resolved before controllers that depend on them are initialized.

**Typical use:** database connection pools, configuration stores, secrets managers, shared clients.

---

### `Template`

A meta-capability reserved for system-level kernel kinds: `Telo.Application`, `Telo.Library`, `Telo.Definition`, `Telo.Import`, `Telo.Abstract`. Not for use in application modules.
