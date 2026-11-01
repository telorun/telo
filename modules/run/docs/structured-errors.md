---
description: "Run.Sequence error handling: try/catch/finally with InvokeError.code/message/displayMessage/data binding, the throw and rethrow steps"
sidebar_label: Structured Errors
---

# Structured Errors in `Run.Sequence`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Sequence`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Sequence` composes invocables and surfaces their structured failures (`InvokeError`) through `try` / `catch`. This page covers the three pieces that make that work end-to-end:

- `try:` / `catch:` step binding the `error` context
- the `throw:` step — throws an `InvokeError` at a specific point in the sequence
- the `rethrow:` step — re-raises the failure a `catch:` caught, unchanged
- `throws: { inherit: true }` — how a sequence declares its effective throw union

## `try` / `catch` / `finally`

Inside a `catch:` block, the CEL context gains:

- `error.code` — the thrown `InvokeError.code`, or `INTERNAL_ERROR` for plain `Error` throws. Always a non-empty string, so `throw: { code: !cel "error.code" }` can safely rethrow it.
- `error.message` — the thrown message, the developer's
- `error.data` — the `InvokeError.data`, or `undefined` for plain errors
- `error.displayMessage` — the text a person is shown for the failure, as its record (`{ text, context, lang, computed }`), or `null` when it carries none
- `error.step` — the name of the step that threw

These five fields are statically type-checked: a typo like `!cel "error.cdoe"` inside a `catch` (or `finally`) is reported as `CEL_UNKNOWN_FIELD`, at any nesting depth.

Inside a `finally` block, `error` is **nullable** — it is `null` when the `try` (and any `catch`) succeeded, and the caught failure only when a failure propagates. Accessing a field without a null-guard is a static error (`CEL_NULLABLE_ACCESS`); guard first: `!cel "error == null ? 'OK' : error.code"` or `!cel "error != null && error.code == 'X'"`.

```yaml
kind: Run.Sequence
metadata: { name: PublishWithAudit }
steps:
  - name: publish
    try:
      - name: auth
        invoke: { kind: Auth.VerifyToken, name: VerifyPublishToken }
        inputs:
          authorization: !cel "request.headers.authorization"
      - name: upload
        invoke: { kind: S3.Put, bucketRef: { name: ModuleStore } }
        inputs: { key: !cel "inputs.fileKey", body: !cel "inputs.body" }
    catch:
      # Log the failure before re-raising. Plain errors rethrow too.
      - name: audit
        invoke: { kind: Sql.Command, connection: { kind: Sql.Connection, name: Db } }
        inputs:
          sql: "INSERT INTO publish_failures (code, message, data, step) VALUES ($1, $2, $3, $4)"
          bindings:
            - !cel "error.code"
            - !cel "error.message"
            - !cel "error.data"
            - !cel "error.step"
      - name: again
        rethrow: {}
```

A `catch` block that falls through without re-throwing *absorbs* the error. A `catch` block that ends in a `rethrow:` step re-raises it; one ending in a `throw:` step raises a new error — the step's `code` determines which codes propagate out of the sequence.

## `throw:` step

A `throw:` step takes `{ code, message?, displayMessage?, data? }` and throws the matching `InvokeError` from inside the sequence. Its two messages have two readers:

- `message` is the developer's — logs and traces — and may be computed (`message: !cel "'lookup of ' + inputs.id + ' found no row'"`).
- `displayMessage` is the text a person is shown: a literal `Text` in the module's `lang:`, whose placeholders name members of `data` (`displayMessage: "Item {$id} does not exist."` beside `data: { id: !cel "inputs.id" }`), a caught error's `!cel "error.displayMessage"`, or null. Any other expression is refused — `TEXT_ARGUMENT_COMPUTED` by `telo check`, `ERR_TEXT_ARGUMENT_COMPUTED` at run — because a sentence CEL builds can be neither checked nor translated.

Without `message`, the developer message is the display message formatted in its own language with `data`, else the `code`. When the kind the error leaves declares the code with a `displayMessage`, that is attached to an error carrying none (`docs/extend/text-records.md`).

Inside a `catch:` branch, a `throw:` records the failure the branch caught as the new error's `cause`. Nothing in CEL reads it — `error` has no `cause` — but the log record of the new error writes it in its cause chain, so the original failure is never lost from the logs.

The analyzer statically narrows the step's contribution to the sequence's throw union using the same rules as passthrough call sites:

| Form                                  | Statically resolves to                 |
|---------------------------------------|----------------------------------------|
| `code: "UNAUTHORIZED"`                | `{ UNAUTHORIZED }`                     |
| `code: !cel "'FOO'"`                  | `{ FOO }`                              |
| `code: !cel "error.code"` inside a `catch` | the enclosing `try`'s propagated union |

The enclosing `try`'s propagated union includes `INTERNAL_ERROR` whenever the `try` block contains an `invoke:` step, since any invoked resource can throw a plain `Error` that the catch surfaces as `error.code === 'INTERNAL_ERROR'`. A surrounding `catches:` list must therefore cover `INTERNAL_ERROR` (or include a catch-all) for such a rethrow.

Any other CEL expression is an analyzer error — the throw union would be unbounded and any surrounding `catches:` list would have no way to cover it.

## `rethrow:` step

`rethrow: {}` re-raises the failure the enclosing `catch:` caught, exactly as it was: its code, both messages, its data, its cause and its stack — a plain `Error` stays a plain `Error`, read again as `INTERNAL_ERROR` by the next catch. Prefer it to restating the fields in a `throw:`, which drops whatever the error carries beyond them.

