---
description: "Orchestrate work declaratively with Telo.Sequence, Telo.Value and Run.Choice: steps, branching, loops, error handling, and when a script is genuinely the right answer."
---

# Composing behaviour

A handler that returns one value is `Telo.Value`. Everything beyond that —
calling several things in order, branching, looping, handling failure — is
`Telo.Sequence`. Both are built-in kinds that need no import; their siblings
live in the `run` module.

A sequence is a `Telo.Runnable`, so it fits anywhere a runnable does: an
application's `targets:`, an HTTP route's `handler:`, another sequence's step.

## The shape of a sequence

```yaml
kind: Telo.Sequence
metadata:
  name: placeOrder
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      cartId: { type: string }
    required: [cartId]
steps:
  - name: loadCart
    invoke: !ref getCart
    inputs:
      id: !cel "inputs.cartId"
  - name: charge
    invoke: !ref paymentGateway
    inputs:
      amount: !cel "steps.loadCart.result.total"
outputs:
  orderId: !cel "steps.charge.result.id"
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
- name: charge
  invoke: !ref paymentGateway
  inputs:
    amount: !cel "steps.loadCart.result.total"
  retry:
    attempts: 3
    delay: 200ms
```

`invoke:` takes a `!ref` to an Invocable or Runnable, or an inline `{ kind, … }`
declaration. `inputs:` is a CEL-templatable map. `retry:` is optional.

### Value — compute without dispatching

```yaml
- name: total
  value: !cel "sum(steps.loadCart.result.lines.map(l, l.price * double(l.qty)))"
```

A step with `value:` instead of `invoke:` publishes `steps.total.result` exactly
as an invoke step does, so nothing downstream can tell the difference — but it
dispatches nothing: no resource, no span, no topology node. Reach for it when an
intermediate is derived from an earlier step and would otherwise cost a whole
`Telo.Value` resource to name. It sees the same scope as any other step,
including the enclosing kind's (`item` / `index` inside an iteration,
`iteration` / `previous` inside a loop).

