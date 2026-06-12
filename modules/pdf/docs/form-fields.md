---
description: "Pdf.FormFields: add editable AcroForm fields to a PDF at measured coordinates"
sidebar_label: Pdf.FormFields
---

# Pdf.FormFields

> Examples below assume this module is imported with an `imports:` entry under alias `Pdf`. Kind references follow that alias — substitute your own if you import it under a different name.

Adds editable AcroForm fields to a PDF via pdf-lib and returns the new
document's bytes. Coordinates are **pixels of the image `Pdf.Rasterizer`
renders at the same `scale`, origin top-left** — the controller divides them
back to PDF points and flips the y-axis to PDF user space (origin
bottom-left), so manifests and vision models never translate coordinates.

---

## Example

```yaml
kind: Pdf.FormFields
metadata: { name: AddFields }
```

```yaml
- name: fielded
  inputs:
    data: "${{ steps.fetch.result.bytes }}"
    scale: "${{ steps.page.result.scale }}"   # from the Pdf.Rasterizer step that produced the image
    fields:
      - { name: firstName, type: text,     page: 1, x: 240, y: 64, width: 300, height: 40 }
      - { name: subscribe, type: checkbox, page: 2, x: 240, y: 64, width: 40,  height: 40 }
  invoke: !ref AddFields
```

---

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scale` | `number` | no (default `1`) | The render scale the incoming pixel coordinates were measured at — must match the `Pdf.Rasterizer` that produced the image. |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | `Uint8Array` | yes | Buffered PDF bytes. |
| `fields` | `array` | yes | Field placements; at least one entry. |
| `scale` | `number` | no | The render scale the coordinates were measured at — wire the producing render step's `result.scale` here. Takes precedence over the resource-level `scale`. |

Each `fields[]` entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | AcroForm field name; must be unique within the document. |
| `type` | `"text"` \| `"checkbox"` | yes | Field widget type. |
| `page` | `integer` | yes | 1-based page number the field sits on. |
| `x`, `y` | `number` | yes | Top-left corner of the box, in rendered-image pixels (top-left origin). |
| `width`, `height` | `number` | yes | Box size in rendered-image pixels. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `data` | `Uint8Array` | New PDF bytes with the AcroForm fields added. The input document is not mutated. |

## Errors

| Code | Raised when |
|------|-------------|
| `ERR_INVALID_INPUT` | `data` is not a `Uint8Array` or not parseable as a PDF; a field's `page` is out of range; a field `name` collides (within the input or with an existing document field); or a box falls outside the page bounds. |
