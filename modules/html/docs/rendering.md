---
description: "Html.Markup, Html.PlainText and Html.Markdown: rendering a page tree as HTML, plain text or Markdown"
sidebar_label: Markup, text and Markdown
---

# Markup, plain text and Markdown

Each takes `{ document: <Parsed> }`.

## `Html.Markup` → `{ html }`

The HTML fragment serialization algorithm, applied to each top-level node in turn:
void elements have no end tag, text inside `script`, `style` and the other raw-text
elements is written as it is, other text and attribute values have `&`, `<`, `>`,
non-breaking spaces (and `"` in attributes) escaped, and SVG and MathML elements
are written with explicit end tags. A doctype's public and system identifiers are
written too (an identifier holding `"` is quoted with `'`), and a leading newline
in `pre`, `textarea` or `listing` is doubled so the parser keeps it.

### Faithful or refused

Markup writes only markup that reads back as the tree it was given, and checks
that by reading it back: the output is parsed again by the WHATWG tree builder
and compared with the tree.

- **Context.** A tree whose top level holds an `html` element reads back as a
  document; any other tree reads back as a fragment, parsed as the contents of a
  `<template>` — the context `Html.JsonTree` uses for `fragment: true`.
- **Comparison.** Node type, tag, namespace and text are compared exactly, and
  attributes as a map (their order does not matter). Text is compared after DOM
  normalization: adjacent text nodes are merged and empty ones dropped.
- **Refusal.** A tree that does not read back as itself is refused with
  `ERR_HTML_NOT_SERIALIZABLE`, naming the path of the first differing node from
  the document (`nodes[0].children[2]`) and what it reads back as.

A tree assembled in CEL or by hand is refused, for example, for:

- a **comment** whose text ends it early (`-->`, `--!>`, a leading `>` or `->`);
- **raw text** holding its element's end tag — a `style` text of
  `</style><img onerror=…>` — or a `script` text leaving an escaped `<!--` section
  open (a legacy `<script><!-- document.write("<script></script>") --></script>`
  reads back unchanged and is written);
- anything but text inside a **text-only element** (`script`, `style`,
  `textarea`, `title`, …), or a **child of a void element** (`img`, `br`, …);
- a **namespace** the parser would not give the node where it stands — an SVG
  `style` at the top level, or an HTML `style` directly inside `svg`;
- a **doctype** no quoting can carry, or text holding a carriage return.

A tree the parser built reads back as itself unless its markup reparses as a
different tree, and then it is refused too: nested forms (the
`<form><math><mtext></form><form><mglyph><style>` mutation), nested formatting
elements (an `<a>` foster-parented inside another `<a>`), a `plaintext` element,
and a `script` cut off inside `<!--` (a page truncated inside a legacy script).

`Html.SafeTree`'s output always serializes. Every controller implementing Markup
must refuse the same trees.

## `Html.PlainText` → `{ text }`

The HTML `innerText` algorithm evaluated with the default user-agent stylesheet
and no author CSS: whitespace collapses as the browser collapses it, block
elements and paragraphs are separated by line breaks, `<br>` is a line break,
table cells are separated by tabs, and elements a browser does not render
(`script`, `style`, `head`, `template`) contribute nothing.

## `Html.Markdown` → `{ markdown }`

```yaml
- name: markdown
  invoke:
    kind: Html.Markdown
    bullet: "-"
    headingStyle: atx
  inputs: { document: !cel "steps.main.result.content" }
```

| Config | Values | Default |
| --- | --- | --- |
| `gfm` | GitHub Flavored Markdown: tables, `~~strikethrough~~`, task lists, autolinks | `true` |
| `headingStyle` | `atx` (`# Title`) or `setext` (underlined, for the first two levels) | `atx` |
| `bullet` | `-`, `*` or `+` | `*` |
| `fence` | `` ` `` or `~` | `` ` `` |
| `emphasis` | `*` or `_` | `*` |
| `strong` | `*` or `_` | `*` |
| `ruleStyle` | `-`, `*` or `_` | `*` |

Relative link and image URLs are made absolute against `document.baseUrl` when the
page has one. With `gfm: false` the output is plain CommonMark: a strikethrough
becomes its text, a task-list checkbox is dropped, and a table becomes one
paragraph per row with its cells separated by a space.
