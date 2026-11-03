---
status: in-progress
priority: medium
depends-on: []
packages: [analyzer, kernel, sdk, modules/run]
tracking: feat/telo-sequence
---

# Telo.Sequence — the sequence kind as a built-in

## Problem

A list of steps with a contract is the most common thing a Telo application declares, and today it takes a module import. `Run.Sequence` lives in the `run` module, so an application that wants a route handler, a guard, a scheduled job body or a test script has to import `run` first. That holds even though the step grammar it runs (`invoke` / `if` / `while` / `switch` / `try` / `throw` / `rethrow` / `value`) is already core: the analyzer owns the `Step` fragment, and the SDK owns the step engine that durable workflows, transactions and draft sessions use without `run`.

In examples and starters there are 172 `Run.Sequence` declarations in about 100 files:

- 65 are started only from an Application's `targets:`, 40 of them with `with:`.
- About 104 are handlers named or inlined elsewhere: routes, guards, tools, schedules, leases, idempotency, transactions, workflow steps and test helpers. Most of these declare `inputType` / `outputType` / `outputs`.
- 3 are exported from a library.
- None is a templated `run:` body.

So the kind is used everywhere, and it is the main reason most manifests import `run`. It also releases separately from the grammar it wraps, so a grammar change and the kind that exposes it ship on two version lines.

## Solution

`Telo.Sequence` becomes a kernel built-in. It has the same fields and behaviour as `Run.Sequence` today: `steps`, `with:`, `targets:`, `inputType`, `outputType` and `outputs`. Its capability is `Telo.Runnable`, it can still be invoked with inputs, its throws are inherited from what it calls, and it keeps the `Sequence` topology. It needs no import and is versioned with the telo line. `telo builtins Sequence` prints it, the hub lists it with the other built-ins, and editors offer it like `Telo.Function`.

