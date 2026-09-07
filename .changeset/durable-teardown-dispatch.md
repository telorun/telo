---
"@telorun/kernel": minor
---

A dispatch that misses because the runtime withdrew the resource is reported as a cancellation (`ERR_INVOKE_CANCELLED`) rather than as a missing resource.

An unwind removes each instance as it goes, so work still in flight — a detached task the kernel waited for and then abandoned above all, since its ambient scope is the uncancellable root and nothing else ever tells it to stop — found an emptying map and was told its target did not exist. That verdict is durable where the withdrawal is not: a durable run recorded it as a run failure, which is terminal, so one ordinary interruption left a run id nothing would ever pick up again — from the one feature whose whole purpose is surviving that.

Both ways a resource is withdrawn are covered, because they are the same failure and only one of them is a shutdown: teardown moves the context's state, while the partial unwind a reconciliation performs deliberately does not — so the verdict is keyed on the recorded withdrawal at the single removal site, not on the state. The reconciliation path is the one a watch session takes on every save. The mark is cleared when the name is registered again, so a genuine missing-resource defect is still reported as one.

Only the miss is converted; a resource still in the map is dispatched as before, because a teardown-time flush is legitimate work. It is announced with the same scoped `InvokeCancelled` event every other cancellation carries. Every consumer already handles a cancellation correctly, so nothing downstream changes: a durable body leaves the run `running` for the resumer, and a step's retry budget is not spent re-issuing a call nobody intends to answer.
