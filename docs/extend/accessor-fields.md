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
wins over a provider's implicit compile-eval: the field is left out of what the
kernel evaluates when the resource is created, while everything beside it is
still evaluated.

A chain may start at a binding of every `x-telo-context` enclosing the field —
its own and each one above it. An accessor field inside a named shape
the kind's schema `$ref`s, recursive ones included, is an accessor field at every
depth the data goes, with the bindings the regions on the way to it declare.

## Where a binding exists

`x-telo-context-eval` on a binding names the eval modes it exists at —
`compile`, `runtime`, `accessor`, or a list of them; absent, every mode. It is
how a kind declares a value only its consumer has — a row a page renders in the
browser — that an author may name but nothing on the server can read, and a
value only the server has — the request — that an accessor must not name:

```yaml
x-telo-context:
  type: object
  properties:
    row:
      x-telo-context-eval: accessor
      type: object
      properties: { amount: { type: integer } }
    request:
      x-telo-context-eval: runtime
      type: object
      properties: { ip: { type: string } }
```

At an accessor field `row.amount` is a typed chain; in an evaluated `!cel` or
`!interpolate` in the same region, `row` is `CEL_UNKNOWN_IDENTIFIER`. An
accessor chain rooted at `request` is `CEL_UNKNOWN_IDENTIFIER` too, and the
kernel refuses it when it creates the resource (`ERR_ACCESSOR_NOT_PLAIN_CHAIN`).
A value that is no mode, an empty list or a list naming a mode twice is
`SCHEMA_VIOLATION`, and the mark written anywhere but directly on a binding is
the warning `CONTEXT_EVAL_MISPLACED`.

## A schema matched against what an accessor names

`x-telo-match-for: "<pointer>"` on a field holding a JSON Schema names the
accessor field — a JSON Pointer relative to the object enclosing the annotated
field — whose value the schema is matched against:

```yaml
condition:
  type: object
  properties:
    at: { x-telo-eval: accessor }
    matches: { type: object, x-telo-match-for: /at }
```

`telo check` judges the schema against the static type of the accessor's chain
(a literal accessor is judged as `{ const: <value> }`) and reports a schema that
can never hold for it as `MATCH_UNSATISFIABLE`. Only definite disjointness is
reported: `type` (an integer is a number), `const`, `enum`, and `required`
naming a member a closed object lacks — through `properties` the value always
has, `items` of a list never empty, `allOf` (one disjoint member suffices) and
`anyOf` (every branch disjoint); never `not`, and against a value that is a union
only when the schema is disjoint from every branch. An open or untyped value is
never judged. It is judged in every resource, `with:` member, template-body entry
and forwarded value of the entry's own modules, and the kernel refuses the same
manifest at load, through its analysis. A pointer naming nothing, crossing an
array or naming a field that is not an accessor, a field that is not a property
of an object schema, and one at or beneath an accessor field are
`MATCH_FOR_INVALID`, reported where the annotation is written.

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

## What a rule reads

A [resource rule](./resource-rules.md) or a [referrer rule](./referrer-rules.md)
reads an accessor field as the same binding, in every declaration it binds — so
a rule over a resource that fills such a field evaluates rather than being
skipped for holding an expression, and may state a relation over what the field
names (`this.value.root == 'row'`). A field holding something other than a
plain chain or a literal reads as `{ value: … }` with the expression still
inside it, and a rule reading that value is skipped. In a
[template body](./templated-definitions.md)'s entry, an expression reading only
`self` is read the same way — a literal whose value is not yet known.

## Typing a binding from a list the resource names

