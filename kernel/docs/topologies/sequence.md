# Topology: Sequence

An ordered, nestable tree of steps. Each step either invokes an invocable or applies a control flow operation (`if`, `while`, `switch`, `try`) that contains nested child steps.

## Step Types

A step is exactly one of the following variants, distinguished by which discriminating field is present. All variants share `name` (required).

### Invoke

Calls an invocable or runnable resource. Outputs are available to subsequent steps via CEL.

```yaml
- name: FetchUser
  invoke:
    kind: Sql.Read
    name: UserQuery
  inputs:
    id: "${{ vars.userId }}"

- name: SendWelcomeEmail
  invoke: { kind: Http.Request, name: Mailer }
  inputs:
    to: "${{ steps.FetchUser.result.email }}"
```

| Field    | Required | Description                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------------ |
| `name`   | yes      | Unique step name; used to reference outputs in later steps                           |
| `invoke` | yes      | Invocable or runnable reference (kind + resource name)                               |
| `inputs` | no       | CEL expressions producing argument values — expanded by kernel (see invocable.md §3) |
| `retry`  | no       | Retry policy applied by kernel on failure (see invocable.md §3)                      |

### If

Conditional branch. Evaluates a CEL boolean; executes `then` steps on true. Optional `elseif` entries are evaluated in order when `if` is false. `else` runs when no condition matched.

```yaml
- name: CheckVerified
  if: "${{ steps.FetchUser.result.verified }}"
  then:
    - name: ProcessPayment
      invoke: { kind: Payment.Process, name: Processor }
  elseif:
    - if: "${{ steps.FetchUser.result.pending }}"
      then:
        - name: QueuePayment
          invoke: { kind: Payment.Queue, name: Queue }
  else:
    - name: RejectRequest
      invoke: { kind: Payment.Reject, name: Rejecter }
```

| Field     | Required | Description                                                              |
| --------- | -------- | ------------------------------------------------------------------------ |
| `name`    | yes      | Step name                                                                |
| `if`      | yes      | CEL boolean expression                                                   |
| `then`    | yes      | Child steps executed when `if` is true                                   |
| `elseif`  | no       | Ordered list of `{ if, then }` pairs evaluated when `if` is false        |
| `else`    | no       | Child steps executed when `if` and all `elseif` conditions are false     |

### While

Loop. Evaluates a CEL boolean before each iteration; executes `do` steps while true.

```yaml
- name: PollStatus
  while: "${{ steps.CheckStatus.result.pending }}"
  do:
    - name: CheckStatus
      invoke: { kind: Http.Request, name: StatusCheck }
    - name: Wait
      invoke: { kind: Flow.Sleep, name: Delay }
```

| Field   | Required | Description                                             |
| ------- | -------- | ------------------------------------------------------- |
| `name`  | yes      | Step name                                               |
| `while` | yes      | CEL boolean expression; evaluated before each iteration |
| `do`    | yes      | Child steps executed each iteration                     |

### Switch

Multi-branch dispatch. Evaluates a CEL expression and executes the matching case's child steps. Falls through to `default` if no case matches.

```yaml
- name: RouteByRole
  switch: "${{ steps.FetchUser.result.role }}"
  cases:
    admin:
      - name: AdminFlow
        invoke: { kind: Flow.Run, name: AdminHandler }
    viewer:
      - name: ViewerFlow
        invoke: { kind: Flow.Run, name: ViewerHandler }
  default:
    - name: Reject
      invoke: { kind: Http.Response, name: Forbidden }
```

| Field     | Required | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `name`    | yes      | Step name                                           |
| `switch`  | yes      | CEL expression; result is matched against case keys |
| `cases`   | yes      | Map of value → child steps                          |
| `default` | no       | Child steps executed when no case matches           |

### Try

Error boundary. Executes `try` steps; on failure jumps to `catch` (if present); always runs `finally` (if present) regardless of outcome.