It is legal only inside a `catch:` branch, at any depth (inside an `if:` or a nested `try:` of one). In a `finally:` branch — where `error` is null when nothing failed — or outside every `catch:`, there is no caught failure: `telo check` reports `RETHROW_WITHOUT_CAUGHT_ERROR` and the run fails with `ERR_RETHROW_WITHOUT_CAUGHT_ERROR`. Its contribution to the throw union is the enclosing `try`'s propagated union, as for `code: !cel "error.code"`.

## Where a failure was written

Every step a `Run.Sequence`, `Run.Iteration`, `Run.Loop` or `Run.Projection` dispatches tells the target where that step's `inputs:` are written in the resource (`/steps/1/inputs`, `/steps/2/then/0/inputs`, `/steps/0/cases/a~1b/0/inputs` for a case key holding `/`). A target whose failure names the input it is about (`Assert.Equals` names the first differing node of `expected`) can then be located at that node of the manifest. A rethrown failure keeps the place it was first located at.

## `throws: { inherit: true }`

A definition with `inherit: true` declares that its effective throw union is the union of everything it dispatches. `Run.Sequence` uses this: its declared throws is empty at the definition level; the actual union is computed per-manifest from the steps it runs and the `targets:` it runs before them.

It is a declaration, never an inference: a kind that catches what it dispatches does not declare `inherit`, and a kind that does not declare it gains nothing from what it dispatches. Two kinds of site contribute.

### Step bodies

The analyzer's dataflow pass walks every field on the definition that holds a step body — a field whose items point at the shared grammar (`$ref: "telo://manifest#/$defs/Step"`), or, for a module published before that fragment existed, one annotated `x-telo-step-context`. Either way a future composer opts in without an analyzer change. For each step:

1. If the step has a `throw:` block, resolve the thrown code at this call site.
2. Otherwise, resolve the step's `invoke.kind` via the definition registry.
3. If the invoked target is another `inherit: true` composer, recurse (memoised by manifest name, cycle-safe).
4. If the invoked target is `passthrough: true`, resolve at this specific call site.
5. Otherwise, use the target's declared `throws.codes`.

Inside a `try` / `catch`, the catch block's throws *replace* the try block's (a `catch` that runs to completion has absorbed the try error; a `catch` that ends in a `throw:` re-raises whatever it decides).

### Reference slots

Every `x-telo-ref` slot the definition's schema declares — at any depth: nested objects, array items, map values (`additionalProperties`), union branches (`oneOf` / `anyOf` / `allOf`, the root's included) and local `$ref`s, following a recursive shape as deep as the resource's data goes — contributes when its `use`, resolved for this resource, can hand a failure back to the caller. A slot inside an `x-telo-scope` region belongs to the scoped declaration rather than this resource, and a shape transplanted through `x-telo-schema-from` is not descended. Where several branches declare a slot at the same place — two `oneOf` branches keyed on a sibling, or a slot whose union also admits an inline node of its own recursive shape — every one of them counts: a branch that does not apply to this resource can only add codes, so more coverage is demanded, never less. A map-value (`additionalProperties`) slot applies only to keys its own schema does not declare, and never to a resource's `kind` / `metadata`. The slots that count:

- `call` — the target runs inside this resource's invocation, so its failure returns into it.
- `trigger.consumer` — the target runs when the caller drains a value this resource returned, so its failure rejects that value.

A `detached` or `trigger.inbound` target runs where no caller of this resource awaits it, and `dependency` / `schema` dispatch nothing, so none of those contribute. A slot declaring several uses counts when any of them is `call` or `trigger.consumer`. A slot whose use is a case map (`use: { by, cases }`) is decided by this resource's selector — the value written at `by`, else the schema default. When neither decides — the selector is a `!cel` value, a literal that matches no case, or absent with no schema default — the slot counts when any case would. A slot on the legacy bare-string form declares no use and counts as `call`: a throw union must keep the error path, so an undeclared relation is read as the one that returns a failure.

The slot's target contributes its own effective union — recursing into another `inherit: true` kind, memoised and cycle-safe, exactly as a step's `invoke:` target does. An inline declaration at the slot resolves like a named one. A target that cannot be resolved makes the union unbounded, so a `catches:` rendering it needs a catch-all. `Run.Sequence.targets` is such a slot (`use: call`), which is why a failing target shows up in the sequence's union.

### Where `inherit` is legal

`inherit: true` is only legal on a definition whose schema declares — anywhere the walk above reaches — a step body, or a reference slot whose use (for a case map, any case; a slot declaring none counts as `call`) includes `call` or `trigger.consumer`. Anything else has nothing a failure can come back through, and the analyzer reports `INHERIT_WITHOUT_STEP_CONTEXT`. The check and the union read the same slots, so a kind the check accepts is one whose union is computed from them.

## Rules the analyzer enforces

- **Undeclared code in `catches:` `when:`** — rejected against the handler's resolved union.
- **Uncovered declared code** — every code in the resolved union must reach a `catches:` entry (explicit `when:` or catch-all).
- **Unbounded union requires catch-all** — when inherit/passthrough resolution can't enumerate all codes, the `catches:` list must include a no-`when:` entry.
- **Typed `error.data.<field>`** — validated against the per-code `data:` schema from the resolved union. Disjunctive `when:` clauses (`error.code == 'A' || error.code == 'B'`) use the *intersection* of data schemas so only fields present on every covered code narrow through.
- **`!cel "error.code"` outside `catch:`** — using it in a `throw:` step outside an enclosing `catch` block is rejected (no enclosing try to source the union from).
