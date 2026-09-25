---
description: "Html.Selection and the css-selector format: which selectors are accepted, and how each one matches a parsed page"
sidebar_label: Selectors
---

# Selectors

Every selector field — `Html.Selection`'s `selector` and each `Html.Extraction`
field's, nested ones included — is a string of the Telo format `css-selector`:
a Selectors Level 4 selector list with

- no pseudo-elements (`p::before`) — they select no element;
- no namespace prefixes (`svg|a`);
- no leading combinator (`> a`) — write `:scope > a`. A relative selector is
  valid only inside `:has()` (`:has(> img)`, `:has(+ p)`), and `:has()` does not
  nest.

`telo check` refuses anything else on the field's own line, naming where it goes
wrong (`Expected attribute name at offset 3 of "div["`). A selector may also be
computed with `!cel` (see [Extraction](./extraction.md) for which fields); the
kernel then checks the value the expression produced when the resource is
created, with the same message.

## Matching

Every selector the grammar accepts is evaluated as the Selectors Level 4 and HTML
standards define it, against the parsed page as a static document. The page is
the document: a selector sees the whole tree, so `:not(nav a)`, `:is(article p)`
and a nested extraction field's selector all see ancestors above where the match
is looked for. A `<template>`'s contents are not searched, as in a browser.

- **Case.** A type selector and an attribute name match an HTML element
  case-insensitively and an SVG or MathML element case-sensitively
  (`foreignObject`, `[viewBox]`). Classes and ids always match exactly — there is
  no quirks mode. The attribute values HTML lists as case-insensitive (`type`,
  `dir`, `rel`, `method`, `lang`, `checked`, …) compare case-insensitively on an
  HTML element; every other value compares exactly unless the selector adds the
  `i` flag (`[data-state=open i]`), and `s` forces an exact comparison.
- **Structure.** `:nth-child(An+B of S)` and `:nth-last-child(An+B of S)` count
  only the siblings matching `S`, which may be a list. `:is()`, `:where()`,
  `:not()` and `:has()` take complex selectors; `:has(+ S)` and `:has(~ S)` look
  at later siblings. `:empty` treats white space as empty, as Selectors Level 4
  says. `:root` is the page's top-level `<html>` element, and `:scope` is the
  element a nested extraction field is matched from (the root at the top).
- **Tables.** The column combinator (`col || td`, `colgroup || td`) and
  `:nth-col()` / `:nth-last-col()` follow the HTML table model: `colspan`,
  `rowspan` and a column group's `span` decide which columns a cell and a column
  element occupy.
- **Forms.** `:checked`, `:default`, `:indeterminate`, `:enabled`, `:disabled`,
  `:required`, `:optional`, `:read-only`, `:read-write`, `:placeholder-shown`,
  `:blank`, `:in-range`, `:out-of-range`, `:valid` and `:invalid` are answered from
  the markup: a value is the `value` attribute (a textarea's text), checkedness is
  `checked`, a radio group is its `name` within its form, a disabled `fieldset`
  disables its controls outside its first `legend`, and validity is the HTML
  constraint validation of those values (required, email / URL syntax, `pattern`,
  `min` / `max`, `step`). A length limit never applies — it constrains only a value
  a user typed. A form or fieldset holding an invalid control is `:invalid`.
- **Language and direction.** `:lang()` reads the nearest `lang` / `xml:lang` and
  matches by extended language-range filtering (`:lang(de, "*-CH")`); `:dir()`
  reads the nearest `dir`, resolving `dir="auto"` (and `<bdi>`) from the first
  strongly directional character.
- **Links and elements.** `:any-link` and `:link` match an `<a>` or `<area>` with
  an `href` — nothing has been visited. `:defined` matches every built-in element;
  an autonomous custom element (`<my-widget>`) is not defined in a parsed page.

**What matches nothing.** A pseudo-class that needs interaction, a live user agent
or state a parsed page does not carry is valid syntax and matches no element:
`:hover`, `:active`, `:focus`, `:focus-within`, `:focus-visible`, `:visited`,
`:target`, `:target-within`, `:local-link`, `:user-invalid`, `:playing`,
`:paused`, `:modal`, `:fullscreen`, `:picture-in-picture`, `:popover-open`,
`:autofill`, `:loading`, `:state()`, `:current`, `:past` and `:future`.

These rules are the bar for every controller of these kinds, in any language:
`modules/html/tests/selector-matching.yaml` has one case per construct.

## `Html.Selection`

```yaml
- name: articles
  invoke:
    kind: Html.Selection
    selector: article, main > section
  inputs: { document: !cel "steps.parse.result" }
```

Returns an `Html.Parsed` whose `nodes` are the matching elements, each with its
whole subtree, in document order, carrying the input's `baseUrl`. A match inside
another match appears twice — once on its own and once inside its ancestor.
