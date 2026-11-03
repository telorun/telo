---
status: in-progress
priority: high
depends-on: []
packages: [analyzer, kernel, modules/run]
---

# Effective kind schema — one answer for what an inheriting kind accepts

## Problem

A kind that `extends` a concrete kind without `base:` and declares no schema of its own accepts exactly what its parent accepts. The kernel and the built-ins agree: they write the merged schema onto the definition when it registers. The analyzer does not: it reads the definition as its author wrote it, which for such a kind is empty. The same word, a definition's schema, therefore means "what this file wrote" in one host and "merged with the ancestors" in the other, and about forty readers across the analyzer take the first meaning.

The visible damage, for any such child:

- **Checks vanish.** A step's `invoke:` that names nothing is no longer `UNRESOLVED_REFERENCE`, and `RETHROW_WITHOUT_CAUGHT_ERROR`, `BRANCH_SHAPE_INVALID`, `REPEAT_POSITION_INVALID` and `REFERENCE_KIND_MISMATCH` for a callable step target go quiet. The kernel then fails at boot on what `telo check` passed.
- **False errors appear.** A template body holding such a child with `!for-each` reports `REPEAT_SHAPE_INVALID`, `REF_MEMBER_INVALID` and `CEL_UNKNOWN_FIELD`.
- **The editor offers nothing** at an instance of such a kind.
- **Derived values go stale.** The stamp is written once; a parent that changes (a kernel reconcile, an edit in the editor) leaves every descendant holding the old merge.

This blocks `Run.Sequence` from becoming the pure alias of `Telo.Sequence` the Telo.Sequence work wanted: applied as an alias, nine rows of `tests/check-run-agreement.yaml` go red. It already hurts any existing child with an empty schema, for example `Steps` in `tests/value-type-literals.yaml`.

## Solution

A declaration always means what its author wrote, in every host. Everything derived along `extends` is answered by one query on the definition registry, and the analyzer, the kernel and the editor support all read it. Nothing writes a derived value over a declaration.

- **What the query answers:** the effective author schema, the `status:` schema, `throws`, the published own fields, the declared display messages and the capability. A merge-form child's schema is the parent's merged with its own; a `base:` child's is its own, as today.
- **Two kinds of reader.** Every place that reads a kind's schema is classified once:
  - A reader that interprets an instance, or treats a kind as a slot or a target, uses the effective schema: step collection, expansion sites, CEL evaluation sites, rethrow placement, CEL scope, `x-telo-schema-from`, reference reach, completion and hover.
  - A reader that judges the declaration itself uses the authored document: the `extends` checks, inherited required fields, per-declarer rule attribution, slot well-formedness reported where it is written, misplaced annotations at the kind, callable-definition checks.
  - A refusal that depends on the combination (an `observes` holder, a closed parent gaining a field) reads the effective schema and is reported at the child's own line.
- **Presence checks** ("this kind has a schema") test the effective schema, so an empty child no longer switches off CEL judging, nested-inline checks and `x-telo-schema-from`.
- **Stable identity.** The query returns the same value until it is invalidated, because validator caches, shape memos and reach caches key on identity. A definition added, removed or replaced invalidates it.
- **Schema ids.** The `telo://<module>/<Kind>` id addresses the effective schema and is registered on first lookup, after the parent exists.
- **The kernel and the built-ins stop stamping** merged `schema`, `status`, `throws` and display messages onto definitions. What the registry records at registration is the canonical kind `extends:` names, resolved in the declaring module's scope.
- **The rule join's de-duplication for schemas folded twice** and its test are removed; a three-level chain joins each inherited rule once by construction.
- **`Run.Sequence` becomes the alias** the Telo.Sequence plan described: it extends `Telo.Sequence`, declares no schema, no `throws:` and no controllers, and names `replacedBy: Telo.Sequence`. Its own controller and source file in the `run` module are removed.
- **Guides.** The analyzer and kernel guides drop "the kernel stamps the merged schema and status at registration" and state the rule above.
- **Release.** A changeset on the telo version line. No `requires:` floor, no migration, no primer or ledger change: no manifest surface changes. The Rust kernel refuses `extends` and the Rust analyzer reads no schema, so nothing is ported; when either gains `extends` it adopts the same query and no stamp.

**Before:** an empty child is checked by the kernel as its parent and by the analyzer as nothing; a parent edit leaves stale merged copies; `Run.Sequence` must keep a second copy of the controller.
**After:** `telo check` and the kernel agree on every kind that inherits without a schema of its own; the editor completes its instances; `Run.Sequence` is a pure alias.

**Verify:**

- `pnpm run test --include tests/check-run-agreement.yaml` passes with the alias applied and the alias definition unchanged; the nine rows that went red (`familyEmittedWritten` and its `AtRuntime` twin, `callableStepInvoke`, `rethrowInFinally`, `rethrowOutsideCatch`, `scopeMemberDefects`, `expansionBranchShape` and its `AtRuntime` twin, `bodyResourcesSibling`) are the canary.
- Alias invariance: for the step-grammar, template-body `!for-each` and CEL-scope fixtures, reaching each kind through an empty merge-form child gives the same diagnostic codes at the same paths as reaching it directly, and completion and hover at an instance field offer the parent's fields.
- After analysis and after `kernel.load()`, every `Telo.Definition`'s `schema`, `status` and `throws` deep-equal what the loader produced.
- A merge-form child's status validator compiles once however often the status is published.
- A `$ref` to `telo://<module>/<Child>` enforces the parent's `required`.
- Editing a parent in a running reconcile changes what its descendants accept, with no re-stamp.
- The `run` module's suite passes unchanged, and a `Run.Sequence` manifest reports `DEPRECATED_KIND` naming `Telo.Sequence`.

## Decisions

- **One query on the registry, not a stamp.** A stamp writes a derived value over its source: it gives the field a before- and after-registration meaning, goes stale when a parent changes, and leaks into every reader of the manifest as written (`telo format`, `telo describe`, the editor's model). Resolved-over-declared is how Roslyn, the TypeScript checker, javac and rust-analyzer treat inherited members.
- **Not a migration or a special case for `Run.Sequence`.** It would leave the same gap for every other child with an empty schema.
- **Not a composed `allOf` of parent and own.** The `x-telo-*` readers walk `properties` structurally, and `allOf` means both must hold while the merge lets the child override the parent.
