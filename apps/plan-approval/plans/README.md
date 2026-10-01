# Plan approval plans

The data and operations of the [plan-approval server](../README.md):
the SQLite schema and every operation its routes call, as exported invocables
over a SQLite connection the importer lends it. The server imports it as
`Plans`; the HTTP surface, its codes and the state machine are documented in the
server's README.

```yaml
imports:
  Plans:
    source: ./plans
    resources:
      connection: !ref db          # a SQLite.Connection
    variables:
      longPollCap: !cel "variables.longPollCap"
```

## Inputs

| Name | Kind | Meaning |
| --- | --- | --- |
| `connection` (resource) | `SQLite.Connection` | Where every table lives. Borrowed, never closed. |
| `longPollCap` (variable) | `Telo.Duration` | The longest a long poll (`planEvents`, `commandFeed`) holds a call, whatever its `wait` asks for. |

## Exports

| Resource | What it does |
| --- | --- |
| `schema` | The `SQLite.Schema`: run it first (the server lists it in `targets:`). |
| `flushOutbox` | One webhook relay tick: sends up to four due deliveries (10s timeout), records every attempt, delays a failed one 5s × 2^(attempts−1), at most 128×. |
| `createProduct`, `listProducts`, `updateProduct`, `productHistory` | Products, their deadlines, webhooks and delivery attempts. |
| `createRepo`, `listRepos` | Repositories and the products they belong to. |
| `submitPlan`, `revisePlan`, `withdrawPlan`, `reportPlan`, `upsertLink` | The agent's writes. |
| `agentPlan`, `planEvents` | The agent's reads; `planEvents` is the per-plan long poll. |
| `listPlans`, `planDetail`, `planHistory`, `commentPlan`, `decidePlan` | The reviewer's reads and writes. |
| `reportRunner`, `commandFeed`, `commandOutcome` | The runner protocol, typed with [PlanApprovalRunnerProtocol](../../plan-approval-runner-protocol/README.md)'s shapes. A report and a start's `done` outcome make sessions the runner's by one rule, which also writes the wakes their plans owed. |
| `listRunners`, `runnerSessions`, `runnerCommands`, `createRunnerCommand` | The reviewer's view of runners, and start / stop. |

Every state-changing operation checks its preconditions and writes in one
transaction, throwing a structured code (`ERR_PLAN_NOT_FOUND`,
`ERR_STALE_BASE`, `ERR_INVALID_TRANSITION`, …) from inside it so the write rolls
back; after the commit it publishes the plan's (`plan:<id>`) or runner's
(`runner:<name>`) new cursor so waiting long polls answer at once. Where an
operation takes an optional value, its input contract names the "absent" value
explicitly (`""`, `-1` or `0`).

Nothing is ever deleted: the histories are complete.
