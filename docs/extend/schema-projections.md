---
sidebar_label: Schema Projections
slug: /extend/schema-projections
description: "Type what a resource's entries mean — a table's rows, an extraction's fields — as a JSON Schema its consumers are checked against, statically and at dispatch."
---

# Schema projections

A kind whose configuration is a **collection of typed entries** — a table's
columns, an extraction's fields — can say what that collection means as a JSON
Schema object, so whatever reads the resulting values is typed against the
entries one declaration lists. Three annotations, none of which names a domain:

- **`x-telo-schema-map`**, on the entry field the projection keys on, gives the
  schema each of its values means.
- **`x-telo-schema-projection`**, on the kind document beside `schema:`, names
  the entry collection, the keying field and the modifiers.
- **`x-telo-schema-projection-from`**, on a consumer's slot, names the
  declaration to project — a pointer to a reference, or the empty pointer `""`
  for the declaration the slot is written on. On a kind document it says what
  every declaration of that kind projects as.

```yaml
kind: Telo.Definition
metadata:
  name: Extraction
capability: Telo.Invocable
x-telo-schema-projection:
  entries: /fields
  key: type
  array: many
  nullable: nullable
  nested: fields
outputType:
  type: object
  properties:
    fields: { x-telo-schema-projection-from: "" }
schema:
  type: object
  $defs:
    Field:
      type: object
      properties:
        selector: { type: string }
        type:
          type: string
          enum: [text, number]
          x-telo-schema-map:
            text: { type: string }
            number: { type: number }
        many: { type: boolean, default: false }
        nullable: { type: boolean, default: false }
        fields:
          type: object
          additionalProperties: { $ref: "#/$defs/Field" }
  properties:
    fields:
      type: object
      additionalProperties: { $ref: "#/$defs/Field" }
```

A resource of that kind declaring `cards: { many: true, fields: { name: { type: text } } }`
types `steps.<step>.result.fields.cards[0].name` as a string, and
`…cards[0].nmae` is `CEL_UNKNOWN_FIELD`. The kernel enforces the same shape on
the value the resource returns.

## `x-telo-schema-projection`

| Key | Meaning |
| --- | --- |
| `entries` | JSON Pointer, from the resource root, to the collection — a keyed map, or an array. |
| `key` | The entry field whose value selects an `x-telo-schema-map` entry. |
| `name` | For an array collection: the entry field holding an entry's name. A keyed map's key is the name. |
| `array` | Entry field that, when true, wraps the entry's node in an array. |
| `nullable` | Entry field that, unless false, widens the entry's node to admit null. |
| `nested` | Entry field holding a sub-collection of entries of the same shape. An entry carrying it projects to the closed object that sub-collection projects to — recursively, with the same key, map and modifiers — and `array` / `nullable` then apply as for any entry. |
| `reference` | How an entry whose keyed field holds a `!ref` projects: `from` (the target field to read), `keyword` (the schema keyword its values become) and one of `base` / `baseFrom`. |

Modifiers apply in a fixed order: `array` wraps, then `nullable` widens. An
entry that omits a modifier reads the `default:` that applies to THAT entry: the
one its field declares in the entry schema, or the one declared in the `then` /
`else` of an `if` over the entry (at the entry schema's root or in one of its
`allOf` members), so a default may depend on the entry's other fields. With none
declared, `array` reads as false and `nullable` as true.

```yaml
# A primary key is NOT NULL whether or not it says so, so it projects non-null.
allOf:
  - if:
      anyOf:
        - { required: [primaryKey], properties: { primaryKey: { const: true } } }
        - { required: [identity] }
    then: { properties: { nullable: { default: false } } }
    else: { properties: { nullable: { default: true } } }
```

The `if` is evaluated as JSON Schema against the entry as written. A computed
value (`!cel`) is not a literal, so it matches no `const` and the entry lands in
the branch that does not rely on it. A default declared in more than one place —
on the field and in a branch, or in two conditionals — is
`SCHEMA_PROJECTION_INVALID` at the kind, since nothing says which would apply; so
is an `if` that does not compile as JSON Schema.

Each entry projects to a node of a **closed** object — `additionalProperties:
false` — so a name the declaration does not list is refused. An entry whose value
has no map entry projects to nothing; an entry whose reference cannot be read
projects open and is reported.

