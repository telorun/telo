# Topology: Sequence

An ordered, nestable tree of steps. Each step either invokes an invocable or applies a control flow operation (`if`, `while`, `switch`) that contains nested child steps.

## Step Types

A step is exactly one of the following variants, distinguished by which key is present:

### Invoke

Calls an invocable resource. Outputs are available to subsequent steps via CEL.

```yaml
- name: FetchUser
  invoke:
    kind: Sql.Read
    name: UserQuery
  inputs:
    id: "${{ vars.userId }}"

- name: SendWelcomeEmail
  when: "${{ steps.FetchUser.result.isNew }}"
  invoke: { kind: Http.Request, name: Mailer }
  inputs:
    to: "${{ steps.FetchUser.result.email }}"
```

| Field    | Required | Description                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------------ |
| `name`   | yes      | Unique step name; used to reference outputs in later steps                           |
| `invoke` | yes      | Invocable reference (kind + resource name)                                           |
| `inputs` | no       | CEL expressions producing argument values — expanded by kernel (see invocable.md §3) |
| `retry`  | no       | Retry policy applied by kernel on failure (see invocable.md §3)                      |
| `when`   | no       | CEL boolean guard; step is skipped (not failed) when false                           |

### If

Conditional branch. Evaluates a CEL boolean; executes `then` steps on true, `else` steps (if present) on false.

```yaml
- name: CheckVerified
  if: "${{ steps.FetchUser.result.verified }}"
  then:
    - name: ProcessPayment
      invoke: { kind: Payment.Process, name: Processor }
  else:
    - name: RejectRequest
      invoke: { kind: Payment.Reject, name: Rejecter }
```

| Field  | Required | Description                               |
| ------ | -------- | ----------------------------------------- |
| `name` | yes      | Step name                                 |
| `if`   | yes      | CEL boolean expression                    |
| `then` | yes      | Child steps executed when condition true  |
| `else` | no       | Child steps executed when condition false |

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
| `when`    | no       | CEL boolean guard; skips entire try block when false               |
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
- For `invoke` steps: if `when` is present and evaluates to false, skips the step without error and continues. Otherwise calls the invocable, stores result under the step name, makes it available via CEL.
- For `if` steps: evaluates the condition, executes the matching branch, halts on first step failure within the branch.
- For `while` steps: re-evaluates the condition before each iteration; exits when false.
- For `switch` steps: evaluates the expression, executes the first matching case, falls back to `default` if present, returns an error if no match and no default.
- Halts the entire sequence on the first unhandled step failure.

## Analyzer Behavior

- Validates `invoke` references resolve to existing invocable resources.
- Validates step name uniqueness across the entire tree (including nested steps).
- Validates CEL expressions in `inputs`, `when`, `if`, `while`, and `switch` only reference steps that precede the current step in execution order — no forward references.
- Validates `then`, `else`, `do`, `cases`, and `default` recursively using the same rules.

## Editor Behavior

Activates the step tree sub-editor: a vertically stacked, hierarchical list. Control flow steps are collapsible and render child steps with indentation.

```
┌──────────────────────────────────────────────┐
│ 1. FetchUser                  Sql.Read      ⠿ │
└──────────────────────────────────────────────┘
              ↓
┌──────────────────────────────────────────────┐
│ 2. ◇ if: user.verified                      ⠿ │
│   ├── then                                    │
│   │    3. ProcessPayment   Payment.Process    │
│   └── else                                    │
│        3. RejectRequest   Payment.Reject      │
└──────────────────────────────────────────────┘
              ↓
┌──────────────────────────────────────────────┐
│ 4. Notify                  Http.Client      ⠿ │
└──────────────────────────────────────────────┘

[+ Add step]
```

- `⠿` drag handle for reordering (top-level steps only).
- Control flow step cards show: index, name, type symbol (`◇` for if/switch, `↻` for while), and the condition expression.
- Invoke step cards show: index, name, invocable kind and resource name.
- Clicking a card selects it — the detail panel opens with that step's fields.

## Role Annotations

| Role     | Required | Description                                                                     |
| -------- | -------- | ------------------------------------------------------------------------------- |
| `steps`  | yes      | The top-level ordered array of step entries                                     |
| `invoke` | yes      | The invocable reference field on each invoke-type step entry                    |
| `inputs` | no       | CEL input mapping on each invoke step, evaluated against preceding step results |

