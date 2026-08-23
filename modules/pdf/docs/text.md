---
description: "Pdf.Text: read the text a PDF renders, per page"
sidebar_label: Pdf.Text
---

# Pdf.Text

> Examples below assume this module is imported with an `imports:` entry under alias `Pdf`. Kind references follow that alias — substitute your own if you import it under a different name.

Extracts the text a PDF renders, as one string per page and as the whole document, and reports the document's page count.

The counterpart to `Pdf.Rasterizer`. Rasterizing answers *what does this page look like* — a question about pixels, whose answer moves with the platform's font rasterization. This answers *what does it say*, which is what an assertion about a generated document needs: a page image cannot tell a correct table from an empty one.

---

## Example

Render a document and check what came out:

```yaml
- name: render
  invoke: !ref customerReport
  inputs: { customer: Acme Ltd, rows: !cel "inputs.rows" }
- name: read
  invoke: !ref readText
  inputs: { data: !cel "steps.render.result.bytes" }
```

---

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | `Uint8Array` | yes | Buffered PDF bytes. |
| `page` | integer ≥ 1 | no | Read only this page. Every page is read when omitted. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Every page read, joined with a line break. |
| `pages` | string[] | One entry per page read — the whole document, or just `page`. |
| `pageCount` | integer | How many pages the document has, whatever `page` selected. |

---

## Reading order

Items are joined in the order pdf.js reports them, with a line break at each end-of-line marker. That is reading order for ordinary flowed content, and it is **not** a layout reconstruction: a multi-column page reads column by column, in the order the producer wrote it, not the order a human's eye would take across the page. Nothing here infers columns, tables or paragraphs — a table reads as its cells in row order.

A PDF whose text is an image (a scan) has no text to extract and returns empty strings; rasterize it and use a vision model instead.

## Errors

`ERR_INVALID_INPUT` — `data` is not a `Uint8Array`, the bytes are not a parseable PDF, or `page` is past the end of the document. The message names the actual page count.