## `x-telo-schema-projection-from`

The pointer is relative to the declaration carrying the slot and **crosses
references**: each segment after a reference continues inside the declaration
that reference names, to any depth. `/relationship/source` reads the slot
`relationship`, follows it to its declaration, and reads that declaration's
`source`. What counts as a reference is decided by the holding declaration's
KIND: a path its schema declares as an `x-telo-ref` slot holds one (a `!ref`, or
an inline declaration, which is continued into), and any other path holds data,
whatever its shape — a field holding `{ kind, name }` is never followed. A
declaration whose kind resolves to no definition stops the walk.

Every hop is resolved in the scope of the module that declared the declaration
holding the reference — a library's `person` naming `!ref users` means that
library's `users`, whoever projects through it, exported or not; a library's
resource input means what the importer the walk came through supplies for it. A
name that scope does not declare resolves to nothing, never to another module's
resource of the same name.
Resolving a hop needs declarations only, never a live instance, so a `use:
schema` target declared after the consumer projects the same, and `telo check`
types a slot exactly as the kernel binds it.

The object form narrows what is projected:

| Key | Meaning |
| --- | --- |
| `from` | The pointer above. |
| `pick` | Pointer to a field holding ONE entry name; the slot is typed as that entry's projected schema. |
| `omit` | Pointers, each to a field holding an entry name; the projection is taken without those entries. |

Every pointer may cross references, and a selector must hold a literal name — one
an expression computes is refused, since the slot is typed before anything runs.

```yaml
inputType:
  type: object
  properties:
    # the node's entries, without its key
    properties: { x-telo-schema-projection-from: { from: /node, omit: [/node/key] } }
    # the one entry the node's key names
    key: { x-telo-schema-projection-from: { from: /node, pick: /node/key } }
    # through the relationship to the node it names as its source
    source: { x-telo-schema-projection-from: { from: /relationship/source, pick: /relationship/source/key } }
```

### On a kind document

Written on a `Telo.Definition` beside `schema:` — a string, or the object form
without `pick` — it declares what every declaration of the kind projects as. A
kind that holds no entries of its own derives its projection from a declaration
it references:

```yaml
kind: Telo.Definition
metadata:
  name: Node
x-telo-schema-projection-from: { from: /table, omit: [/secret] }
schema:
  type: object
  properties:
    table: { x-telo-ref: { kind: Self.Table, use: schema } }
    secret: { type: string }
```

A consumer slot pointing at a `Node` is typed exactly as if it pointed at the
node's table, less the entry its `secret` names.

## What is checked

- The annotation is closed: an unknown key is `SCHEMA_PROJECTION_INVALID`.
- `nested` must name an entry field holding a collection whose entries are the
  same schema as the projection's — inline, or a local `$ref` to it — or it is
  `SCHEMA_PROJECTION_INVALID`.
- A map missing a value of the key field's `enum` is `SCHEMA_MAP_INCOMPLETE`.
- `x-telo-schema-projection-from` in the object form is closed: an unknown key,
  a `from` that is not a pointer, or a malformed `pick` / `omit` is
  `SCHEMA_PROJECTION_INVALID`. So is a kind document declaring it beside
  `x-telo-schema-projection`, or with `pick`. It is reported wherever it is
  written inside a schema — a definition's contracts, a resource's own
  `inputType:` / `outputType:`, a `Telo.JsonSchema`'s `schema:` — and on a kind
  document.
- A consumer slot that cannot be projected is `SCHEMA_PROJECTION_FROM_UNRESOLVED`
  statically and `ERR_SCHEMA_PROJECTION_UNRESOLVED` when the resource is created
  — a hop that yields no single declaration (none in that scope, ambiguous, not a
  reference), kind-level derivations that lead back to a declaration already on
  the path, a selector naming an entry the projection does not have, holding no
  name or landing on an expression, and an entry that contains itself through
  `nested` (a YAML alias), which is projected open rather than followed forever.
  The message names the pointer prefix where resolution stopped and the
  declaration holding it. A malformed annotation also fails creation, as the
  second code, where a consumer's own check is silent about a dependency's kind.
- A value computed at run time that violates the derived contract is
  `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` at dispatch.