Control flow fields (`if`, `while`, `switch`, `then`, `else`, `do`, `cases`, `default`) and the `when` guard are built into the topology and do not require role annotations — the kernel and editor recognize them by name on any step entry.

## Example Definition

```yaml
kind: Kernel.Definition
metadata: { name: Steps, module: Job }
capability: Runnable
topology: Sequence
schema:
  type: object
  properties:
    steps:
      x-telo-topology-role: steps
      type: array
      items:
        type: object
        properties:
          name: { type: string }
          invoke:
            x-telo-topology-role: invoke
            x-telo-ref: Kernel.Invocable
          inputs:
            x-telo-topology-role: inputs
            type: object
          when: { type: string }
          if: { type: string }
          then: { $ref: "#/properties/steps" }
          else: { $ref: "#/properties/steps" }
          while: { type: string }
          do: { $ref: "#/properties/steps" }
          switch: { type: string }
          cases:
            type: object
            additionalProperties: { $ref: "#/properties/steps" }
          default: { $ref: "#/properties/steps" }
```

## Comprehensive Example

Covers all step types (`invoke`, `if`, `while`, `switch`) with `when` guards and three levels of nesting.

```yaml
kind: Pipeline.Job
metadata:
  name: ProcessOrder
  module: MyApp
steps:
  # Level 1 — plain invoke
  - name: FetchOrder
    invoke: { kind: Sql.Read, name: OrderQuery }
    inputs:
      id: "${{ vars.orderId }}"

  # Level 1 — guarded invoke (skipped if order already processed)
  - name: LogReceived
    when: "${{ !steps.FetchOrder.result.alreadyProcessed }}"
    invoke: { kind: Console.Log, name: Logger }
    inputs:
      message: "Processing order ${{ vars.orderId }}"

  # Level 1 — switch on order type
  - name: RouteByType
    switch: "${{ steps.FetchOrder.result.type }}"
    cases:
      digital:
        # Level 2 — if inside switch case
        - name: CheckLicense
          if: "${{ steps.FetchOrder.result.requiresLicense }}"
          then:
            # Level 3 — invoke inside if/then
            - name: IssueLicense
              invoke: { kind: Http.Request, name: LicenseApi }
              inputs:
                userId: "${{ steps.FetchOrder.result.userId }}"
            - name: EmailLicense
              when: "${{ steps.IssueLicense.result.ok }}"
              invoke: { kind: Http.Request, name: Mailer }
              inputs:
                to: "${{ steps.FetchOrder.result.email }}"
                key: "${{ steps.IssueLicense.result.key }}"
          else:
            # Level 3 — plain invoke inside if/else
            - name: SendDownloadLink
              invoke: { kind: Http.Request, name: Mailer }
              inputs:
                to: "${{ steps.FetchOrder.result.email }}"

      physical:
        # Level 2 — while inside switch case (poll fulfillment)
        - name: PollFulfillment
          while: "${{ steps.CheckFulfillment.result.status == 'pending' }}"
          do:
            # Level 3 — invoke inside while
            - name: CheckFulfillment
              invoke: { kind: Http.Request, name: FulfillmentApi }
              inputs:
                orderId: "${{ vars.orderId }}"
            - name: WaitBeforeRetry
              when: "${{ steps.CheckFulfillment.result.status == 'pending' }}"
              invoke: { kind: Flow.Sleep, name: Delay }
              inputs:
                ms: 5000

        - name: NotifyShipped
          invoke: { kind: Http.Request, name: Mailer }
          inputs:
            to: "${{ steps.FetchOrder.result.email }}"
            trackingId: "${{ steps.CheckFulfillment.result.trackingId }}"

    default:
      - name: RejectUnknownType
        invoke: { kind: Console.Log, name: Logger }
        inputs:
          message: "Unknown order type: ${{ steps.FetchOrder.result.type }}"

  # Level 1 — final invoke always runs
  - name: RecordAudit
    invoke: { kind: Sql.Exec, name: AuditInsert }
    inputs:
      orderId: "${{ vars.orderId }}"
      status: "completed"
```
