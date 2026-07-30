---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
---

Init failures now report the root cause instead of the whole cascade.

When a resource fails to initialize, every resource downstream of it is unfinished too, and the multi-pass init loop used to report all of them flat — shadows first, since a resource that never got created was listed before one whose `init()` threw. A ten-resource chain printed one actionable line buried under nine repetitions of it.

The kernel now classifies the failure set before raising `ERR_RESOURCE_INITIALIZATION_FAILED`. An entry is **derived** — collapsible — only when it carries `ERR_LOCAL_REF_PENDING` or `ERR_CROSS_MODULE_REF_PENDING`: a deferral, which says the resource never ran and so has nothing of its own to report. A reference edge into the failure set is **attribution only**, never grounds for collapsing: it proves an edge exists, not that this entry's failure came from it, so a resource that references a failed dependency *and* fails its own validation keeps its line. `RuntimeDiagnostic` gains `derived` and `blockedBy` — the **root** of the chain, not the immediate blocker, since that is the name to go fix. If no entry survives as a root, the whole set is reported unclassified rather than collapsed to nothing.

A nested context's failures — an import initializing its library's resources — are attached to the importing entry as `RuntimeDiagnostic.children` instead of being flattened into its message, so the child's own root causes stay distinguishable from the child's cascade and the CLI's error count reflects the real leaves rather than one `Telo.Import`. They are reported even when the wrapping entry is itself collapsed.

`ModuleContext.getInstance` no longer reports a declared-but-uninitialized resource as `Resource 'X' not found in module context. Available resources: …`. That message listed the module's imports and read as a typo in a name that was in fact declared right there. While the context is still initializing the name now defers with `ERR_LOCAL_REF_PENDING`, exactly as Phase-5 injection does, so the loop retries and the failure is attributed to the dependency. **After** init — at dispatch, where no later pass is coming — it raises `ERR_RESOURCE_NOT_FOUND` saying the resource was declared but never initialized, rather than promising a retry that will never happen. An unknown name still gets the original message.

The CLI prints root causes in full and collapses each blocked chain to a single line (`3 resources blocked by GrantDb: GrantStore, GuardedWork, OnceWork`); `--verbose` prints every entry.
