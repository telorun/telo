---
description: "Html.Metadata: a page's title, language, meta tags, Open Graph properties, links and JSON-LD"
sidebar_label: Metadata
---

# Metadata

`Html.Metadata` takes `{ document: <Parsed> }` and returns:

| Field | Value |
| --- | --- |
| `title` | The first HTML `<title>`, with whitespace stripped and collapsed. Absent when there is none. |
| `lang` | The root `<html>` element's `lang`. |
| `baseUrl` | The page's base URL. |
| `meta` | Each `<meta>` `name` **and** `property` value, mapped to the `content` values carrying it, in document order: `meta['og:image']` is a list. A `<meta>` with no `content` (`charset`, most `http-equiv`) is skipped. |
| `links` | Every `<link>` with an `href`: `rel` (the link types, lowercased), `href` resolved against the base URL, and `type`, `hreflang`, `sizes`, `media` and `title` when present. |
| `jsonLd` | Each `<script type="application/ld+json">` in document order, as `{ value }` — the parsed JSON — or `{ error }` when it is not valid JSON. A malformed block is reported, never dropped. |

Only the document itself is read: a `<template>`'s contents and SVG or MathML
elements (an SVG `<title>`) contribute nothing.

```yaml
- name: meta
  invoke: { kind: Html.Metadata }
  inputs: { document: !cel "steps.parse.result" }
- name: summary
  value:
    title: !cel "steps.meta.result.title"
    image: !cel "'og:image' in steps.meta.result.meta ? steps.meta.result.meta['og:image'][0] : ''"
```
