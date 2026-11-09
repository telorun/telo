---
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

`telo check` warns when a step inside a `replayed` region targets a kind with no declared `outputType` (`DURABLE_CONTRACT_REQUIRED`; a step in an `idempotent` region and a target whose result is typed from its own `outputs:` are exempt). The SDK's step engine can resume a durable body from a baseline: `DurableRunHandle` gains an optional `baseline(capture, completed)` and `executeSteps` an optional `durableBody` argument, so a run's journal can be compacted at a step boundary of the workflow's own steps.