A kind that shows several lists lets each entry name its own rows with an
accessor, and wants the columns beneath it typed by one row of *that* list.
`x-telo-context-element-from-item: "<relative pointer>"` types a binding as the
element of the collection the chain at another field names. The pointer is a
[Relative JSON Pointer](https://datatracker.ietf.org/doc/html/draft-bhutton-relative-json-pointer-00)
from the object holding the field the region is declared on: a number of
levels to climb, then a JSON Pointer down from there.

```yaml
lists:
  type: array
  items:
    type: object
    properties:
      rows:
        type: array
        x-telo-eval: accessor
        x-telo-context:
          type: object
          properties:
            result: { x-telo-context-from-root: "outputModel" }
      columns:
        type: array
        x-telo-context:
          type: object
          properties:
            result: { x-telo-context-from-root: "outputModel" }
            row: { x-telo-context-element-from-item: "0/rows" }
        items:
          type: object
          properties:
            value: { x-telo-eval: accessor }
```

The context sits on the `columns` field, so the object holding it is the
`lists` item, and `0/rows` is that item's `rows`. With
`rows: !cel "result.files"`, `row` is one element of `files` as `outputModel`
declares it, and `value: !cel "row.pth"` is `CEL_UNKNOWN_FIELD` when a file has
no `pth`. A region on each column's own `value` field writes `2/rows` instead:
the column is the holder, one level up is the `columns` list, two levels up the
`lists` item.

The chain at the named field is typed exactly as at its own site, every region
covering it included — so `rows: !cel "data.items"`, rooted at a binding an
enclosing region declares, types `row` too. The element is an array's `items`,
or what an iterable value type declares as its element. When the data cannot be
followed to a collection — the field is a literal or absent, the root binding is
untyped, the chain passes through an open object or ends on something that is
not a collection — the binding is untyped and nothing is reported.

A pointer outside the grammar is `SCHEMA_VIOLATION`. One that climbs above the
resource (or, in a named shape, above the shape), names a member the schema
does not declare, lands at or beneath the field the region is declared on, or
names a field that declares no `x-telo-eval` is `ELEMENT_FROM_ITEM_INVALID`,
reported where it is written. The bare field name earlier releases wrote
(`rows`) is rewritten to `0/rows` when the manifest is loaded, with the warning
`DEPRECATED_ELEMENT_FROM_ITEM_FIELD`; `telo migrate` writes the rewrite to the
file.

## Typing a binding from whoever references the resource

A field of a form, declared as a resource of its own, cannot name the form's
model: the field kind does not know which form holds it. Its condition still
reads the form's record. `x-telo-context-from-referrer: "<binding>"` types a
binding from the binding of that name in scope at each slot that references the
resource:

```yaml
# on the field kind
shown:
  type: object
  x-telo-context:
    type: object
    properties:
      values:
        x-telo-context-from-referrer: values
        x-telo-context-eval: accessor
  properties:
    at: { x-telo-eval: accessor }
```

A form whose `fields` region binds `values` from its `model` then types
`shown.at: !cel "values.titel"` in every field it lists — written inline or by
`!ref` — as `CEL_UNKNOWN_FIELD`. A kind forwarding the binding to what it
references in turn (a field's `options` slot) declares the same annotation on a
region over that slot, and the chain is followed. A field two forms list is
judged under each form's type: a finding both make is reported once, one only
some make names the forms it holds for. With no referrer the binding is what it
declares itself, untyped when it declares nothing, so a field nothing lists yet
is not refused. The editor offers a member only when every referrer's type
declares it.

The annotation is legal only on a binding marked `x-telo-context-eval: accessor`
and nothing else, and never beside another `x-telo-context-from*`
(`CONTEXT_FROM_REFERRER_INVALID`).

### Entries that fill a record

A list whose entries each enter one member of a record — a form's fields —
says so on the binding: `x-telo-context-item-fills: ["", "/property"]` names the
member an entry fills, the first pointer that yields a string (`""` the entry
itself, a bare property name; `/property` the entry's `property`, read through
the declaration a reference names). An entry whose condition, or whose option
source's filter, reads a member that another entry fills depends on it; entries
depending on each other in a cycle — or one on the member it fills itself —
could never be entered first, and each read forming the cycle is
`CONTEXT_FILL_CYCLE`. The annotation is legal only on a binding of a region
declared on a list (`CONTEXT_ITEM_FILLS_INVALID`).

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
- Under a provider's implicit compile-eval, only the accessor field itself is
  left unevaluated: an expression beside it under the same top-level property is
  evaluated at creation. A `runtime` field still keeps its whole top-level
  property from being evaluated there.
- A kind that only forwards an accessor into a template body does not annotate
  its own field `accessor` — the entry that finally holds it does. Annotating
  both would deliver a binding into a field that then reads it as a literal.
- An accessor field's value is never text shown to a person: a `Text`,
  `Message` or `TextCatalog` at or beneath one — written there, or reached
  through a named shape — is refused at the kind, since the controller would
  receive a binding where it expects a text record. Text over data is a `Text`
  field of its own whose values are accessors: an object marked
  `x-telo-text-values-for` whose entries are accessor fields is read as its
  bindings, a literal's `{ value }` judged as that value and a chain's
  `{ root, path }` as a value its consumer resolves, typed by `telo check`.
