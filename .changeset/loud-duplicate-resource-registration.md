---
"@telorun/kernel": patch
"@telorun/run": patch
---

Surface duplicate inline resource registrations as `ERR_DUPLICATE_RESOURCE` instead of silently skipping the second registration. `resolveChildren` previously suppressed the throw from `registerManifest` when the target name was already taken, which hid real bugs — most notably inline resources inside sibling `Run.Sequence` steps colliding on auto-generated names, where only the first sequence's invocations actually ran while the rest were silently aliased onto it.

Three changes ship together:

- `@telorun/kernel`: removed the `!hasManifest(name)` guard in `resolveChildren`. Duplicate registrations now throw at boot.
- `@telorun/run`: inline-step auto-names now include the parent sequence's name and follow the project's PascalCase resource-naming convention — e.g. `SequenceHealthLivenessSteps1Assert` rather than `__sequence_steps_1__assert`. Sibling sequences with identical step names no longer collide.
- `@telorun/kernel`: the unnamed-resource fallback was renamed from `__unnamed_<hex>` to `Unnamed<hex>` for the same convention.
