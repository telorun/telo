---
description: "PdfMake.Document: render a declared document to PDF bytes"
sidebar_label: PdfMake.Document
---

# PdfMake.Document

> Examples below assume this module is imported with an `imports:` entry under alias `PdfMake`. Kind references follow that alias — substitute your own if you import it under a different name.

Renders a declared document — page setup, named styles, embedded fonts, background, header and footer, and a tree of content nodes — to PDF bytes.

The content expressions are evaluated **per invocation**, so one resource is a report template: invoke it once per customer and each rendering carries that customer's data.

---

## Example

```yaml
kind: PdfMake.Document
metadata: { name: customerReport }
pageSize: A4
pageMargins: [40, 60, 40, 60]
defaultStyle: { fontSize: 10 }
styles:
  heading: { fontSize: 18, bold: true, color: "#1B36C4" }
  totalsRow: { bold: true, color: "#1B36C4" }
header:
  - text: Invoice
    style: heading
    margin: [40, 20, 40, 0]
content:
  - text: !cel "'Customer: ' + inputs.customer"
    style: heading
  - table:
      headerRows: 1
      widths: [ "*", auto, auto ]
      body: !cel "inputs.rows"
    layout:
      hLineWidth: 0.5
      hLineColor: "#1B36C4"
      headerFillColor: "#1B36C4"
```

Invoked with `{ customer: "Acme Ltd", rows: [...] }`.

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `Node[]` | yes | The document body, top to bottom. Expressions inside read that rendering's `inputs`. |
| `pageSize` | name or `{width, height}` | no | `A0`–`A6`, `LETTER`, `LEGAL`, `TABLOID`, `EXECUTIVE`, or explicit points. Default `A4`. |
| `pageOrientation` | `portrait` \| `landscape` | no | Default `portrait`. |
| `pageMargins` | number[] | no | `[left, top, right, bottom]`, `[horizontal, vertical]`, or one value for all four. |
| `inputType` | type | no | The data one rendering takes. Declare it and every call site is checked against it. |
| `defaultStyle` | `Style` | no | Presentation every node inherits unless it overrides it. |
| `styles` | map of `Style` | no | Named presentation a node applies by naming it in `style`. |
| `fonts` | map | no | Brand fonts, each a reference to a `Font.Family`. See below. |
| `images` | map of strings | no | Named raster images an `image` node refers to, as data URIs. |
| `background` | `Node[]` | no | Drawn behind every page — a full-bleed graphic or watermark. |
| `header` / `footer` | `Node[]` | no | Repeated at the top / bottom of every page. |
| `info` | object | no | PDF metadata: `title`, `author`, `subject`, `keywords`, `creator`, `producer`. |
| `compress` | boolean | no | Default `true`. |
| `userPassword` / `ownerPassword` | string | no | Required to open the document / to change its permissions. |

## Invocation inputs

Whatever the document's expressions read, as `inputs.<name>`. Any argument map is accepted until the resource declares `inputType:`; declaring one is what turns "this is a template" into a checked claim — a caller passing `custmer` is then a `telo check` error rather than an empty field in the rendered PDF:

```yaml
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [customer, rows]
    additionalProperties: false
    properties:
      customer: { type: string }
      rows: { type: array }
```

## Output

| Field | Type | Description |
|-------|------|-------------|
| `bytes` | `Uint8Array` | The rendered PDF. |

Read the result back with `Pdf.Text` to assert its content or learn its page count.

---

## The content vocabulary

`content`, `background`, `header` and `footer` all hold nodes of the exported `Node` shape. A node is discriminated by **which key it carries** — the way pdfmake discriminates them, with no added `type` field — so a pdfmake example pastes in unchanged:

| Key | Node |
|-----|------|
| `text` | A run of text, or several runs with their own styling. |
| `table` | Rows of cells, with optional repeating `headerRows` and a `layout`. |
| `columns` | Nodes side by side. |
| `stack` | Nodes one under another, styled or sized as one. |
| `ol` / `ul` | Ordered and unordered lists. |
| `image` | A raster image, as a data URI or a name from `images`. |
| `svg` | Vector artwork as SVG markup. |
| `canvas` | Vector primitives — rules, boxes, card backgrounds. |
| `pageBreak` | Starts a new page. |

Every node also accepts the presentation keys its entry declares — `style`, `margin`, `alignment`, `fontSize`, `color` and so on. Each branch is closed, so a misspelled key is an error rather than a silently ignored one; when a node matches nothing, the failure names the alternatives by the key each requires.

A table cell may be a node, or a bare string or number as shorthand for a text node.

A named style — and `defaultStyle` — is **closed**: a misspelled key is a `telo check` error rather than a setting pdfmake silently ignores at render.

## Fonts

Each entry in `fonts` maps the name a style writes in `font:` to a `Font.Family`:

```yaml
kind: Font.Family
metadata: { name: brand }
family: Brand Sans
faces:
  normal: !include-bytes assets/Brand-Regular.ttf
  bold: !include-bytes assets/Brand-Bold.ttf
---
kind: PdfMake.Document
metadata: { name: statement }
fonts:
  Brand: !ref brand
defaultStyle: { font: Brand }
content:
  - text: Statement
```

A face the family leaves out falls back to its `normal`. **Roboto** is always available under the name `Roboto` and needs no entry, so a document renders with no font configuration at all.

The family is a resource rather than four inline byte fields because a PDF is rarely the only thing that needs it: a chart in this document measures its labels against a typeface, and a page showing the same report serves one. Declared here, each of those is a separate string that can silently disagree — and when the family a layout was *computed* against is not the family that *renders*, labels clip with no visible cause. One `!ref` in each place removes that.

`!include-bytes` paths are relative to the module root and the bytes ship inside the artifact, so there is no file to locate at runtime.

A `Font.Family` may legitimately declare **no** faces — a typeface a page serves or a chart estimates against. A PDF embeds the type it renders, so this module rejects one, and says what the bytes were needed for.

## Table layout

pdfmake takes callbacks for table layout. A manifest holds no functions, and pdfmake invokes them synchronously during layout, so an expression could not fill them either. `layout` is declared as data instead:

| Field | Description |
|-------|-------------|
| `hLineWidth` / `vLineWidth` | Rule widths. |
| `hLineColor` / `vLineColor` | Rule colours. |
| `paddingLeft` / `paddingRight` / `paddingTop` / `paddingBottom` | Cell padding. |
| `fillColor` | Fills every body row. |
| `headerFillColor` | Fills the rows counted by `headerRows`. |
| `oddRowFillColor` | Bands the body rows, header rows excluded. |

A key left out keeps pdfmake's own default.

**A row that must look different is a row carrying a different `style`** — the totals row in the example above. That is what replaces a per-row callback, and it means the difference travels in the data, which an expression can produce.

## Composite documents

A reusable section — an invoice block, a statement header — is an ordinary invocable that declares the `Node` shape as its `outputType` and returns node data. A step invokes it and its result lands in `content` through an expression, so the composite receives that call's arguments and its result is checked against the same grammar. Charts compose the same way: a chart kind returns SVG markup and an `svg` node reads it.

## Errors

`ERR_RENDER_FAILED` — pdfmake could not lay the document out. The message is pdfmake's own.

`ERR_INVALID_FONT` — a referenced `Font.Family` declares no face bytes, so there is nothing to embed. Give it at least a `normal` face with `!include-bytes`.

A `fonts` entry that names no resource, or one that is not a `Font.Family`, fails when the document resource is created rather than when it renders: whether the reference resolves is a property of the manifest, and an app carrying a broken one should not boot.