```yaml
- name: ProcessPayment
  try:
    - name: ChargeCard
      invoke: { kind: Payment.Charge, name: Stripe }
      inputs:
        amount: "${{ steps.FetchOrder.result.total }}"
  catch:
    - name: LogFailure
      invoke: { kind: Console.Log, name: Logger }
      inputs:
        message: "${{ error.message }}"
        failedStep: "${{ error.step }}"
  finally:
    - name: RecordAttempt
      invoke: { kind: Sql.Exec, name: AuditInsert }
      inputs:
        orderId: "${{ vars.orderId }}"
        success: "${{ error == null }}"
```

| Field     | Required | Description                                                        |
| --------- | -------- | ------------------------------------------------------------------ |
| `name`    | yes      | Step name                                                          |
| `try`     | yes      | Child steps; halts on first failure and jumps to `catch`           |
| `catch`   | no       | Runs when `try` fails; receives `${{ error }}`; swallows the error |
| `finally` | no       | Always runs after `try`/`catch`; receives `${{ error }}`           |

**Error object shape:**

| Field           | Description                              |
| --------------- | ---------------------------------------- |
| `error.message` | Human-readable error description         |
| `error.code`    | Error code if available (`string\|null`) |
| `error.step`    | Name of the step that failed             |

**Execution semantics:**

- `try` succeeds → runs `finally`, sequence continues.
- `try` fails, `catch` present → runs `catch`, then `finally`; error swallowed, sequence continues.
- `try` fails, no `catch` → runs `finally`; error propagates, sequence halts.
- `catch` fails → runs `finally`; `catch` error propagates, sequence halts.
- `error` is `null` in `finally` when `try` succeeded.

## Data Passing

Each step's result is available to all subsequent steps (at any nesting level) via `${{ steps.<name>.result }}`. The kernel tracks step results in a flat namespace across the entire tree — step names must be unique within a sequence regardless of nesting depth.

CEL autocomplete in the editor is scoped to steps that precede the current step in execution order. Forward references are not offered.

When `concurrency > 1` is set on the resource, `steps.*` references are invalid and omitted from autocomplete — execution order is not guaranteed in concurrent mode.

## Kernel Behavior

- Executes steps in declaration order.
- For `invoke` steps: calls the invocable, stores result under the step name, makes it available via CEL.
- For `if` steps: evaluates `if`; on true executes `then`. On false evaluates each `elseif` condition in order, executing the first matching `then`. If no condition matched and `else` is present, executes `else`.
- For `while` steps: re-evaluates the condition before each iteration; exits when false.
- For `switch` steps: evaluates the expression, executes the first matching case, falls back to `default` if present, returns an error if no match and no default.
- Halts the entire sequence on the first unhandled step failure.

## Analyzer Behavior

- Validates `invoke` references resolve to existing invocable or runnable resources.
- Validates step name uniqueness across the entire tree (including nested steps).
- Validates CEL expressions in `inputs`, `if`, `elseif[*].if`, `while`, and `switch` only reference steps that precede the current step in execution order — no forward references.
- Enforces boolean type on `predicate`-role fields (`if`, `while`, `elseif[*].if`); allows any type on `discriminator`-role fields (`switch`).
- Validates `then`, `elseif`, `else`, `do`, `cases`, `default`, `try`, `catch`, `finally` recursively using the same rules.

## Editor Behavior

Activates the step tree canvas: a vertically stacked, hierarchical list. The canvas derives all structural knowledge from `x-telo-topology-role` annotations — no step field names are hardcoded in the editor.

**Step variant detection:** the canvas matches each step against the `oneOf` variants in the schema by checking which variant's `required` fields are present. Once the variant is identified, role annotations on that variant's properties drive all rendering decisions.

**Detail panel:** when a step is selected, `branch` and `branch-list` role fields are excluded from the detail panel form — they are managed by the canvas, not edited as raw values.

