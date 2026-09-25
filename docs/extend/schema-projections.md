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
- **`x-telo-schema-projection-from`**, on a consumer's slot, names the reference
  whose target declares one — or, as the empty pointer `""`, the declaration the
  slot is written on.

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
entry that omits a modifier reads the `default:` its field declares in the entry
schema; with none declared, `array` reads as false and `nullable` as true.

Each entry projects to a node of a **closed** object — `additionalProperties:
false` — so a name the declaration does not list is refused. An entry whose value
has no map entry projects to nothing; an entry whose reference cannot be read
projects open and is reported.

## What is checked

- The annotation is closed: an unknown key is `SCHEMA_PROJECTION_INVALID`.
- `nested` must name an entry field holding a collection whose entries are the
  same schema as the projection's — inline, or a local `$ref` to it — or it is
  `SCHEMA_PROJECTION_INVALID`.
- A map missing a value of the key field's `enum` is `SCHEMA_MAP_INCOMPLETE`.
- A consumer slot that cannot be projected is `SCHEMA_PROJECTION_FROM_UNRESOLVED`
  statically and `ERR_SCHEMA_PROJECTION_UNRESOLVED` at dispatch — including an
  entry that contains itself through `nested` (a YAML alias), which is projected
  open rather than followed forever.
