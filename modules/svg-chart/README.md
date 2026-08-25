# SvgChart

Turn rows of data into a chart, as SVG markup: pie and donut, bar and stacked
bar, line, area and scatter — with axes, scales, gridlines, a legend and
formatted labels.

A chart is one invocable: data in, markup out. The result drops into a PDF as
vector, into an HTML page, into an email or into a tool result; this module never
learns which.

## Why use this

- **A misspelled column is a startup error.** Every mapping is an expression over
  the row, checked against the row shape you declare — so `row.employe` is a
  `CEL_UNKNOWN_FIELD` from `telo check`, not an empty chart discovered in
  production.
- **One kind per chart type.** Inner radius is meaningless on a scatter, scales
  on a pie, stacking outside bars and areas. Six kinds validate their own
  encodings; one kind taking every field would validate none of them.
- **Bad data fails loudly, missing data does not.** Zero rows renders an empty
  chart. A null, a non-finite value or a duplicate key is an error naming the row
  and the accessor — because each would otherwise produce a picture that is wrong
  in a way nobody looking at it can see.
- **Laid out against the type that renders.** Point a chart at the same
  `Font.Family` the PDF embeds or the page serves, and the widths it measured are
  the widths that appear.
- **Readable by default.** The default palette is colour-blind safe, and the
  accessibility markup is always emitted.

## Kinds

| Kind | Purpose |
| --- | --- |
| `SvgChart.Pie` | One slice per row, sized by its share of the total. |
| `SvgChart.Donut` | The same, with the centre open. |
| `SvgChart.Bar` | Bars per position, grouped or stacked by series. |
| `SvgChart.Line` | One line per series, optionally with points. |
| `SvgChart.Area` | Filled bands, optionally stacked. |
| `SvgChart.Scatter` | Points, coloured by series and optionally sized by a value. |

`SvgChart.Chart` and `SvgChart.Cartesian` are the abstracts they extend — the
shared canvas, legend and label surface, and the shared axis surface.

## Example

```yaml
kind: Telo.Application
metadata: { name: reporting, version: 1.0.0 }
imports:
  SvgChart: oci://ghcr.io/telorun/svg-chart@0.1.0
targets: []
---
kind: Telo.JsonSchema
metadata: { name: EmployeeHoursRows }
schema:
  type: object
  required: [rows]
  additionalProperties: false
  properties:
    rows:
      type: array
      items:
        type: object
        required: [employee, hours]
        additionalProperties: false
        properties:
          employee: { type: string }
          hours: { type: number }
---
kind: SvgChart.Donut
metadata: { name: employeeHours }
inputType: !ref EmployeeHoursRows
rows: !cel "inputs.rows"
category: !cel "row.employee"
value: !cel "row.hours"
title: Employee Hours
innerRadius: 0.62
legend: { placement: right, title: Employee }
labels: { format: "{value} ({percent})", valueFormat: ".0f" }
```

```yaml
- name: chart
  invoke: !ref employeeHours
  inputs:
    rows: !cel "steps.hours.result.rows"
```

`steps.chart.result.svg` is the markup.

## Rows are flat

One row per drawn mark, never pre-grouped — a stacked bar takes one row per
`(week, priority)` pair. Aggregate upstream with `Collection.GroupBy`; two rows
sharing the key a chart draws one mark per is an error rather than a silent sum.

## Server-side only

Everything is computed here — geometry, text metrics, tick thinning — and emitted
as final markup. There is no `<script>`, no hover and no animation: a PDF cannot
run them, and a page that wants interaction wraps the SVG itself.

An *interactive* chart for a browser is a different vocabulary, not this module
with another output format. Its accessors would have to be evaluated in the
client, and no CEL engine ships there.

## Rasterizing

Not here. A raster writer needs a native canvas binding, which would pin this
module to a different delivery mode; SVG is the standard vector interchange
format and rasterizing it is a library call.

## Documentation

- [Charts](./docs/charts.md) — rows, accessors, canvas, palette, legend, labels, font
- [Pie & Donut](./docs/pie-and-donut.md)
- [Bar, Line, Area & Scatter](./docs/cartesian.md)
