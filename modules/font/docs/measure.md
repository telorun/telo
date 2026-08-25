---
description: "Font.Measure: how wide a batch of strings renders, in one call"
sidebar_label: Font.Measure
---

# Font.Measure

> Examples below assume this module is imported with an `imports:` entry under alias `Font`. Kind references follow that alias — substitute your own if you import it under a different name.

Measures how wide a list of strings renders in a typeface at a given size — the advance width of each, plus the ascender, descender and line gap that decide line height.

---

## Example

```yaml
kind: Font.Measure
metadata: { name: brandMetrics }
family: !ref brand
size: 12
```

```yaml
- name: measure
  invoke: !ref brandMetrics
  inputs:
    strings: ["Revenue", "Cost of goods sold", "Total"]
```

```json
{
  "family": "Inter",
  "widths": [46.7, 112.1, 27.4],
  "ascender": 11.6,
  "descender": 2.9,
  "lineGap": 0,
  "exact": true
}
```

---

## Why a batch

Laying out one chart measures every tick label, every legend entry, both axis titles and every data label. A call per string would put a dispatch on the layout path for each of a hundred ticks.

A caller knows every string it will draw before it places any of them, so **one layout is one call**. That is the shape this kind is designed around, and the reason it takes a list rather than a string.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `family` | reference, required | The `Font.Family` to measure in. |
| `size` | number | Default point size. Defaults to 12. |
| `style` | `normal` \| `bold` \| `italic` \| `boldItalic` | Default face. Defaults to `normal`. |

## Inputs

| Input | Type | Notes |
| --- | --- | --- |
| `strings` | array of string, required | Measured in order; the widths come back in the same order. |
| `size` | number | Overrides the resource's `size` for this call. |
| `style` | string | Overrides the resource's `style` for this call. |

## Outputs

| Output | Notes |
| --- | --- |
| `family` | The name to write into markup. Comes from the referenced family, so a caller never restates it. |
| `widths` | Advance width of each input string at the requested size. |
| `ascender` / `descender` / `lineGap` | Vertical metrics at the requested size. `descender` is a depth, so it is positive. |
| `exact` | Whether the widths came from the face's own tables. |

## Exact and estimated

When the family declares face bytes, widths come from the face's own metrics and `exact` is `true`.

When it declares none — a websafe family, or one a page serves itself — widths are estimated from average character widths bucketed by class, and `exact` is `false`. The estimate lands within about a percent for ordinary prose in a humanist sans; it is worse for a run of one class it did not anticipate.

`exact` is reported rather than inferred because a caller may want to spend the slack differently: a layout that knows it is estimating can leave more room than one that knows the widths are right.

## Errors

| Code | When |
| --- | --- |
| `ERR_FONT_UNREADABLE` | The face bytes are not a font file this runtime can parse, or they are a font *collection* (`.ttc` / `.otc`), which carries several faces and no single set of metrics. |
