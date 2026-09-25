---
description: "Html.Extraction: typed scraping with CSS selectors — fields, nested records, nullability and failure codes"
sidebar_label: Extraction
---

# Extraction

`Html.Extraction` reads typed values out of a page. Each field names where the
value is and what to read; the result is `{ fields: … }`, typed from the
declaration itself.

```yaml
- name: shop
  invoke:
    kind: Html.Extraction
    fields:
      heading: { selector: h1, type: text }
      logo: { selector: header img, type: attr, attr: src, nullable: true }
      products:
        selector: .product
        many: true
        fields:
          name: { selector: ":scope > h2", type: text }
          price: { selector: .price, type: number }
          stock: { selector: .stock, type: integer }
          tags: { selector: .tag, type: text, many: true }
  inputs: { document: !cel "steps.parse.result" }
```

`steps.shop.result.fields.products[0].price` is a `number`, and
`…products[0].prise` is a `telo check` error (`CEL_UNKNOWN_FIELD`).

## A field

| Key | Meaning |
| --- | --- |
| `selector` | Where the value is (a `css-selector`). |
| `type` | What to read — see below. |
| `attr` | The attribute to read; required exactly when `type: attr`. |
| `many` | Read every match as a list; `[]` when nothing matches. Default `false`. |
| `nullable` | Yield `null` when nothing matches instead of failing. Default `false`. |
| `fields` | A record read from each match, in place of `type`. |

A field has exactly one of `type` and `fields`, and a `many` field cannot be
`nullable` — an empty list already says nothing matched. Each rule is a
`SCHEMA_VIOLATION` on the field that breaks it.

`selector` and `attr` may be computed, at any depth — `selector: !cel
"variables.itemSelector"` — and are evaluated once, when the resource is created.
`telo check` types each expression as a string (`CEL_TYPE_ERROR` otherwise); a
computed selector outside the grammar, or a `dyn` selector result that is not a
string, is refused at creation, naming the field (`/fields/items/selector`); a
`dyn` `attr` result is not checked at creation. `type`, `many`, `nullable` and `fields` are literal
only, because they decide the TYPE of the result, which `telo check` reads from
the declaration before anything runs; a `!cel` there is `CEL_IN_NON_EVAL_FIELD`.

| `type` | Value | Typed as |
| --- | --- | --- |
| `text` | The match's rendered text (its plain-text rendering) | `string` |
| `html` | The match's outer markup, written as `Html.Markup` writes it | `string` |
| `attr` | The raw value of the attribute `attr` | `string` |
| `number` | The rendered text, trimmed, parsed as a decimal number | `number` |
| `integer` | The rendered text, trimmed, parsed as an integer | `integer` |

## Matching

- A top-level field's selector runs over the whole page; a nested field's runs
  relative to each match of the field around it. `:scope` is that match, so a
  direct child is `:scope > h2` and the match itself is `:scope`.
- A single field reads the **first** match; when that match lacks the attribute
  an `attr` field reads, the field is missing (or `null` when `nullable`). In a
  `many` field, matches without the attribute are left out of the list.
- Nothing is converted silently: `number` accepts `3.5`, `-2`, `1e3`; `integer`
  accepts `12`, `-3`. Anything else — `12 items`, an empty string — fails; neither
  ever yields `NaN` or `null` for text that does not parse.

## Failures

| Code | When |
| --- | --- |
| `ERR_HTML_FIELD_MISSING` | A field that is neither `many` nor `nullable` matched nothing (or only an element without its attribute). A nested record that matched nothing is missing the same way. |
| `ERR_HTML_FIELD_CONVERSION` | A `number` or `integer` field matched text that does not parse. |
| `ERR_HTML_NOT_SERIALIZABLE` | An `html` field matched an element whose markup, written on its own, would not read back as that element — the readback `Html.Markup` makes (see [Markup](./rendering.md#faithful-or-refused)), with the match as the whole tree. A match that cannot stand alone is refused: `head`, `body`, and a foreign element other than an `svg` or `math` root (a `circle` alone reads back as an HTML element). The message also names the first differing node's path (`nodes[0].children[2]`) and what it reads back as. |

Every message names the field by its path (`products.price`) and the resource.

Nullability is part of the type: a `nullable: true` field is typed as admitting
`null`, so guard it before reading into it (`fields.logo != null ? … : …`).
