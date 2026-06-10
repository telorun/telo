---
"@telorun/kernel": patch
"@telorun/sql": patch
---

fix(kernel,sql): resolve cross-module/runnable boot & step targets that passed `telo check` but failed at runtime

Three "green check, red run" defects in cross-module dispatch:

- A boot `target` that is a `!ref` to a `Run.Sequence` threw `Resource not found
  for invocation: undefined.invoke`. The boot runner matched the inline-invoke
  branch on any target exposing `invoke()` before the runnable branch — but a
  live `Run.Sequence` instance exposes both `run()` and `invoke()`. Guard the
  inline-invoke branch with `!isRunnableInstance(target)` so a live instance runs
  via `run()`.
- A `Run.Sequence` step `invoke: !ref X` (or boot inline-invoke) targeting a pure
  `Telo.Runnable` threw `does not have an invoke method`, even though the step
  schema explicitly accepts `telo#Runnable`. `invoke`/`invokeResolved` now fall
  back to `run()` when the resolved instance has no `invoke()` (side effects only,
  no result), honoring the declared contract.
- `Sql` connection refs (`connection: !ref Domain.Db`) reached through a nested
  import boundary failed with `Resource 'Db' not found in module context`. The
  resolver ignored the `alias` on a cross-module ref and did a bare local lookup;
  it now routes alias-qualified refs through `resolveImportedInstance` (mirroring
  the http-client client ref).
