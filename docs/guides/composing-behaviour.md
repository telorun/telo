---
description: "Orchestrate work declaratively with Run.Sequence, Run.Choice and Run.Value: steps, branching, loops, error handling, and when a script is genuinely the right answer."
---

# Composing behaviour

A handler that returns one value is `Run.Value`. Everything beyond that —
calling several things in order, branching, looping, handling failure — is
`Run.Sequence` and its siblings in the `run` module.

```yaml
imports:
  Run: oci://ghcr.io/telorun/run@<version>
```

A sequence is a `Telo.Runnable`, so it fits anywhere a runnable does: an
application's `targets:`, an HTTP route's `handler:`, another sequence's step.

## The shape of a sequence

```yaml
kind: Run.Sequence
metadata:
  name: PlaceOrder
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      cartId: { type: string }
    required: [cartId]
steps:
  - name: LoadCart
    invoke: !ref GetCart
    inputs:
      id: !cel "inputs.cartId"
  - name: Charge
    invoke: !ref PaymentGateway
    inputs:
      amount: !cel "steps.LoadCart.result.total"
outputs:
  orderId: !cel "steps.Charge.result.id"
```

Four parts, and only `steps:` is required:

- **`inputType:`** — the call contract. Callers supply values; the body reads
  them as `!cel "inputs.<name>"`. Declared defaults are filled and every call is
  validated before dispatch.
- **`steps:`** — the ordered body. Every step has a `name`, and its result is
  visible to later steps as `!cel "steps.<name>.result"`.
- **`outputs:`** — a CEL map turning step results into what the caller sees.
  Omit it and the caller gets the raw map of step results.
- **`outputType:`** — the result contract. Declaring it types
  `steps.<name>.result` for *your* callers and has the produced value validated
  at dispatch.

One consequence worth knowing early: a sequence whose `inputType` has required
fields **cannot be a boot target**. `targets:` starts things with `run()`, which
passes no arguments, so nothing could supply them — `telo check` reports
`CONTRACT_INPUTS_AT_RUN_SITE`. Invoke it from a step (or a route) instead.

## Step shapes

Beyond `name`, a step is exactly one of the following.

### Invoke

```yaml
- name: Charge
  invoke: !ref PaymentGateway
  inputs:
    amount: !cel "steps.LoadCart.result.total"
  retry:
    attempts: 3
    delay: 200ms
```

`invoke:` takes a `!ref` to an Invocable or Runnable, or an inline `{ kind, … }`
declaration. `inputs:` is a CEL-templatable map. `retry:` is optional.

### Value — compute without dispatching

```yaml
- name: Total
  value: !cel "sum(steps.LoadCart.result.lines.map(l, l.price * double(l.qty)))"
```

A step with `value:` instead of `invoke:` publishes `steps.Total.result` exactly
as an invoke step does, so nothing downstream can tell the difference — but it
dispatches nothing: no resource, no span, no topology node. Reach for it when an
intermediate is derived from an earlier step and would otherwise cost a whole
`Run.Value` resource to name. It sees the same scope as any other step,
including the enclosing kind's (`item` / `index` inside an iteration,
`iteration` / `previous` inside a loop).