- **Node kernel:** implements it as a built-in controller next to `Telo.Function` and `Telo.JsonSchema`.
- **Rust kernel:** refuses a resource of kind `Telo.Sequence` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`, naming the kind, until it hosts the step grammar. The Rust analyzer reads the entry like every other built-in.

The step names inside a sequence (its durable identity, span names and inline target names) are built from the kind's own name, `Sequence`, so they are unchanged. A durable workflow whose steps live in a sequence keeps its journal when the manifest switches from `Run.Sequence` to `Telo.Sequence`.

`Run.Sequence` stays loadable and is deprecated: its deprecation names `replacedBy: Telo.Sequence`, and declaring one reports `DEPRECATED_KIND` at the use site. It keeps its own controller and otherwise behaves identically; turning it into a pure alias of `Telo.Sequence` waits on the analyzer reading a kind's effective schema through one registry query (plans/2026-11-02-effective-kind-schema.md). Applications pinned to an older `run` are unaffected. The other `run` kinds (`Iteration`, `Loop`, `Projection`, `Choice`, `Value`, `Detach`) do not change.

**In the same change:**

- Every example, starter, blueprint and app manifest moves to `Telo.Sequence`. A manifest left with no other `run` kind drops its `run` import. Each converted manifest declares the `requires: telo:` floor.
- Every text that teaches `Run.Sequence` is updated:
  - the root and package `CLAUDE.md` files;
  - the authoring agent's primer;
  - the hub's authoring guides;
  - `docs/`, the built-in vocabulary spec, and the `run` module's README, docs and description.

Test fixtures and stdlib module manifests switch as they are next touched.

**Before:** writing a route handler or a test script means importing `run` and declaring `Run.Sequence`.
**After:** `kind: Telo.Sequence` works with no import. `Run.Sequence` still runs and warns, pointing at the replacement.

**Verify:**

- `telo builtins Sequence` prints the entry.
- An application declaring `Telo.Sequence` with no `imports:` passes `telo check` and runs.
- A `Run.Sequence` manifest reports `DEPRECATED_KIND` naming `Telo.Sequence`, and its tests still pass unchanged (the `run` module's suite included).
- After conversion, the durable-orders example still passes, which shows journal identity was kept.
- The Rust kernel refuses a `Telo.Sequence` resource with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
- One converted starter, with its `requires:` block stripped, is rejected by the previous published CLI (`UNDEFINED_KIND`). With the block restored, the same CLI reports `MODULE_REQUIRES_NEWER_RUNTIME`.

## Decisions

- **Only `Sequence` moves.** The other `run` kinds are ordinary library features. Pulling them in would have every kernel implement the standard library.
- **The name is `Telo.Sequence`.** A kind names what the resource is: an ordered list of steps behind a contract. `ControlFlow` names some of the steps it can contain, and the same control flow runs in every step-body kind. `Steps` is plural, repeats the `steps:` field, and overlaps the `steps.<name>.result` binding.
- **`targets:` and templated `run:` are not widened instead.** That would cover only the 65 target-only sequences, would need `with:` on the Application for 40 of them, and has no templated `run:` cases. It would also leave two places to write steps while the handler majority still needed the kind.
- **The controller lives in the kernel**, in its built-in controller table like the other built-ins. The SDK keeps the step engine and hosts no controller.
- **`Run.Sequence` keeps its own controller for now.** A pure alias loses the analyzer's step-grammar checks while the analyzer reads a kind's raw schema, so it waits on the effective-schema query (plans/2026-11-02-effective-kind-schema.md). Until then two copies of the controller exist and are kept identical by hand.
- **There is no `telo migrate` rewrite.** The import alias is chosen by the author (`Run` is only a convention), and dropping a now-unused import cannot be written as a migration entry. The deprecation warning with `replacedBy` carries the instruction, as it did for `Type.JsonSchema`.
- **User-facing manifests convert now; fixtures and stdlib modules convert as touched.** A copied starter must not warn on its first run. Converting stdlib modules would release each of them only to change a kind name.
- **The Rust kernel refuses the kind instead of failing to find a controller.** A named refusal tells the author the runtime lacks the feature, not that the manifest is wrong. It matches how that kernel already refuses `needs:`.
- **There is no benefits-ledger entry.** Moving a kind into the kernel gives authors no new capability.
- **A resource of an inheriting kind is one instance.** The context that owns the declared resource creates it through the normal create pipeline, under the child's own kind, with the controller of the nearest ancestor that has one; a delegating definition registers that controller under its own canonical kind, loaded lazily under the same controller policy, and there is no wrapper controller. Every part of the definition chain resolves in the module that wrote it: `ctx.resolveControllerFile` / `resolveNativeFile` / `resolveControllerBrowserEntry` against the module of the definition declaring the controller, a template body and `base:` / `inputs:` / `result:` in the module of the definition holding them, while `ctx.resolveModuleFile` and `ctx.resolveBrowserEntry` stay the resource's own module. Without `base:`, the ancestor's controller creates the child's own validated, expanded and injected resource in the owner's context. With `base:`, the mapping is a step of the one pipeline: the child's reference sites are resolved first through the injection lookup (deferring while pending), the mapping is evaluated in the child-declaring module's scope, a reference it writes as a literal becomes the live instance it names in that scope, an expression it leaves compiled is bound to that scope plus `self`, the mapped configuration is held to the ancestor's effective author schema, and the ancestor's controller creates it once with the owner's context. Contracts bind in nested order on the one instance: the ancestor's innermost, then the `inputs:` / `result:` mappings, then the child's own outermost — one handle, one declaration record, one set of effect frames.
- **`throws:` resolves to the nearest declaration along `extends`,** self first, replacing and never merging. `inherit` and the scope union walk the configuration the controller receives: the instance under its effective author schema, or the `base:` mapping with each verbatim `self.<path>` replaced by the instance's value there, under the ancestor's effective author schema; any other expression at or above a driven slot makes the union unbounded. Template forward views and the throws walk read a mapping through one reader. A kind-only library input keeps the nearest literal list. The kernel stamps the effective block at definition registration and its undeclared-code check reads the stamp. `Run.Sequence` keeps its own `throws: { inherit: true }` while it keeps its own controller.

## Example after the change

A route handler that needs no import:

```yaml
kind: Telo.Sequence
metadata: { name: readBookmark }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    required: [id]
    properties:
      id: { type: integer }
steps:
  - name: found
    invoke: !ref query
    inputs: { bindings: [!cel "inputs.id"] }
outputs:
  bookmark: !cel "steps.found.result.rows[0]"
```
