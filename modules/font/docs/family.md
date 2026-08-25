---
description: "Font.Family: one typeface, declared once for everything that uses it"
sidebar_label: Font.Family
---

# Font.Family

> Examples below assume this module is imported with an `imports:` entry under alias `Font`. Kind references follow that alias — substitute your own if you import it under a different name.

One typeface: the family name renderers select it by, and optionally the file bytes for its faces.

A brand face is embedded by a PDF, measured by a chart and served to a browser by a page. Declared per consumer, the same file sits several times in one manifest tree — and, worse, nothing ties the family a chart *measured* to the family a document *embeds*. Both are hand-written strings; when they disagree the layout is computed against metrics the renderer never had, and labels clip or collide for no visible reason. One resource removes the second string.

---

## Example

```yaml
kind: Font.Family
metadata: { name: brand }
family: Inter
faces:
  normal: !include-bytes ./fonts/Inter-Regular.ttf
  bold: !include-bytes ./fonts/Inter-Bold.ttf
```

Referenced by whatever needs it:

```yaml
fonts:
  Brand: !ref brand              # PdfMake.Document embeds it
---
font:
  metrics: { kind: Font.Measure, family: !ref brand }   # a chart measures in it
```

---

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `family` | string, required | The name written into SVG markup, a PDF's font table and CSS. |
| `faces.normal` | bytes | Regular face, embedded with `!include-bytes`. |
| `faces.bold` | bytes | |
| `faces.italic` | bytes | |
| `faces.boldItalic` | bytes | |

A face that is not declared falls back to `normal`.

## A family may declare no bytes

```yaml
kind: Font.Family
metadata: { name: websafe }
family: Helvetica
```

That is a complete, valid declaration. It says *this typeface exists and the renderer already has it* — true for a websafe face, for one a page serves through its own stylesheet, and for anything a downstream renderer resolves itself.

What changes is what consumers can do with it:

- **`Font.Measure`** returns estimated widths and reports `exact: false`.
- **A chart** lays out against those estimates and names the family in its markup.
- **`PdfMake.Document`** refuses it: a PDF embeds the typeface it renders, so it needs the file. The error names the family and says what the bytes were for.

The refusal lives with the consumer that needs the bytes, not here, because only that consumer knows what it needed them for.

## Reading it back

`family` is published, so anything holding a reference can read the name rather than restating it:

```yaml
!cel "resources.brand.family"
```

`faces` is published as the list of face names that were declared — which is what tells you whether text measured in this family will be exact.

## Where the bytes live

`!include-bytes` embeds the file in the module's own artifact, so there is nothing to find on disk at runtime and nothing to deploy alongside. The path is **module-root-relative**, not relative to the file the tag is written in — publishing inlines every partial into one `telo.yaml`, so a per-file-relative path would move.

No font ships with this module. Fonts carry licences, and a licence inherited by every consumer of a standard-library module is not one anybody chose.
