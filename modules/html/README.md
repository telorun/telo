# HTML

Read, query and transform web pages. Parse HTML once into a plain-data tree that
CEL can read, then select, extract, sanitize, render or summarize it — each step
takes the parsed page and returns a value, so one parse feeds a whole pipeline.

## Why use this

- **One standards-conformant parse.** Pages are parsed with the WHATWG tree
  construction algorithm, the one browsers run, so malformed markup produces the
  same tree it would in a browser, and parsing never fails. Bytes in any charset
  are decoded by the same sniffing rules.
- **A tree CEL can read.** The parsed page is ordinary data —
  `node.type == 'element' && 'href' in node.attrs` — typed as `Html.Node` (a
  misspelled top-level field such as `result.nodse` is a `telo check` error;
  fields of a node are checked when the value is produced).
- **Typed scraping.** Declare the fields to read with CSS selectors; the result is
  typed from the declaration, so `result.fields.cards[0].nmae` is caught before
  anything runs.
- **Sanitizing by allowlist.** Untrusted markup is reduced to what a policy lists,
  with URL schemes checked, event handlers unrepresentable, and three presets for
  the common cases.
- **Selectors checked statically.** Every selector is validated against the
  Selectors Level 4 grammar by `telo check`, naming where it goes wrong.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Html.JsonTree` | Parse text or bytes (any charset) into an `Html.Parsed` page. |
| `Html.Selection` | The elements matching a CSS selector, with their subtrees. |
| `Html.Extraction` | Typed values read with CSS selectors: text, markup, attributes, numbers, nested records. |
| `Html.SafeTree` | Sanitize against an allowlist of elements, attributes and URL schemes. |
| `Html.Markup` | Serialize a page back to HTML text that reads back as the same tree, refusing a tree whose markup would read back differently. |
| `Html.PlainText` | The text a browser shows. |
| `Html.Markdown` | Convert to Markdown, with GitHub-flavored tables and task lists. |
| `Html.Metadata` | Title, language, meta tags, links and JSON-LD. |
| `Html.MainContent` | The main article, stripped of navigation and ads. |

Every kind but `JsonTree` takes `{ document: <Parsed> }` — write
`document: !cel "steps.<parse>.result"`.

## Exported resources

| Name | What it is |
| --- | --- |
| `Html.Node`, `Html.Parsed` | The value shapes, for a contract of your own (`!ref Html.Parsed`). |
| `Html.escape(text)`, `Html.unescape(text)` | CEL functions: encode `& < > " '` / decode character references. |
| `Html.stripAll`, `Html.basicFormatting`, `Html.richContent` | Sanitize presets, invoked with `invoke: !ref Html.basicFormatting`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: ArticleToMarkdown }
imports:
  Html: oci://ghcr.io/telorun/html@0.1.0
  Run: oci://ghcr.io/telorun/run@0.27.1
targets:
  - !ref convert
---
kind: Run.Sequence
metadata: { name: convert }
steps:
  - name: parse
    invoke: { kind: Html.JsonTree }
    inputs:
      html: <html><body><nav>Home</nav><article><h1>Hi</h1><p>A long article…</p></article></body></html>
      baseUrl: https://example.com/post
  - name: main
    invoke: { kind: Html.MainContent }
    inputs: { document: !cel "steps.parse.result" }
  - name: markdown
    invoke: { kind: Html.Markdown }
    inputs: { document: !cel "steps.main.result.content" }
outputs:
  markdown: !cel "steps.markdown.result.markdown"
```

## Documentation

- [The node format and CEL idioms](./docs/node-format.md)
- [Parsing, charsets and the base URL](./docs/parsing.md)
- [Selectors](./docs/selectors.md)
- [Extraction](./docs/extraction.md)
- [Sanitizing](./docs/sanitize.md)
- [Markup, plain text and Markdown](./docs/rendering.md)
- [Metadata](./docs/metadata.md)
- [Main content](./docs/main-content.md)
- [Pipelines](./docs/pipelines.md)
