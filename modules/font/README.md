# Font

Declare a typeface once and use it everywhere it is needed: the family name that
goes into markup, a document's font table and a stylesheet, plus the face bytes a
renderer embeds or serves. Measure how wide a run of text will be, so a caption,
a legend or a column lands where it was laid out.

## Why use this

- **One declaration, every consumer.** A PDF embeds the face, a chart measures
  against it, a page serves it. Declared separately, the same file sits three
  times in one manifest tree and nothing ties the family a layout was *computed*
  against to the one that *renders*. That mismatch has no visible cause — labels
  simply clip.
- **A family without bytes is still a family.** A websafe or already-served
  typeface is declared here too. Consumers that only need the name work; the one
  that needs the file says so.
- **Measurement is one call.** A caller hands over every string it will draw and
  gets every width back, so a layout costs one dispatch rather than one per
  label.
- **The result says how good it is.** Widths from a real face report
  `exact: true`; estimated ones report `false`, so a layout can leave itself room
  when it is guessing.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Font.Family` | One typeface: its name, and optionally its face bytes. |
| `Font.Measure` | Measure a batch of strings in a family, at a size. |

## Example

```yaml
kind: Telo.Application
metadata: { name: reporting, version: 1.0.0 }
imports:
  Font: oci://ghcr.io/telorun/font@0.1.0
  PdfMake: oci://ghcr.io/telorun/pdfmake@0.3.0
targets: []
---
kind: Font.Family
metadata: { name: brand }
family: Inter
faces:
  normal: !include-bytes ./fonts/Inter-Regular.ttf
  bold: !include-bytes ./fonts/Inter-Bold.ttf
---
kind: PdfMake.Document
metadata: { name: statement }
fonts:
  Brand: !ref brand
defaultStyle: { font: Brand, fontSize: 10 }
content:
  - text: Statement
```

The same `!ref brand` goes into a chart's `font.metrics`, so the widths the chart
laid out against are the widths of the face the PDF embeds.

## No font ships with this module

A font carries a licence, and a licence inherited by every consumer of a
standard-library module is not one anybody chose. Bring your own with
`!include-bytes`, or declare the family without bytes and let the renderer supply
it.