For intermediates derived from `inputs:` rather than from a step, `Run.Value`
and `Run.Choice` take a `bindings:` map — see
[naming an intermediate value](/learn/refs-and-cel#naming-an-intermediate-value).

### Conditional — `if` / `elseif` / `then` / `else`

```yaml
- name: BranchOnTotal
  if: !cel "steps.LoadCart.result.total > 100"
  then:
    - name: ApplyDiscount
      invoke: !ref Discount
  elseif:
    - if: !cel "steps.LoadCart.result.total > 50"
      then:
        - name: ApplySmallDiscount
          invoke: !ref SmallDiscount
  else:
    - name: NoDiscount
      invoke: !ref Noop
```

### Loop — `while` / `do`

```yaml
- name: Poll
  while: !cel "steps.Check.result.status == 'pending'"
  do:
    - name: Check
      invoke: !ref CheckStatus
```

A do-while falls out of sharing a step name between an initializer before the
loop and the body inside it — each iteration overwrites the previous result.

### Switch — `switch` / `cases` / `default`

```yaml
- name: RouteByRole
  switch: !cel "steps.Auth.result.role"
  cases:
    admin:
      - name: AdminAction
        invoke: !ref AdminHandler
    viewer:
      - name: ViewerAction
        invoke: !ref ViewerHandler
  default:
    - name: Reject
      invoke: !ref Deny
```

### Error boundary — `try` / `catch` / `finally`

```yaml
- name: Attempt
  try:
    - name: Charge
      invoke: !ref PaymentGateway
  catch:
    - name: Compensate
      invoke: !ref ReleaseHold
      inputs:
        reason: !cel "error.message"
        failedStep: !cel "error.step"
  finally:
    - name: Audit
      invoke: !ref WriteAuditLog
      inputs:
        # `error` is NULL here on the success path — guard it, or the
        # analyzer reports CEL_NULLABLE_ACCESS
        outcome: !cel "error == null ? 'ok' : error.code"
```

Inside `catch:`, `error` carries `code`, `message`, `step`, and `data`. Inside
`finally:` it is the same value or `null`, which is why it must be guarded.

### Throw

```yaml
- name: Reject
  throw:
    code: UNAUTHORIZED
    message: "token expired"
    data:
      reason: expired
```

Raises a structured error the nearest enclosing `catch:` binds as `error`. Codes
are `SCREAMING_SNAKE_CASE` by convention.

### Guard — `when`

`when:` skips a step when the expression is false, and composes with every shape
above:

```yaml
- name: NotifyOps
  when: !cel "variables.environment == 'production'"
  invoke: !ref PagerDuty
```

## Scoped resources — `with` and `targets`

Some resources should exist only for the duration of a run — a server to test
against, a connection to hold open across steps. `with:` declares them inline;
they are created when the sequence starts and torn down when it ends. `targets:`
names which of them to `run()` first:

```yaml
kind: Run.Sequence
metadata:
  name: CheckTheApi
with:
  - kind: Http.Server
    metadata:
      name: TempServer
    port: 8099
    mounts:
      - path: /
        mount: !ref Api
targets:
  - !ref TempServer
steps:
  - name: CallIt
    invoke: !ref Probe
```

A scoped name resolves only inside the sequence, and each run gets its own
instances — two concurrent runs never observe each other.

## The other `run` kinds

`Run.Sequence` is the general case. Reach for a narrower kind when it fits — it
says more about intent and is easier to read:

| Kind | For |
| --- | --- |
| `Run.Value` | Return a shaped value computed with CEL, naming its intermediate steps with `bindings:`. The declarative alternative to a one-line script. |
| `Run.Choice` | A first-match decision table: return the value of the first choice whose predicate holds, or a declared default. Also takes `bindings:`, shared across rows. |
| `Run.Iteration` | Run a step body once per collection element, with configurable concurrency. |
| `Run.Projection` | Map each element of a collection through a body into a result array. |
| `Run.Loop` | Repeat a body while a condition holds or up to `maxIterations`, seeing the iteration count and previous result. |
| `Run.Detach` | Dispatch something in the background and return immediately — off the caller's response path. |

Full field schemas for each are on the [hub](https://hub.telo.run/?q=Run.Sequence).

## When to reach for a script instead

`JavaScript.Script` runs inline code and is occasionally the right answer, but
the cases that used to justify it mostly have declarative forms now: arithmetic
no single expression makes readable is `bindings:` or a `value:` step, a string
transform is usually one CEL call (`regexReplace`, `split`, `parseJson`,
`base64Encode`, `sha256`, `uuidv7`, `nowIso` — see the
[CEL reference](/cel)), and branching is `Run.Choice`.

Prefer composition first: a step graph stays visible to the analyzer, the
editor, and the topology view, while the inside of a script is opaque to all
three. What genuinely remains for a script is a Node.js API the kernel does not
expose — `Buffer` and byte-level work, streams, a native library. And if you
find yourself writing a script that calls out to something, that something
probably wants to be a resource.

## See also

- [`!ref` and `!cel`](/learn/refs-and-cel) — what is in scope inside a step.
- [Testing your manifests](/build/testing) — the same grammar, driving assertions.
- [Diagnostics](/reference/diagnostics) — `UNCOVERED_THROW_CODE`,
  `CEL_NULLABLE_ACCESS`, and the rest.