```
┌──────────────────────────────────────────────┐
│ 1. FetchUser                  Sql.Read      ⠿ │
└──────────────────────────────────────────────┘
              ↓
┌──────────────────────────────────────────────┐
│ 2. ◇ if: user.verified                      ⠿ │
│   ├── then                                    │
│   │    3. ProcessPayment   Payment.Process    │
│   ├── elseif: user.pending                    │
│   │    4. QueuePayment     Payment.Queue      │
│   └── else                                    │
│        5. RejectRequest   Payment.Reject      │
└──────────────────────────────────────────────┘
              ↓
┌──────────────────────────────────────────────┐
│ 6. Notify                  Http.Client      ⠿ │
└──────────────────────────────────────────────┘

[+ Add step]
```

- `⠿` drag handle for reordering (top-level steps only).
- Control flow step cards show the `predicate`-role field value as the condition expression, or the `discriminator`-role field value for switch steps.
- Invoke step cards show the `invoke`-role field as the target reference.
- `branch` fields render as inline labeled containers within the step card.
- `branch-list` fields (elseif) render as an ordered list of collapsible condition+container pairs.
- Clicking a card selects it — the detail panel opens with that step's non-topology fields.

## Role Annotations

| Role            | Required | Cardinality     | Description                                                                 |
| --------------- | -------- | --------------- | --------------------------------------------------------------------------- |
| `steps`         | yes      | one             | The top-level ordered array of step entries                                 |
| `invoke`        | yes*     | one per variant | The invocable/runnable reference field on invoke-type steps                 |
| `inputs`        | no       | one per variant | CEL input mapping on invoke steps                                           |
| `predicate`     | yes*     | one per variant | CEL boolean expression driving if/while control flow; editor shows condition builder |
| `discriminator` | yes*     | one per variant | CEL value expression matched against case keys; editor shows plain input    |
| `branch`        | no       | many            | Sequential child-steps array; canvas-owned, hidden from detail panel        |
| `case-map`      | no       | one per variant | Map of string key → child-steps array; canvas enumerates keys as branches   |
| `branch-list`   | no       | one per variant | Ordered list of `{ predicate, branch }` pairs (elseif chains)               |

\* required on the specific variant that uses it, not globally.

## Example Definition

```yaml
kind: Kernel.Definition
metadata: { name: Sequence, module: Run }
capability: Kernel.Runnable
topology: Sequence
controllers:
  - pkg:npm/@telorun/run@0.1.1#sequence
schema:
  type: object
  $defs:
    step:
      type: object
      properties:
        name: { type: string }
      oneOf:
        - properties:
            invoke:
              x-telo-topology-role: invoke
              x-telo-ref: "kernel#Invocable"
            inputs:
              x-telo-topology-role: inputs
              type: object

        - properties:
            if:
              x-telo-topology-role: predicate
              type: boolean
            elseif:
              x-telo-topology-role: branch-list
              type: array
              items:
                type: object
                properties:
                  if:   { x-telo-topology-role: predicate, type: boolean }
                  then: { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
                required: [if, then]
            then: { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
            else: { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
          required: [if, then]

        - properties:
            while: { x-telo-topology-role: predicate,     type: boolean }
            do:    { x-telo-topology-role: branch,        type: array, items: { $ref: "#/$defs/step" } }
          required: [while, do]

        - properties:
            switch:  { x-telo-topology-role: discriminator, type: string }
            cases:   { x-telo-topology-role: case-map,      type: object,
                       additionalProperties: { type: array, items: { $ref: "#/$defs/step" } } }
            default: { x-telo-topology-role: branch,        type: array, items: { $ref: "#/$defs/step" } }
          required: [switch, cases]

        - properties:
            try:     { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
            catch:   { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
            finally: { x-telo-topology-role: branch, type: array, items: { $ref: "#/$defs/step" } }
          required: [try]
      required: [name]

  properties:
    steps:
      x-telo-topology-role: steps
      type: array
      items: { $ref: "#/$defs/step" }
  required: [steps]
```
