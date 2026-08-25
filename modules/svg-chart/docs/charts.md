---
description: "The shared chart surface: rows, accessors, canvas, palette, legend and font"
sidebar_label: Charts
---

# Charts

> Examples below assume this module is imported with an `imports:` entry under alias `SvgChart`. Kind references follow that alias — substitute your own if you import it under a different name.

Every chart in this module is one invocable: rows in, SVG markup out. What they share is declared once on two abstracts, so a chart type's own manifest states nothing but its encoding.

- **`SvgChart.Chart`** — the canvas, title, description, palette, locale, font and legend.
- **`SvgChart.Cartesian`** — extends it with the two axes, the series accessor and the gridlines. Extended by `Bar`, `Line`, `Area` and `Scatter`; `Pie` and `Donut` extend `Chart` directly, so they are never offered scales they cannot use.

---

## Rows are flat, one row per mark

```yaml
rows: !cel "inputs.rows"
```

Never pre-grouped. A stacked bar takes one row per `(position, series)` pair:

```yaml
rows:
  - { week: 2026-W06, priority: high,   tickets: 12 }
  - { week: 2026-W06, priority: normal, tickets: 34 }
  - { week: 2026-W07, priority: high,   tickets: 7 }
  - { week: 2026-W07, priority: normal, tickets: 41 }
```

Aggregate upstream with `Collection.GroupBy`. Two rows sharing the key a chart draws one mark per is an error, not a silent sum — see [Bad data](#no-data-and-bad-data-fail-differently).

## Every mapping is an expression, not a field name

Each encoding field is CEL over `row`:

```yaml
category: !cel "row.employee"
value: !cel "row.hours"
```

Declare `inputType:` and the row shape is known, so `!cel "row.employe"` is a `CEL_UNKNOWN_FIELD` before the kernel runs rather than an empty chart at render time:

```yaml
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
```

Omit `inputType:` and the row stays untyped — accessors still work, nothing checks them.

Because they are expressions, a computed or composite key needs no upstream step:

```yaml
series: !cel "row.region + ' / ' + row.tier"
```

In scope inside an accessor: `row`, `index`, `rows`, and the call's `inputs`.

## The canvas

| Field | Default | Notes |
| --- | --- | --- |
| `width` / `height` | 640 × 360 | The SVG's own dimensions. |
| `margin` | 12 on each side | Space kept clear around everything drawn. |
| `title` | — | Drawn above the plot, and emitted as the SVG's `<title>`. |
| `description` | — | Not drawn. Emitted as `<desc>`. |

`role="img"` plus `<title>` and `<desc>` are always emitted. They cost nothing, and they are the only thing a screen reader can read — which matters most here, because everything else on the chart is text a fallback font may have mangled.

## Colour

`palette` is a list of colours, cycled when there are more series than entries. The default is the [Okabe–Ito](https://jfly.uni-koeln.de/color/) colour-blind-safe scale: a chart from this module usually lands somewhere nobody re-themes — a PDF report, an email, a generated page — so the default is what most output actually renders with.

## Text and the font

```yaml
font:
  size: 12
  metrics: { kind: Font.Measure, family: !ref brand }
```

`metrics` does two things: it supplies the exact advance widths the layout is computed from, and it names the family the markup selects by. There is no free-text family field, so the typeface a chart *measured against* and the one it *names* cannot disagree.

Omit `font` entirely and the chart draws in `sans-serif` against estimated widths. That renders everywhere and is usually fine; what it costs is precision at the edges — a right-placed legend or a leader label lands against a guess.

The SVG never carries font data. SVG Fonts are gone from every browser, and an `@font-face` payload — the one thing that would make the markup self-contained — is ignored by pdfmake. So a renderer that lacks the named font falls back, and text laid out against real metrics clips sooner than text laid out against estimates. The fix is to point the PDF or the page at the same `Font.Family`, which is the whole reason it is a resource.

There is deliberately no text-to-paths mode. It would render identically everywhere and cost selectable, searchable text in both PDF and HTML.

## Legend

```yaml
legend: { placement: right, title: Priority }
```

`placement` is `right` (default), `bottom` or `none`. A right legend is capped at 40% of the plot, so a long series name costs the legend its width rather than the chart its plot area; a bottom legend wraps onto more rows.

A chart with no `series` accessor has one unnamed series and draws no legend.

## Labels

`labels` is **not** part of the shared surface — it is declared by the four kinds that have a point to anchor a label to (`Pie`, `Donut`, `Bar`, `Line`, `Scatter`), and each names the tokens it substitutes:

| Kind | Tokens |
| --- | --- |
| `Pie` / `Donut` | `{category}`, `{value}`, `{percent}` |
| `Bar`, `Line`, `Scatter` | `{category}`, `{series}`, `{value}` |

```yaml
labels: { format: "{value} ({percent})", valueFormat: ".0f" }
```

`format` is a template; anything that is not a supported token is literal, so an unsupported one shows up on the chart rather than vanishing. Omit it and no in-place labels are drawn. `valueFormat` is a [d3-format](https://d3js.org/d3-format) specifier applied to `{value}`.

`{percent}` is offered only on the angular charts: a share of a total is what a slice reads as, and an axis chart has no single total one would be of. **`Area` declares no `labels` at all** — a filled band has no per-mark anchor a label reads against, and one at every vertex is noise.

Dense axis ticks are thinned silently. That is not a defect: how many ticks collide is an outcome of the data, and erroring would make a chart fail on data it should render while drawing everything produces a smear.

## Locale

`locale` defaults to `en-US` and decides number grouping and month and day names in every formatted tick and label. Any tag the platform's `Intl` knows works — no locale table ships with the module.

## No data and bad data fail differently

**Zero rows renders an empty chart.** An empty result set is not an error: the canvas, the frame and the accessibility markup are still there, with nothing drawn in the plot.

**A null or non-finite value is a hard failure**, naming the row index and the accessor:

```
SvgChart.Pie "share": 'value' produced null for row 1; a chart needs a finite
number there. Filter or default the value upstream.
```

Swallowing it would produce a picture that is wrong in a way nobody looking at it can see.

**A duplicate key is a hard failure**, on the encodings that draw one mark per key — `category` on pie and donut, `(position, series)` on bar, line and area:

```
SvgChart.Bar "tickets": rows 0 and 2 both have x/series pair '2026-W06 high',
and this chart draws one mark per x/series. Aggregate the rows first —
Collection.GroupBy sums or averages them into one row per key.
```

It means the rows were not aggregated the way the author believed. Summing silently draws the wrong picture; keeping the last row throws data away. Scatter is exempt — a cloud of points at the same place is what it is for.

## Output

```yaml
- name: chart
  invoke: !ref employeeHours
  inputs:
    rows: !cel "steps.hours.result.rows"
```

`result.svg` is standalone markup, plus `width`, `height` and `mediaType` (`image/svg+xml`). It goes into a PDF's `svg` node, an HTTP response body, an HTML page or a tool result — this module never learns which.

The markup stays inside the SVG subset pdfmake renders, so a chart drops into a PDF as vector with no rasterization step.

Nothing is interactive: no `<script>`, no hover tooltips, no animation. A PDF cannot run them, and a page that wants interaction wraps the markup itself.
