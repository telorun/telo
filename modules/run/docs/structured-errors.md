---
description: "Run.Sequence error handling: try/catch/finally with InvokeError.code/message/data binding and rethrow step capability"
sidebar_label: Structured Errors
---

# Structured Errors in `Run.Sequence`

`Run.Sequence` composes invocables and surfaces their structured failures (`InvokeError`) through `try` / `catch`. This page covers the three pieces that make that work end-to-end:

- `try:` / `catch:` step binding the `error` context
- the `throw:` step — throws an `InvokeError` at a specific point in the sequence
- `throws: { inherit: true }` — how a sequence declares its effective throw union

## `try` / `catch` / `finally`

Inside a `catch:` block, the CEL context gains:

- `error.code` — the thrown `InvokeError.code`, or `null` for plain `Error` throws
- `error.message` — the thrown message
- `error.data` — the `InvokeError.data`, or `undefined` for plain errors
- `error.step` — the name of the step that threw

```yaml
kind: Run.Sequence
metadata: { name: PublishWithAudit }
steps:
  - name: publish
    try:
      - name: auth
        invoke: { kind: Auth.VerifyToken, name: VerifyPublishToken }
        inputs:
          authorization: "${{ request.headers.authorization }}"
      - name: upload
        invoke: { kind: S3.Put, bucketRef: { name: ModuleStore } }
        inputs: { key: "${{ inputs.fileKey }}", body: "${{ inputs.body }}" }
    catch:
      # Log the failure before re-raising. Plain errors rethrow too.
      - name: audit
        invoke: { kind: Sql.Exec, connection: { kind: Sql.Connection, name: Db } }
        inputs:
          sql: "INSERT INTO publish_failures (code, message, data, step) VALUES ($1, $2, $3, $4)"
          bindings:
            - "${{ error.code }}"
            - "${{ error.message }}"
            - "${{ error.data }}"
            - "${{ error.step }}"
      - name: rethrow
        throw:
          code: "${{ error.code }}"
          message: "${{ error.message }}"
          data: "${{ error.data }}"
```

A `catch` block that falls through without re-throwing *absorbs* the error. A `catch` block that ends in a `throw:` step re-raises it — the step's `code` determines which codes propagate out of the sequence.

## `throw:` step

A `throw:` step takes `{ code, message?, data? }` and throws the matching `InvokeError` from inside the sequence. The analyzer statically narrows the step's contribution to the sequence's throw union using the same rules as passthrough call sites:

| Form                                  | Statically resolves to                 |
|---------------------------------------|----------------------------------------|
| `code: "UNAUTHORIZED"`                | `{ UNAUTHORIZED }`                     |
| `code: "${{ 'FOO' }}"`                | `{ FOO }`                              |
| `code: "${{ error.code }}"` inside a `catch` | the enclosing `try`'s propagated union |

Any other CEL expression is an analyzer error — the throw union would be unbounded and any surrounding `catches:` list would have no way to cover it.

## `throws: { inherit: true }`

A definition with `inherit: true` declares that its effective throw union is the union of everything it calls. `Run.Sequence` uses this: its declared throws is empty at the definition level; the actual union is computed per-manifest from the steps it runs.

The analyzer's dataflow pass walks every field on the definition annotated with `x-telo-step-context` (so future composers like `Run.Parallel` opt in the same way — no analyzer changes needed). For each step:

1. If the step has a `throw:` block, resolve the thrown code at this call site.
2. Otherwise, resolve the step's `invoke.kind` via the definition registry.
3. If the invoked target is another `inherit: true` composer, recurse (memoised by manifest name, cycle-safe).
4. If the invoked target is `passthrough: true`, resolve at this specific call site.
5. Otherwise, use the target's declared `throws.codes`.

Inside a `try` / `catch`, the catch block's throws *replace* the try block's (a `catch` that runs to completion has absorbed the try error; a `catch` that ends in a `throw:` re-raises whatever it decides).

`inherit: true` is only legal on definitions whose schema declares at least one `x-telo-step-context` array — the analyzer rejects it otherwise.

## Rules the analyzer enforces

- **Undeclared code in `catches:` `when:`** — rejected against the handler's resolved union.
- **Uncovered declared code** — every code in the resolved union must reach a `catches:` entry (explicit `when:` or catch-all).
- **Unbounded union requires catch-all** — when inherit/passthrough resolution can't enumerate all codes, the `catches:` list must include a no-`when:` entry.
- **Typed `error.data.<field>`** — validated against the per-code `data:` schema from the resolved union. Disjunctive `when:` clauses (`error.code == 'A' || error.code == 'B'`) use the *intersection* of data schemas so only fields present on every covered code narrow through.
- **`${{ error.code }}` outside `catch:`** — using it in a `throw:` step outside an enclosing `catch` block is rejected (no enclosing try to source the union from).
