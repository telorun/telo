---
description: "Html.JsonTree: parsing HTML text or bytes into a page tree, charset sniffing, fragments and the base URL rule"
sidebar_label: Parsing
---

# Parsing

`Html.JsonTree` turns HTML into an `Html.Parsed` page. It takes no configuration.

```yaml
- name: parse
  invoke: { kind: Html.JsonTree }
  inputs:
    html: !cel "steps.fetch.result.body"
    baseUrl: https://example.com/post/1
```

| Input | Meaning |
| --- | --- |
| `html` | The page, as text — or as `{ bytes, charset? }` for undecoded bytes. |
| `fragment` | Parse as a fragment: no implied `<html>`, `<head>` or `<body>`. Default `false`. |
| `baseUrl` | The page's own URL. |

Parsing follows the HTML standard's tree construction algorithm, so the tree is
the one a browser builds — implied elements, misnested formatting elements and
foster-parented table content included — and it **never fails**: there is no
malformed input, only input the algorithm recovers from. Scripting is treated as
enabled, so the contents of `<noscript>` are text.

A fragment is parsed as the contents of a `<template>` element — the fragment
parsing algorithm with `template` as its context — so table parts such as a lone
`<tr>` survive. `Html.Markup` reads a fragment back in the same context.

## Bytes and charsets

```yaml
inputs:
  html:
    bytes: !cel "steps.fetch.result.body"
    charset: iso-8859-2   # what the transport declared, if anything
```

The encoding is decided by the HTML encoding sniffing algorithm, in this order:

1. a byte order mark (UTF-8, UTF-16LE, UTF-16BE) — it overrides everything;
2. `charset`, the encoding the transport declared (a `Content-Type` parameter),
   written as any lowercase label of the Encoding Standard (`utf-8`, `latin1`,
   `windows-1250`, `shift_jis`, …);
3. a `<meta charset>` or `<meta http-equiv="Content-Type">` found by prescanning
   the first 1024 bytes;
4. UTF-8.

Decoding never fails: a byte sequence the encoding cannot read becomes U+FFFD.
`charset` belongs to the bytes form only — beside a text `html` it is a
`telo check` error, since text is already decoded.

## The base URL

`Html.Parsed.baseUrl` is the page's effective base URL, the one its relative links
resolve against, decided as the HTML standard decides it:

- the first `<base href>` in the document, resolved against `baseUrl`;
- otherwise `baseUrl` itself.

With no `baseUrl` supplied, only an absolute `<base href>` gives the page a base;
a relative one resolves against nothing, so the page has no base URL and relative
links stay as written. Nothing is inferred.

The base URL travels with the page: `Selection` and `SafeTree` carry it into their
output, and `Metadata`, `Markdown` and `MainContent` resolve relative URLs against
it.
