---
description: "Html.Node and Html.Parsed: the plain-data page tree every html kind reads and returns, and how to walk it in CEL"
sidebar_label: Node format
---

# The node format

A parsed page is an `Html.Parsed`:

```yaml
nodes: [<Html.Node>, …]   # the top-level nodes, in document order
baseUrl: https://…        # the effective base URL, when one is known
```

An `Html.Node` is one of four shapes, told apart by `type`:

| `type` | Fields |
| --- | --- |
| `element` | `tag`, `attrs`, `children`, and `namespace` for a foreign element |
| `text` | `text` |
| `comment` | `text` |
| `doctype` | `name`, `publicId`, `systemId` |

- **`tag`** is the element's local name. It is a letter followed by anything but
  whitespace, `/` and `>` (`^[A-Za-z][^\t\n\f\r />]*$`) — the characters a start
  tag's name can hold.
- **`namespace`** is `svg` or `mathml` on a foreign element and absent on an HTML
  one — there is no `html` value.
- **`attrs`** holds each attribute under the qualified name the parser produced
  (`href`, `data-id`, `xlink:href`, `viewBox`), in document order, with its raw
  value: character references decoded, nothing else. A boolean attribute is `""`.
  Nothing is coerced — `class` is one string, not a list. When the source repeats
  an attribute, the first one wins. A name holds no whitespace, `/` or `>`, and no
  `=` after its first character (`^[^\t\n\f\r />][^\t\n\f\r />=]*$`).
- **`children`** of a `<template>` are its template contents.
- A doctype's absent public or system identifier is `""`.
- Nodes carry no source positions and no parent links.

The shape is closed and flat: it has no root-level union, so the kernel validates every
node against it; `telo check` does not yet type fields read inside a node.

## Case and names

The parser lowercases every tag and attribute name, then restores the case of the
names the HTML standard adjusts in foreign content. So a node holds only a name
the parser could have produced:

- an **HTML** or **MathML** tag has no ASCII uppercase letter;
- an **SVG** tag has uppercase only when it is one of the adjusted names
  (`foreignObject`, `clipPath`, `linearGradient`, `feGaussianBlur`, …), and is
  never the lowercase spelling of one (`foreignobject`);
- an attribute name has no uppercase on an HTML element, and on a foreign element
  only when it is an adjusted name — `viewBox`, `preserveAspectRatio`, … on SVG,
  `definitionURL` on MathML;
- an element with no `namespace` is never `svg`, `math` or `image` — the parser
  puts the first two in their foreign namespace and turns `image` into `img`.

`feDropShadow` is accepted in both spellings, since the parser in use does not
adjust it.

These rules and the name alphabets are context-free, so a node written as a
literal is checked by `telo check` and one computed in CEL by the kind's input
contract (`ERR_INPUT_INVALID`): a tag of `img src=x onerror=…` cannot smuggle
attributes into markup, and `TITLE` cannot hide a comment from the `title` end
tag. What depends on where a node stands — a namespace the parser would not give
it there, a comment or raw text that would end early, an element where only text
can be — is refused when the tree is serialized (see
[Markup](./rendering.md#faithful-or-refused)).

## Reading it in CEL

```yaml
# Every link on the page, with its target.
links: !cel >-
  steps.select.result.nodes.filter(n, n.type == 'element' && 'href' in n.attrs)
    .map(n, n.attrs['href'])

# The text of a text node, or '' for anything else.
text: !cel "node.type == 'text' ? node.text : ''"
```

Test `type` before reading a field only one shape carries, and test an attribute
with `in` before reading it: `attrs` holds only the attributes the element has.

To declare a contract of your own over the same shape, reference it with
`!ref Html.Parsed` or `!ref Html.Node`.

## Implementing a controller

Every controller that produces this tree — in any language — must build it with a
WHATWG-conformant HTML tree builder: the tree for a given input is defined by the
HTML standard's tree construction algorithm, not by the parser that happens to be
in use.
