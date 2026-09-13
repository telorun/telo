---
"@telorun/analyzer": minor
"@telorun/sdk": minor
"@telorun/kernel": patch
---

Inline declarations inside a step body are now extracted when a manifest loads, at every nesting depth (`then` / `elseif` / `else` / `do` / `cases` / `default` / `try` / `catch` / `finally`), together with whatever those declarations hold inline in turn. Before, the composer registered only a step's own inline `invoke:` target at `init()`, so a declaration nested inside it — a stream handler, a command's `host:` — passed `telo check` and failed at run (`Resource 'Unnamed…' not found`, `'host' must be a !ref`). An `inherit` kind written inline in a step now has an exact throws union, so a `catches:` entry may name the code its target documents.

An extracted step target keeps the name the step engine always gave it (`<OwnerKind><ownerName><step path><stepName>`), carries no declaration pointer, and so keeps the durable identity a journal recorded it under. The rule is `inlineStepTargetName`, exported from `@telorun/sdk` and used by both the load pass and `StepEngine.resolveInvokes`, which now names only bodies assembled at runtime. For an `extends` child the owner is the kind whose controller runs the body, and a `base:`-form child's body keeps the parent field it is mapped onto; a body `base:` reshapes other than verbatim is left for the runtime to name.

A declaration inside a `with:`-scoped resource is created in that scope, and an inline entry in a sequence's `targets:` is created in the sequence's scope — it failed at run with `ERR_RESOURCE_NOT_RUNNABLE` before. A step target written beside a `with:` block is still created where its sequence is, so a reference from inside it to a name that block declares — by `!ref` or as `resources.<name>` in CEL — is now the error `SCOPED_NAME_OUT_OF_REACH` instead of a run-time failure. This and the newly type-checked CEL inside inline step targets can report errors on a manifest that checked clean before — notably an inline target still declaring its contract as an `inputs:` property map, which is now `CONTRACT_INPUTS_SCHEMA_FORM` exactly as it is on a named resource; move the map to `inputType:`.

A CEL context binding whose type cannot be resolved (`x-telo-context-from-root` / `-from-ref-kind` naming a field the resource leaves out, such as `Stream.Scan`'s `acc` without `accType:`) is now untyped rather than an open map, so `acc + item.text` no longer reports `no such overload: map<dyn, dyn> + dyn`.

What extraction pulls out of an imported library's exported instance is stamped as that library's code (`forwardedInternal`) and is never counted as an export, so a consumer's analysis treats it exactly as the export it came from.

A consumer's CEL `resources` now holds only its own resources and its own import aliases, which is what the kernel publishes. It used to also list a library's exports by their bare names (read as `resources.<Alias>.<name>`), the names extraction generates inside them, and the aliases a library imports for itself — so `resources.<such name>` passed `telo check` and failed at run with `cannot read '<name>'`. It is now `CEL_UNKNOWN_FIELD`, and neither those messages nor editor completion offer those names.

Diagnostics about an inline step target now name the extracted resource and anchor at the inline position. Editing an inline step target and reconciling a running kernel rebuilds the target and the sequence holding it, instead of failing with `ERR_DUPLICATE_RESOURCE`; at teardown the sequence now unwinds before its targets.