For intermediates derived from `inputs:` rather than from a step, `Telo.Value`
and `Run.Choice` take a `bindings:` map — see
[Naming intermediate values](#naming-intermediate-values).

### Conditional — `if` / `elseif` / `then` / `else`

```yaml
- name: branchOnTotal
  if: !cel "steps.loadCart.result.total > 100"
  then:
    - name: applyDiscount
      invoke: !ref discount
  elseif:
    - if: !cel "steps.loadCart.result.total > 50"
      then:
        - name: applySmallDiscount
          invoke: !ref smallDiscount
  else:
    - name: noDiscount
      invoke: !ref noop
```

### Loop — `while` / `do`

```yaml
- name: poll
  while: !cel "steps.check.result.status == 'pending'"
  do:
    - name: check
      invoke: !ref checkStatus
```

A do-while falls out of sharing a step name between an initializer before the
loop and the body inside it — each iteration overwrites the previous result.

### Switch — `switch` / `cases` / `default`

```yaml
- name: routeByRole
  switch: !cel "steps.auth.result.role"
  cases:
    admin:
      - name: adminAction
        invoke: !ref adminHandler
    viewer:
      - name: viewerAction
        invoke: !ref viewerHandler
  default:
    - name: reject
      invoke: !ref deny
```

### Error boundary — `try` / `catch` / `finally`

```yaml
- name: attempt
  try:
    - name: charge
      invoke: !ref paymentGateway
  catch:
    - name: compensate
      invoke: !ref releaseHold
      inputs:
        reason: !cel "error.message"
        failedStep: !cel "error.step"
  finally:
    - name: audit
      invoke: !ref writeAuditLog
      inputs:
        # `error` is NULL here on the success path — guard it, or the
        # analyzer reports CEL_NULLABLE_ACCESS
        outcome: !cel "error == null ? 'ok' : error.code"
```

Inside `catch:`, `error` carries `code`, `message`, `step`, and `data`. Inside
`finally:` it is the same value or `null`, which is why it must be guarded.

### Throw

```yaml
- name: reject
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
- name: notifyOps
  when: !cel "variables.environment == 'production'"
  invoke: !ref pagerDuty
```

## Scoped resources — `with` and `targets`

Some resources should exist only for the duration of a run — a server to test
against, a connection to hold open across steps. `with:` declares them inline;
they are created when the sequence starts and torn down when it ends. `targets:`
names which of them to `run()` first:

```yaml
kind: Telo.Sequence
metadata:
  name: checkTheApi
with:
  - kind: Http.Server
    metadata:
      name: tempServer
    listen:
      port: 8099
    mounts:
      - path: /
        mount: !ref api
targets:
  - !ref tempServer
steps:
  - name: callIt
    invoke: !ref probe
```

A scoped name resolves only inside the sequence, and each run gets its own
instances — two concurrent runs never observe each other.

A scoped resource's creation-time fields read `inputs` — the inputs of the call
that started this run, typed by the sequence's `inputType` — so a value that
belongs to one call (a caller's API key, an endpoint, a tenant) configures a
resource that lives for that call only: `key: !cel "inputs.apiKey"` on a scoped
credential. A run started by `run()` reads the contract's defaults. An input the
contract marks `x-telo-sensitive` is redacted wherever that run's resources
surface — their configuration, logs and trace payloads. Details:
`modules/run/README.md`.

A scope lives until the streams leaving it settle: a sequence may return a scoped
resource's stream (a model's streamed reply), map it through a module-level stage,
or hand it to `Run.Detach`, and the resource stays alive until the stream is read to
its end, fails, or is cancelled by its reader. A stream the caller does not read —
a route reading only `result.usage` beside a streamed `output` — is cancelled when
the call that received it ends, and the scope is torn down then.

An inline step target (`invoke: { kind: … }`) is created where the sequence is,
not in its scope, so nothing inside it can name a `with:` resource: `telo check`
reports a `!ref` as `SCOPED_NAME_OUT_OF_REACH` and a `resources.<name>` read in
its CEL as `CEL_UNKNOWN_FIELD`, each saying why. Give that target a name under
`with:` and invoke it with `!ref`. An inline entry in `targets:` is the other way round: it is created
in the scope, since that is where a target runs.

## `Telo.Value` — return a shaped value

`Telo.Value` is a built-in `Telo.Invocable` whose result is a CEL expression — or a structure with CEL leaves, or a plain constant — evaluated over the caller's `inputs`. It is how a handler **shapes a value**: string concatenation, field mapping, arithmetic, or returning a fixed literal. No I/O, no branching, no Node API — those belong in `Run.Choice`, a `Telo.Sequence`, or a purpose-built resource kind.

```yaml
kind: Telo.Value
metadata: { name: makeId }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      seed: { type: string }
value:
  documentId: !cel "'drawings/' + inputs.seed + '.png'"
```

| Field | Purpose |
| --- | --- |
| `inputType` | The input **contract** — a `Telo.JsonSchema` shape, a named type reference, or an inline schema. `value` reads the values as `!cel "inputs.<name>"`. Optional — a constant needs none. |
| `outputType` | The result contract. `value` is checked against it statically by `telo check`, and the result at every call. |
| `bindings` | Optional named intermediate values, readable by bare name inside `value` and by each other — see below. |
| `value` | Required. A CEL expression, a structure (map / array) with CEL leaves, or a plain literal; the result may be any shape. |

`value` can be a plain literal — useful for fixtures and stub tools:

```yaml
kind: Telo.Value
metadata: { name: snapshot }
value:
  - { type: text, text: page rendered }
  - { type: image, data: aGVsbG8=, mediaType: image/png }
```

Because it is a plain `Telo.Invocable`, it composes anywhere an invocable is accepted — an `Ai.Tools` entry, a `Telo.Sequence` step, an `Http.Api` handler.

**Numbers: int vs double.** CEL does not implicitly promote between integers and doubles. A number nothing declares as an integer — an argument a contract leaves untyped — arrives as a double, so multiplying it by an integer literal fails with `no overload of "*" takes (double, int)`. Use a double literal, or `double(...)`. A value declared `type: integer`, and an integral number written literally in a parent step's `value:`, is already an int.

**When not to use it.** `value` is pure CEL, which already covers `parseJson`, `base64Encode`, `sha256`, `uuidv7`, `nowIso`, `regexGroups`, `sum`, `sort`, `flatten` and more. Branching is `Run.Choice`, mapping is `Run.Projection`, aggregation lives in the `collection` module. What is left for a dedicated resource kind is a Node.js API the kernel does not expose: `fetch`, `Buffer`, streams, a native library.

`Run.Value` is the deprecated twin: it behaves identically and reports `DEPRECATED_KIND` naming `Telo.Value`. `Telo.Value`'s schema is closed, unlike `Run.Value`'s: an undeclared key is refused, so switching a `Run.Value` that carries a stray key means removing that key.

## Naming intermediate values

A calculation with intermediate values does not need a resource each — four derived values would otherwise be four invocables chained through a sequence: four dispatches, four spans, four names in module scope, for arithmetic. Two constructs close that, one per place the intermediates live.

### `bindings:` — inside a pure expression kind

`Telo.Value` and `Run.Choice` take an optional `bindings:` map. Each entry names a value; every name is then readable **by bare name** inside the kind's expressions and inside the other bindings.

```yaml
kind: Telo.Value
metadata: { name: priceLine }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [qty, unitPrice, discountRate, taxRate]
    properties:
      qty: { type: number }
      unitPrice: { type: number }
      discountRate: { type: number }
      taxRate: { type: number }
bindings:
  net: !cel "gross - discount"
  gross: !cel "inputs.qty * inputs.unitPrice"
  discount: !cel "gross * inputs.discountRate"
value:
  net: !cel "net"
  tax: !cel "net * inputs.taxRate"
```

**Order is derived, not declared.** `net` is written first and reads two bindings declared after it; what orders them is the references. That is why `bindings:` is a map and `steps:` is a list — a map says order carries no meaning, so reordering rows (or an editor rewriting them) can never change behaviour. A binding that reaches itself, directly or through others, is a `BINDING_CYCLE` error at `telo check`.

**Evaluation is lazy and memoised per call.** A binding is computed on first read, at most once; one nothing reads is never computed. That makes a binding exactly equivalent to inlining its expression at each use site. It matters most in a decision table:

```yaml
kind: Run.Choice
metadata: { name: shippingTier }
bindings:
  weight: !cel "sum(inputs.items.map(i, i.grams)) / 1000.0"
choices:
  - when: !cel "weight > 30.0"
    value: { tier: freight }
  - when: !cel "weight > 2.0"
    value: { tier: parcel }
default:
  value: { tier: letter }
```

`weight` is computed once for the whole call however many rows read it — and not at all if no row that runs needs it.

**Names may not shadow the scope.** A binding named `inputs`, `resources`, `variables`, `secrets`, `ports`, `steps` or `error` is a `BINDING_NAME_RESERVED` error: at runtime a scope variable always wins, so such a binding would silently never be read.

**Types flow where they can.** A binding whose expression is a plain path into a typed value (`inputs.order`) carries that value's schema, so `order.<typo>` under it is a `CEL_UNKNOWN_FIELD`. Anything else — arithmetic, a call, a comprehension — is left open rather than guessed.

### A pure step — inside a sequence or a body

Bindings are evaluated before any step runs, so they cannot see `steps.*`. For an intermediate derived from a step's result, use the `value:` step shape above. Its result is typed permissively — there is no dispatch target whose contract could describe it — so read it into a step whose `inputType` declares the shape when you want it checked.

| You need | Use |
| --- | --- |
| An intermediate inside `Telo.Value` / `Run.Choice` | `bindings:` |
| A value shared by several decision rows | `bindings:` |
| An intermediate derived from a step's result | a `value:` step |
| A value used once, in one expression | neither — write it inline |

## The other `run` kinds

`Telo.Sequence` and `Telo.Value` are the built-in cases. Reach for a narrower kind when it fits — it
says more about intent and is easier to read:

| Kind | For |
| --- | --- |
| `Run.Choice` | A first-match decision table: return the value of the first choice whose predicate holds, or a declared default. Also takes `bindings:`, shared across rows. |
| `Run.Iteration` | Run a step body once per collection element, with configurable concurrency. |
| `Run.Projection` | Map each element of a collection through a body into a result array. |
| `Run.Loop` | Repeat a body while a condition holds or up to `maxIterations`, seeing the iteration count and previous result. |
| `Run.Detach` | Dispatch something in the background and return immediately — off the caller's response path. |

Full field schemas for each are on the [hub](https://hub.telo.run/module/oci/ghcr.io/telorun/run/).

## Scripts are deprecated

`JavaScript.Script` is deprecated: it still runs, and declaring one reports a
`DEPRECATED_KIND` warning at its `kind:` line. A body of JavaScript is opaque to
the analyzer, the editor and the topology view, so there is no single successor —
what replaces a script depends on what it does:

- **Shaping a value, branching, iterating** — the step grammar on this page:
  arithmetic no single expression makes readable is `bindings:` or a `value:`
  step, a string transform is usually one CEL call (`regexReplace`, `split`,
  `parseJson`, `base64Encode`, `sha256`, `uuidv7`, `nowIso` — see the
  [CEL reference](/cel)), and branching is `Run.Choice`.
- **Reaching an API nothing else exposes** — `Buffer` and byte-level work,
  streams, a native library — is a new resource kind with a controller of its
  own, which the analyzer and editor can see.

## See also

- [`!ref` and `!cel`](/learn/refs-and-cel) — what is in scope inside a step.
- [Durable execution](/learn/durable-execution) — the same step grammar, recorded
  so a crash and a restart continue where the work stopped.
- [Testing your manifests](/build/testing) — the same grammar, driving assertions.
- [Diagnostics](/reference/diagnostics) — `UNCOVERED_THROW_CODE`,
  `CEL_NULLABLE_ACCESS`, and the rest.
