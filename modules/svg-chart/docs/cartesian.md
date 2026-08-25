---
description: "SvgChart.Bar, Line, Area and Scatter: the charts with axes"
sidebar_label: Bar, Line, Area & Scatter
---

# SvgChart.Bar / Line / Area / Scatter

> Examples below assume this module is imported with an `imports:` entry under alias `SvgChart`. Kind references follow that alias — substitute your own if you import it under a different name.

The four charts with axes. They share `SvgChart.Cartesian`, so the axis configuration below is identical for all of them, and each adds only its own encoding.

See [Charts](./charts.md) for `rows`, the canvas, the palette, the legend, the label templates and the font.

---

## The axes

```yaml
x: { value: !cel "row.week", scale: band, title: Week }
y: { value: !cel "row.tickets", title: Tickets, domain: { min: 0 } }
```

| Field | Notes |
| --- | --- |
| `value` | Required. The expression this row's position is read from. |
| `scale` | `linear` (default), `log`, `time`, `band` or `point`. On a bar chart the default follows `orientation` — `x` is banded when vertical, `y` when horizontal. |
| `domain` | `{ min, max }`. Either end may be left out and comes from the data. |
| `title` | Drawn beside the axis. |
| `tickFormat` | A [d3-format](https://d3js.org/d3-format) specifier (`.0f`, `,`, `.2s`) or, on a time scale, [d3-time-format](https://d3js.org/d3-time-format) (`%b %d`, `%H:%M`). |
| `ticks` | Roughly how many ticks to draw. A target, not a promise — ticks that would collide are thinned. |

A `band` scale gives each distinct value a slot of equal width, which is what bars sit in. `point` is the same without width. A `time` scale accepts an ISO string or epoch milliseconds, so what a database driver or a JSON payload returns works unchanged.

```yaml
gridlines: { x: false, y: true }
```

## Series

```yaml
series: !cel "row.priority"
```

Splits the rows into separate lines, bands or grouped bars — one colour and one legend entry per distinct value. Omit it and every row is one series with no legend.

## `SvgChart.Bar`

```yaml
kind: SvgChart.Bar
metadata: { name: ticketsPerWeek }
rows: !cel "inputs.rows"
title: Tickets per Week
x: { value: !cel "row.week", scale: band, title: Week }
y: { value: !cel "row.tickets", title: Tickets }
series: !cel "row.priority"
stacked: true
legend: { placement: bottom, title: Priority }
```

| Field | Notes |
| --- | --- |
| `stacked` | Stack the series at each position instead of placing them side by side. Defaults to `false`. |
| `orientation` | `vertical` (default) or `horizontal`. Horizontal is what makes long category names readable, since they run along the bar rather than under it. |
| `labels` | In-place labels on each bar — `{category}`, `{series}`, `{value}`. |

Stacked and grouped answer different questions — a total split into parts, versus parts compared with each other — so which one is drawn is declared rather than inferred.

`orientation` is the whole switch. It decides which axis carries the categories — setting the default scale on both — and which way the bars grow, so an author does not also restate `scale: band` on the other axis and the two cannot come to disagree:

```yaml
kind: SvgChart.Bar
metadata: { name: ticketsByWeek }
rows: !cel "inputs.rows"
x: { value: !cel "row.tickets", title: Tickets }
y: { value: !cel "row.week", title: Week }
orientation: horizontal
```

The value domain always reaches zero, and on a stacked chart it covers the longest **stack** rather than the longest single bar. A bar is read as a length from a baseline; truncated at the smallest value it exaggerates every difference on it.

## `SvgChart.Line`

```yaml
kind: SvgChart.Line
metadata: { name: latencyOverTime }
rows: !cel "inputs.rows"
x: { value: !cel "row.timestamp", scale: time, tickFormat: "%H:%M" }
y: { value: !cel "row.p95", title: "p95 (ms)", domain: { min: 0 } }
series: !cel "row.endpoint"
curve: monotone
points: true
gridlines: { y: true }
```

| Field | Notes |
| --- | --- |
| `curve` | `linear` (default), `monotone`, `step`, `natural` or `basis`. |
| `points` | Mark each row with a dot. Defaults to `false`. |
| `strokeWidth` | Defaults to 2. |
| `labels` | In-place labels above each point — `{category}`, `{series}`, `{value}`. |

`monotone` is the smoothing worth knowing: it curves without inventing peaks between the points, which an unconstrained spline does and which makes a smoothed chart claim things the data does not.

Each series is ordered along the horizontal axis before it is drawn, so rows may arrive in whatever order a query returned them.

## `SvgChart.Area`

```yaml
kind: SvgChart.Area
metadata: { name: storageGrowth }
rows: !cel "inputs.rows"
x: { value: !cel "row.day", scale: time, tickFormat: "%b %d" }
y: { value: !cel "row.bytes", title: Stored, tickFormat: ".2s" }
series: !cel "row.bucket"
stacked: true
curve: step
```

| Field | Notes |
| --- | --- |
| `curve` | As for `Line`. |
| `stacked` | Stack the bands so they sum to a total rather than overlapping. |
| `fillOpacity` | Defaults to 0.75. Lower it when unstacked bands overlap and the ones behind must stay visible. |

`Area` declares no `labels`: a filled band has no per-mark anchor a label reads against, and one at every vertex is noise.

## `SvgChart.Scatter`

```yaml
kind: SvgChart.Scatter
metadata: { name: costVsLatency }
rows: !cel "inputs.rows"
x: { value: !cel "row.latencyMs", title: "Latency (ms)" }
y: { value: !cel "row.costUsd", title: "Cost (USD)" }
series: !cel "row.provider"
size: { value: !cel "row.requests", range: [3, 14] }
gridlines: { x: true, y: true }
```

| Field | Notes |
| --- | --- |
| `size.value` | A third value encoded as the point's size. |
| `size.range` | Smallest and largest radius in pixels. Defaults to `[3, 12]`. |
| `radius` | Radius of every point when no `size` is declared. Defaults to 4. |
| `labels` | In-place labels beside each point — `{category}`, `{series}`, `{value}`. |

Size maps through a square root, so what a reader compares is **area**: the middle of a value range sits above the middle of the radius range, which is the difference between a size encoding that reads correctly and one that exaggerates.

## One mark per key

`Bar`, `Line` and `Area` draw one mark per `(position, series)` pair, and two rows sharing a pair is an error naming both row indices. Two rows may share a position as long as they are different series — that is the normal case, and what makes a stack or a group.

`Scatter` is exempt: repeated coordinates are what it draws.
