---
sidebar_label: Accessor Fields
slug: /extend/accessor-fields
description: "Let a kind take a field that names a value instead of computing one — a plain, statically typed CEL chain the controller receives as a binding and resolves wherever its data lives."
---

# Accessor fields

Some fields do not hold a value. They say **where a value comes from**, for
something else to fetch later: the column of a table that shows each row's
`text`, the field a chart reads as its x axis, the member a list sorts by. The
controller cannot evaluate such a field — the rows do not exist when the resource
is created, and they may never exist in this process at all, because the code
that finally reads them runs in a browser.

`x-telo-eval: accessor` is the annotation for that field. The author writes an
ordinary `!cel` expression, `telo check` types it like any other, and the
controller receives it as plain data describing the path — never as something to
evaluate.

## Declaring one

```yaml
kind: Telo.Definition
metadata:
  name: Table
capability: Telo.Provider
schema:
  type: object
  properties:
    model:
      x-telo-ref: { kind: Telo.Type, use: schema }
    rowStyle:
      type: string
      x-telo-eval: accessor
      x-telo-context:
        type: object
        properties:
          row:
            x-telo-context-ref-from: "model/schema"
```

Two annotations work together:

- `x-telo-eval: accessor` says the field is named, not evaluated.
- `x-telo-context` declares the **bindings** a chain may start at, and types
  each one. Here `row` is typed from the shape the resource's own `model` names,
  whether the author gave it inline or by `!ref`.

It is the third value of `x-telo-eval`, beside `compile` and `runtime`, and it
wins over a provider's implicit compile-eval the way `runtime` does: the field is
left out of what the kernel evaluates when the resource is created.

## What an author may write

A **plain chain** — identifiers joined by dots, rooted at one of the field's
bindings:

```yaml
kind: Reports.Table
metadata:
  name: todos
model: !ref Todo
rowStyle: !cel "row.status"
```

or a **literal**, which means "this value, for every row":

```yaml
rowStyle: muted
```

Nothing else. The chain is checked against the binding's type, so a member the
model does not declare is `CEL_UNKNOWN_FIELD`, a name nothing binds is
`CEL_UNKNOWN_IDENTIFIER`, and a chain whose type does not fit the field is
`CEL_TYPE_ERROR` — all before the application runs. One rule is relaxed: reading
through a member that may be null needs no guard (`row.owner.name`), because no
evaluation happens here; the consumer resolves the path and a missing step yields
nothing.

Because nothing evaluates the field, anything that would need evaluating is
refused as `ACCESSOR_NOT_PLAIN_CHAIN`:

| Written | Why it is refused |
| --- | --- |
| `!cel "row.text.upperAscii()"` | a call |
| `!cel "row.text + '!'"` | an operator |
| `!cel "row.tags[0]"` | an index |
| `!interpolate "${{ row.text }}!"` | interpolation |
| `{ label: !cel "row.text" }` | a tag beneath the field — the chain is the field's whole value |
| `!cel "variables.style"` | a chain rooted outside the field's bindings |

The kernel refuses the same values when the resource is created, as
`ERR_ACCESSOR_NOT_PLAIN_CHAIN`.

## What the controller receives

A **binding**: a plain map, with no class and nothing to call.

| Written | Received |
| --- | --- |
| `!cel "row.status"` | `{ root: "row", path: ["status"] }` |
| `!cel "row.owner.name"` | `{ root: "row", path: ["owner", "name"] }` |
| `!cel "row"` | `{ root: "row", path: [] }` |
| `muted` | `{ value: "muted" }` |
| `{ root: row, path: [text] }` | `{ value: { root: "row", path: ["text"] } }` |

A literal is always wrapped, so a literal that happens to look like a chain is
never mistaken for one: a controller tells the two apart by whether the map has
a `value` key.

```ts
function resolve(binding, bindings) {
  if ("value" in binding) return binding.value;
  let current = bindings[binding.root];
  for (const key of binding.path) current = current?.[key];
  return current;
}
```

The same seven lines work in a browser, which is the point: a controller can put
the binding in a document it serves, and the page resolves it against each row
with no expression engine on the client.

## Inside a template

A templated kind composing a kind with accessor fields writes the chain in its
body as it would anywhere:

```yaml
resources:
  - kind: Reports.Table
    metadata: { name: table }
    model: !cel "self.model"
    title: !cel "'Report: ' + self.label"
    rowStyle: !cel "row.status"
```

The body is expanded against `self` before the entry is created, so an
expression reading only `self` has become a literal by then and is delivered as
`{ value: … }`. A chain rooted at one of the field's own bindings is left as
written and reaches the entry as a chain.

## Limits

- The annotation is a field's: the whole value is one chain or one literal.
  A map of accessors annotates the map's values (`additionalProperties`), a list
  its `items`.
- Under a provider's implicit compile-eval, an accessor field anywhere beneath a
  top-level property keeps that whole property from being evaluated at creation,
  exactly as a `runtime` field does. A sibling field under the same top-level
  property that needs evaluating declares `x-telo-eval: compile` itself.
- A kind that only forwards an accessor into a template body does not annotate
  its own field `accessor` — the entry that finally holds it does. Annotating
  both would deliver a binding into a field that then reads it as a literal.
