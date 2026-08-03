# `!ref` and `!cel`

Two YAML tags carry everything dynamic in a Telo manifest. `!ref` points at
another resource; `!cel` computes a value. Most first-week diagnostics are about
one of them, so they are worth ten minutes up front.

## `!ref` — point at a resource

```yaml
handler: !ref Greet              # a resource in this module
mount:   !ref Api                # same
output:  !ref Console.writeLine  # an instance exported by the import aliased `Console`
```

The rules are short:

- **`!ref <name>`** resolves a resource declared in the same module scope.
- **`!ref <Alias>.<name>`** resolves an instance an imported library exports.
  The part before the **first dot** is the import alias.
- A resource name **must not contain a dot** — that is what the split above
  reserves it for (`INVALID_RESOURCE_NAME`).
- **The tag is mandatory.** A bare string (`handler: Greet`) or the old object
  form (`handler: { kind: Run.Value, name: Greet }`) is rejected with
  `INVALID_REFERENCE_FORM`.

### The slot decides what is acceptable

Every reference slot declares which kind it takes. Point it at the wrong sort of
resource and you get `REFERENCE_KIND_MISMATCH` from `telo check`, naming what
the slot expects — not a runtime failure. A kind that inherits from the expected
one is accepted too, so a specialized `Sql.Connection` fits any slot that takes
the abstract.

### Per-call data lives beside the ref, never inside it

A reference names a resource and nothing else. Anything about *this particular
call* is a sibling key:

```yaml
- name: Greet
  invoke: !ref Greet      # which resource
  inputs:                 # what to pass it — a sibling, not part of the ref
    name: !cel "request.query.name"
```

### Inline instead of referenced

Where a slot takes a reference, it usually also accepts an **inline
declaration** — an object with a `kind:` and no `name:`:

```yaml
handler:
  kind: JavaScript.Script
  code: |
    function main({ name }) { return { message: `Hello ${name}` } }
```

Use a `!ref` when the resource is shared or worth naming; inline when it exists
only for this one slot.

## `!cel` — compute a value

```yaml
port:    !cel "ports.http"
message: !cel "'Hello, ' + inputs.name + '!'"
enabled: !cel "variables.mode == 'production'"
```

Always write CEL with the `!cel` tag — pure expressions and string
interpolation alike. You will see the older inline form (`"${{ … }}"`) in
existing manifests; it still evaluates, but new manifests should not use it,
because the formatter normalizes to `!cel` and the inline form does not survive
a round-trip through tooling intact.

### What is in scope, and where

CEL sees different names depending on where the expression is written. This is
the single most useful table on the page:

| Name | Available in | Comes from |
| --- | --- | --- |
| `variables.<n>`, `secrets.<n>` | anywhere in the module | the module's declared inputs |
| `ports.<n>` | anywhere in the root application | its `ports:` block |
| `resources.<n>.<field>` | anywhere, after that resource publishes | what its author configured |
| `resources.<n>.status.<field>` | only in fields that resolve *after* it has run | what it observed at runtime |
| `inputs.<n>` | inside a callable's body | the values passed at the call site |
| `steps.<n>.result` | inside a `Run.Sequence` | an earlier step's result |
| `request.*` | inside an HTTP handler's `inputs:` / `returns:` | query, body, params, headers, path, method |
| `result.*` | inside a `returns:` block | what the handler returned |
| `error.*` | inside `catch:` / `finally:` / `catches:` | the caught failure: `code`, `message`, `step`, `data` |

Everything here is **typed**. `steps.Greet.result.mesage` is a
`CEL_UNKNOWN_FIELD` error at check time, not `undefined` at 3am.

### Not every field evaluates CEL

A kind's schema decides which of its fields are evaluated. Writing an expression
in a field that is not one of them gives `CEL_IN_NON_EVAL_FIELD` — the value
would have been read as a literal string, which is almost never what you meant.
When you hit it, check the kind's schema on the [hub](https://hub.telo.run) for
which fields accept expressions.

The distinction also has a timing side. Some fields are evaluated **once at
load** (a server's `port:`), others **on every call** (a route's `inputs:`).
That is why observed state cannot be read in a startup field: at load time
nothing has run yet, and `telo check` says so (`OBSERVED_STATE_IN_STARTUP_FIELD`).

### Null-safety is enforced

If a value's schema admits `null`, dereferencing it without a guard is a static
error (`CEL_NULLABLE_ACCESS`). Guards are recognised in both forms:

```yaml
code: !cel "error != null && error.code"
code: !cel "error == null ? 'ok' : error.code"
```

The common case is `error` inside a `finally:` block, which is null when the
`try:` succeeded.

## Putting both together

```yaml
- name: Charge
  invoke: !ref PaymentGateway               # !ref: which resource
  inputs:
    amount: !cel "steps.Cart.result.total"  # !cel: computed from an earlier step
    currency: !cel "variables.currency"     # !cel: from module config
  retry:
    attempts: 3                             # a plain literal needs no tag
```

Rule of thumb: **`!ref` for identity, `!cel` for value, no tag for a literal.**

## When something goes wrong

`telo check` finds all of this before you run anything — see
[Catching errors before they run](/learn/static-analysis), and the
[diagnostics reference](/reference/diagnostics) for any specific code. The three
you will meet first:

- `CEL_UNKNOWN_FIELD` — the name is not in scope at that point; check the table above.
- `CEL_IN_NON_EVAL_FIELD` — the field is not evaluated; the expression would be literal text.
- `INVALID_REFERENCE_FORM` — write `!ref Name`, not a bare string.
