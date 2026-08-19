---
"@telorun/analyzer": minor
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Durable execution: the replay seam, the normative contract, and the step engine's journaling.

`@telorun/sdk` gains `DurableRunHandle` — `step(path, target, inputs, execute)`, `decide(path, kind, compute)`, `park`, and the `writesInside(zone)` question — plus `stepPath` and the collapse rule. The handle rides `InvokeContext.durable`, which the kernel carries and never calls: it is a pure conduit, so a backend is an ordinary module and this member deliberately does not cross the ABI.

`step` mediates execution rather than merely recording it. Lookup-plus-record is a leaky decomposition — two halves of one operation, split so the CALLER performs the effect in between — which silently fixes the step engine and the resource graph in one process. Where an effect executes is a real architectural axis, so `step` takes a declaration-site target identity even though the local backend resolves it in process.

The step engine now journals its DECISIONS, not only its outcomes: resolved inputs, predicates, loop conditions, switch keys and pure value steps. A run's replay-closed state is its journal, which is what makes replay a pure function of `(journal, manifest)` — recording only outcomes would leave every decision re-derived in a fresh process from a scope carrying live readings.

The analyzer gains `validate-durable-regions`: `DURABLE_DETACH_FORBIDDEN`, `DURABLE_NONDETERMINISM` (keyed on `idempotent`, where it states something true) and `DURABLE_UNJOURNALABLE_RESULT`. All are consumers of the one containment walk, parameterized over a zone attribute, so no kind is named in analyzer code.

Normative contract: `kernel/specs/durable-execution.md`.
