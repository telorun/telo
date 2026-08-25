---
description: "SvgChart.Pie and SvgChart.Donut: one slice per row, sized by its share"
sidebar_label: Pie & Donut
---

# SvgChart.Pie / SvgChart.Donut

> Examples below assume this module is imported with an `imports:` entry under alias `SvgChart`. Kind references follow that alias — substitute your own if you import it under a different name.

One slice per row, sized by its share of the total. A donut is a pie with a hole, which is why it extends `SvgChart.Pie` and adds one field.

See [Charts](./charts.md) for `rows`, the canvas, the palette, the legend, labels and the font — everything below is what these two add.

---

## Example

```yaml
kind: SvgChart.Donut
metadata: { name: employeeHours }
inputType: !ref EmployeeHoursRows
rows: !cel "inputs.rows"
category: !cel "row.employee"
value: !cel "row.hours"
title: Employee Hours
description: Hours logged per employee this month.
innerRadius: 0.62
width: 480
height: 300
legend: { placement: right, title: Employee }
labels: { format: "{value} ({percent})", valueFormat: ".0f" }
```

```yaml
rows:
  - { employee: Ada,   hours: 128.5 }
  - { employee: Grace, hours: 96 }
  - { employee: Linus, hours: 74.5 }
```

---

## Fields

| Field | Kind | Notes |
| --- | --- | --- |
| `category` | both, required | Names this row's slice — in the legend, and in its label. |
| `value` | both, required | The magnitude the slice is sized by. Finite, and not negative. |
| `innerRadius` | `Donut` only | The hole, as a fraction of the outer radius. Defaults to 0.6. |

## Labels and leader lines

With `labels.format` set, each slice gets a label outside the ring, joined to its slice by a leader line — so a thin slice's label is still attached to something. The slices give up radius to make room for the label ring, rather than the labels overlapping them.

`{percent}` is the slice's share of the total, formatted as a percentage. `{value}` is the raw magnitude through `labels.valueFormat`.

## Rules

**One slice per category.** Two rows sharing a category is an error naming both row indices — it means the rows were not aggregated. Use `Collection.GroupBy` first.

**No negative values.** A slice cannot have a negative share of a total. The error says so and suggests bars instead, which can represent one.

**Zero total draws nothing.** All-zero values leave the frame, the title and the description, with no slices — the same posture as zero rows.
