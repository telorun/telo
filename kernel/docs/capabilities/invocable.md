# Capability: Invocable

A resource kind declares `capability: Invocable` to signal that its instances can be called with inputs and return outputs. Three distinct layers make up the full invocable system.

---

## 1. Controller Interface

The TypeScript contract a controller implements:

```ts
interface Invocable<TInput, TOutput> {
  invoke(inputs: TInput): Promise<TOutput>;
}
```

The kernel calls `invoke()` directly. Controllers are responsible only for executing their logic and returning a value — retry, CEL expansion, and event emission are handled by the kernel at the invocation layer (see §3).

---

## 2. Definition-Level Contract (`inputs` / `outputs`)

Declared on `Kernel.Definition`. Describes the _shape_ of what the invocable accepts and returns, as JSON Schema.

```yaml
kind: Kernel.Definition
metadata: { name: Query, module: Sql }
capability: Invocable
inputs:
  type: object
  properties:
    sql: { type: string }
    bindings: { type: array }
  required: [sql]
outputs:
  type: object
  properties:
    rows: { type: array }
    count: { type: integer }
```

| Field     | Description                                              |
| --------- | -------------------------------------------------------- |
| `inputs`  | JSON Schema for the argument object passed to `invoke()` |
| `outputs` | JSON Schema for the value returned from `invoke()`       |

**Kernel behavior:** validates the call-site argument object against `inputs` before invoking, and validates the return value against `outputs` before returning it to the caller. Catches malformed data at the boundary — especially important for controllers wrapping external APIs or LLM outputs where the returned shape is not guaranteed.

**Analyzer behavior:** uses `inputs` to validate call-site argument expressions statically; uses `outputs` to validate downstream CEL expressions that access the return value (e.g. `${{ steps.MyStep.result.rows }}`).

---

## 3. Kernel Invocation Layer

Every invocable call passes through `EvaluationContext.invoke()` regardless of which topology or controller triggered it. This layer handles three cross-cutting concerns before and after the controller's `invoke()` is called:

### CEL expansion

Call-site `inputs` are CEL expressions. The kernel expands them against the current evaluation context before passing the resolved values to the controller. The controller receives plain values, never raw CEL strings.

### Retry

A `retry` policy may be specified at the call site. The kernel wraps `instance.invoke()` and retries on failure according to the policy before propagating the error.

```yaml
invoke: { kind: Http.Request, name: Api }
inputs:
  url: "${{ vars.endpoint }}"
retry:
  attempts: 3
  delay: 2000
  backoff: exponential
  when: "${{ error.code == 429 || error.code >= 500 }}"
```

| Field      | Required | Description                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `attempts` | yes      | Maximum number of attempts including the first                                 |
| `delay`    | no       | Milliseconds to wait between attempts (default: 0)                             |
| `backoff`  | no       | `linear` or `exponential`; multiplies `delay` each attempt (default: `linear`) |
| `when`     | no       | CEL boolean; retries only when true, propagates immediately otherwise          |

`retry.when` receives an `error` variable with `message`, `code`, and `step` fields. When absent, all failures are retried up to `attempts`.

### Event emission

After a successful invocation the kernel emits a `<Kind>.<Name>.Invoked` event carrying the outputs. This happens regardless of topology.

---

## 4. Call-Site Invocation

The call-site is where a specific invocable is called within a topology (a sequence step, a router handler, an agent tool, a workflow node). The call-site supplies:

| Field    | Description                                                               |
| -------- | ------------------------------------------------------------------------- |
| `invoke` | Reference to the invocable resource (`kind` + `name`)                     |
| `inputs` | CEL expressions producing the actual argument values (expanded by kernel) |
| `retry`  | Optional retry policy applied by the kernel (see §3)                      |

`inputs` and `retry` are call-site concerns handled by the kernel invocation layer — they are not topology-specific and work identically in any context where an invocable is called.

---

## 5. Naming Disambiguation

`inputs` appears in two distinct contexts with different meanings:

| Context                                  | Meaning                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `Kernel.Definition inputs`               | JSON Schema — the _type_ of arguments the invocable accepts |
| Call-site `inputs` (step, handler, tool) | CEL expressions — the _values_ passed at this specific call |

The definition `inputs` schema is authored once on the type. Call-site `inputs` are authored at every place the invocable is called.
