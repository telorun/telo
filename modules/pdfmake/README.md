# PdfMake

Author PDF documents declaratively: pages, styled text, tables, columns, stacks,
lists, images, SVG artwork and vector canvas, with named styles, page
backgrounds, headers and footers, and embedded brand fonts.

A typed binding to [pdfmake](https://pdfmake.github.io). Field names mirror
pdfmake's document definition verbatim, so an example from its documentation or
its playground pastes in and works — with the schema checking it before anything
runs.

## Why use this

- **One resource is a report template.** The content expressions are evaluated
  per invocation, so the same declaration renders a different customer's rows
  every time it is invoked.
- **The whole document is checked.** Every node is validated against the shared
  `Node` shape before the app starts — a misspelled key, a table with no `body`,
  a colour where a number belongs. A failed node names the alternatives it could
  have been.
- **Brand assets ship with the module.** Fonts embed with `!include-bytes` and
  artwork with `!include-text`, so there is no file to find at runtime.
  Roboto is always available and needs no configuration.
- **Charts and other artwork compose by value.** Anything that produces SVG
  markup — a chart kind, a stored asset — goes into an `svg` node through an
  expression; this module never learns what produced it.

## Kinds

| Kind | Purpose |
| --- | --- |
| `PdfMake.Document` | Render a declared document to PDF bytes. |

`PdfMake.Node` is the exported node **shape** the document body is written in —
a JSON Schema, not a kind. A composite document (an invoice, a statement) is an
ordinary invocable declaring it as its `outputType`: its result is checked
against the same grammar and lands in `content` through an expression.

## Example

```yaml
kind: Telo.Application
metadata: { name: invoicer, version: 1.0.0 }
imports:
  PdfMake: oci://ghcr.io/telorun/pdfmake@0.1.0
targets: []
---
kind: PdfMake.Document
metadata: { name: customerReport }
pageSize: A4
fonts:
  Brand:
    normal: !include-bytes assets/Brand-Regular.ttf
    bold: !include-bytes assets/Brand-Bold.ttf
defaultStyle: { font: Brand, fontSize: 10 }
styles:
  heading: { fontSize: 18, bold: true, color: "#1B36C4" }
  totalsRow: { bold: true, color: "#1B36C4" }
background:
  - svg: !include-text assets/page-background.svg
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
  - svg: !cel "inputs.chartSvg"
```

A row carrying `style: totalsRow` renders as the totals row — the styling
travels in the data, which is what replaces pdfmake's row callbacks.

## Where this is not a mirror

pdfmake takes **functions** for table layout, page backgrounds, headers, footers
and page-break decisions. A manifest holds no functions, and pdfmake invokes
these synchronously during layout, so an expression could not fill them either.
Table `layout` is therefore declared as data — line widths and colours, padding,
a header fill, an alternating band — and anything that would have varied per row
is a row carrying a different `style`. This is the one place the vocabulary
diverges; everything else is pdfmake's own.

## Reading the result back

`PdfMake.Document` returns bytes and nothing else. To assert what a document
says — or to learn its page count — read it with `Pdf.Text`.
