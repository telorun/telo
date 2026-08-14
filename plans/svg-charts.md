# Plan — `modules/chart`: one kind per chart type, SVG out

## Problem

There is no charting anywhere in the repo, and no SVG generation at all. The one drawing primitive is `@napi-rs/canvas` behind `Image.Blank` and `Image.Overlay`, which fill a rectangle and stroke labelled boxes — nothing that produces a donut with a legend and leader labels, let alone axes and scales.

Charts are wanted first by a PDF report, but a chart is not a PDF concern: the same donut belongs in an HTML dashboard, an email, an MCP tool result and a terminal. Building it inside the PDF module would bury a transport-neutral primitive in its first consumer, which is exactly the case the breadth rule in CLAUDE.md rules out.

## Solution

A new `modules/chart` (`metadata.name: Chart`, category `Visualization`), pure JavaScript so it delivers bundled as `pkg:telo`. Geometry comes from `d3-shape`, `d3-scale`, `d3-array` and the `d3-format` / `d3-time-format` pair; text is measured with `fontkit`. All pure computation, no DOM, no native code.

A chart is one invocable: data in, SVG markup out. There is no intermediate representation and no separate writer — SVG *is* the vector interchange format, and anything that wants pixels rasterizes it.

The kinds form two levels, so the presentation concerns every chart shares are declared once:

- **`Chart.Chart`** — `Telo.Abstract`, capability `Telo.Invocable`. Declares the shared `outputType` (`svg`, `width`, `height`, `mediaType`) and a `schema:` block carrying what every chart has: an author-writable `inputType` (`x-telo-ref: { kind: Telo.Type, use: schema }`, the `JS.Script` pattern), the `rows` data expression, `title`, `description`, `width`, `height`, `margin`, `palette`, `locale`, `font` (`family`, `size`, optional `data`), `legend` (`placement`, `title`) and `labels` (`format`, `valueFormat`). A title and a legend heading are laid out for every chart type and both consume canvas the plot area does not get, so they belong here rather than being restated per kind.
- **`Chart.Cartesian`** — `Telo.Abstract`, extends `Chart.Chart`. Adds the axis config, identical for every chart that has axes: the `x` / `y` axis objects (value accessor, scale, domain, title, tick formatting) and gridlines.
- **`Chart.Pie`, `Chart.Donut`** — extend `Chart.Chart`. Angular encoding: category and value accessors, inner radius, leader labels.
- **`Chart.Bar`, `Chart.Line`, `Chart.Area`, `Chart.Scatter`** — extend `Chart.Cartesian`. Each carries only what is its own: series grouping, stacking, curve interpolation, point sizing.

An `extends` child without `base:` merges the parent's author schema additively, so a leaf kind's manifest states nothing but its own encoding while validating against the whole inherited surface. Each leaf declares its own controller.

**Every mapping is a typed CEL accessor, not a field name.** The author declares the row shape once by pointing `inputType:` at a type, writes `rows: !cel "inputs.rows"`, and each encoding field is a CEL expression over `row` — typed by `x-telo-context-element-from: "rows"`, the mechanism `Collection.GroupBy` already uses to type `item` from its `collection:` expression. A mistyped accessor is `CEL_UNKNOWN_FIELD` before the kernel runs, and the rows an invoke step passes are checked against the declared type both statically and at dispatch.

The markup stays inside the SVG subset pdfmake renders, so a chart drops into a PDF as vector without a rasterization step. Ships with `modules/chart/docs/` per kind (mandatory), a `modules/chart/tests/` suite asserting SVG structure and computed geometry per chart type plus the degenerate-data cases, a changie fragment, and a re-run of `scripts/gen-changie-config.mjs`. The authoring agent's system prompt gains the module, as CLAUDE.md requires of any surface change.

## Decisions

- **No scene IR and no chart/writer split.** A generic geometry contract between chart and format is only worth its versioning cost if a second format consumes it, and raster is out of scope. The claim that a raster writer would have to re-parse markup this module just generated does not hold — SVG is the standard vector interchange format, and rasterizing it is a library call. Dropping the indirection also keeps the data contract typed end to end: a writer holding the chart as a reference would forward inputs it cannot describe, so its `inputType` would go permissive exactly where authors get things wrong.
- **A kind per chart type, not one kind taking all config.** The six configs are disjoint — inner radius is meaningless on a scatter, scales on a pie, stacking outside bar and area. One kind makes every field optional and validates none of those combinations, and collapses six hub-searchable descriptions into one that cannot be the hit for "donut", "scatter" and "stacked bar" at once.
- **Two abstract levels, not a flat set of six.** Legend, labels, palette and canvas are the same concern six times. `Chart.Cartesian` exists so pie and donut are never offered axis config they cannot use.
- **CEL accessors over `row`, not field-name strings.** `category: employee` is a string nothing can check, so a typo surfaces as an empty chart at runtime. The accessor form is checked against the declared row type by existing machinery, and is strictly more expressive — computed values and composite categories come free, where field names would need a preceding `Collection.Map`. Cost is one CEL evaluation per accessor per row; `GroupBy` already pays this per element and charts are small.
- **Typing is opt-in per instance and bounded by the upstream.** Omit `inputType:` and `row` falls back to `dyn` — the gradual stance `x-telo-context-element-from` takes everywhere. A chart cannot manufacture type information the resource producing the rows never declared, and inventing an element type would be worse than admitting there is none.
- **The SVG always names a font family and never carries font data; `font.data` exists only to measure.** SVG's embedding mechanisms do not serve the consumers: SVG Fonts are removed from every browser, and `@font-face` with a base64 payload — the one thing that makes an SVG self-contained — is ignored by pdfmake, the first consumer. Supplying the font bytes via `!include-bytes` on an `x-telo-binary` slot gives exact advance widths instead of an estimate, which is what makes a right-placed legend or a leader label land correctly. **Rejected: a text-to-paths mode.** It would render identically everywhere, but costs selectable and searchable text in both PDF and HTML. The consequence is accepted deliberately: a renderer lacking the named font falls back against a layout computed from real metrics, so labels clip sooner than under estimates — the fix is registering the font with pdfmake or serving it in the page, and the module docs say so.
- **No font ships in the module artifact** — artifact weight plus a licensing question inherited by every consumer.
- **No data and bad data fail differently.** Zero rows renders the chart frame with an empty plot area and no legend entries; an empty result set is not an error. A null or non-finite value reaching an accessor is a hard failure naming the row index and the accessor, because that is a defect in the data or the expression and swallowing it would produce a silently wrong picture.
- **Overlapping labels are dropped and dense ticks thinned, silently.** Both are layout outcomes of the data, not defects: erroring would make a chart fail on data it should render, and drawing everything produces unreadable output.
- **Okabe–Ito is the default palette**, cycling with a documented wrap and overridable via `palette`. Charts land in PDFs and dashboards nobody re-themes, so the default is what most output actually uses, and a colour-blind-safe categorical scale is the only defensible one to pick.
- **Accessibility markup is always emitted** — `role="img"` plus `<title>` from `title` and `<desc>` from `description`. It costs nothing and is the only thing a screen reader can read, which matters most because the labels are text a fallback font may have mangled.
- **`locale` defaults to `en-US`.** Tick and label formats are d3-format / d3-time-format specifiers, both locale-sensitive; a report in another locale must not be stuck with US grouping and month names.
- **Static SVG: no `<script>`, no hover tooltips, no animation.** A PDF cannot run them, and a dashboard wanting interaction wraps the SVG itself. Stated so it is not re-litigated.
- **SVG only; no raster kind here.** A raster writer needs `@napi-rs/canvas`, whose native binary would force the module onto `pkg:npm` and into the same delivery corner as `pdf` and `image`. A later `modules/chart-raster` takes SVG in and PNG out — one kind, no coupling to this module's internals, mirroring the `cache` / `cache-redis` split.
- **Category `Visualization`, a new label.** The vocabulary is open by design. `Data` is about shape, codecs and reshaping; a chart is presentation.

## Examples after the change

Every chart reads `rows` — a flat array, one row per drawn datum, never pre-grouped — and maps it with CEL accessors over `row`. `series` is the accessor that splits rows into slices, lines or bands, so a stacked bar takes one row per `(week, priority)` rather than nested arrays. A `time` scale accepts an ISO string or epoch milliseconds.

### `Chart.Donut` — the typed shape in full

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
kind: Chart.Donut
metadata: { name: EmployeeHoursChart }
inputType: !ref EmployeeHoursRows
rows: !cel "inputs.rows"
category: !cel "row.employee"
value: !cel "row.hours"
title: Employee Hours
description: Hours logged per employee this month.
innerRadius: 0.62
width: 480
height: 300
palette: ["#1f8fff"]
font: { family: Inter, size: 12, data: !include-bytes ./fonts/Inter-Regular.ttf }
legend: { placement: right, title: Employee }
labels: { format: "{value} ({percent})", valueFormat: ".0f" }
```

```yaml
rows:
  - { employee: Ada, hours: 128.5 }
  - { employee: Grace, hours: 96 }
  - { employee: Linus, hours: 74.5 }
```

`!cel "row.employe"` is `CEL_UNKNOWN_FIELD`; an invoke step passing rows without `hours` fails the declared contract. Every example below assumes the same `inputType` pattern.

### `Chart.Pie`

```yaml
kind: Chart.Pie
metadata: { name: RevenueByRegion }
inputType: !ref RevenueRows
rows: !cel "inputs.rows"
category: !cel "row.region"
value: !cel "row.revenue"
title: Revenue by Region
width: 320
height: 240
legend: { placement: right }
labels: { format: "{percent}" }
```

### `Chart.Bar` — one row per `(week, priority)`; the chart groups them

```yaml
kind: Chart.Bar
metadata: { name: TicketsPerWeek }
inputType: !ref TicketRows
rows: !cel "inputs.rows"
title: Tickets per Week
x: { value: !cel "row.week", scale: band, title: Week }
y: { value: !cel "row.tickets", scale: linear, title: Tickets, domain: { min: 0 } }
series: !cel "row.priority"
stacked: true
width: 640
height: 280
legend: { placement: bottom, title: Priority }
```

```yaml
rows:
  - { week: 2026-W06, priority: high, tickets: 12 }
  - { week: 2026-W06, priority: normal, tickets: 34 }
  - { week: 2026-W07, priority: high, tickets: 7 }
  - { week: 2026-W07, priority: normal, tickets: 41 }
```

### `Chart.Line`

```yaml
kind: Chart.Line
metadata: { name: LatencyOverTime }
inputType: !ref LatencyRows
rows: !cel "inputs.rows"
title: p95 Latency
x: { value: !cel "row.timestamp", scale: time, tickFormat: "%H:%M" }
y: { value: !cel "row.p95", scale: linear, title: "p95 (ms)", domain: { min: 0 } }
series: !cel "row.endpoint"
curve: monotone
points: true
gridlines: { y: true }
width: 720
height: 260
```

### `Chart.Area`

```yaml
kind: Chart.Area
metadata: { name: StorageGrowth }
inputType: !ref StorageRows
rows: !cel "inputs.rows"
title: Stored Bytes
x: { value: !cel "row.day", scale: time, tickFormat: "%b %d" }
y: { value: !cel "row.bytes", scale: linear, title: Stored, tickFormat: ".2s" }
series: !cel "row.bucket"
stacked: true
curve: step
width: 720
height: 240
legend: { placement: bottom, title: Bucket }
```

### `Chart.Scatter`

```yaml
kind: Chart.Scatter
metadata: { name: CostVsLatency }
inputType: !ref ProviderRows
rows: !cel "inputs.rows"
title: Cost vs Latency
x: { value: !cel "row.latencyMs", scale: linear, title: "Latency (ms)" }
y: { value: !cel "row.costUsd", scale: linear, title: "Cost (USD)" }
series: !cel "row.provider"
size: { value: !cel "row.requests", range: [3, 14] }
gridlines: { x: true, y: true }
width: 480
height: 360
```

### Invoking a chart

Rows come from wherever the data lives; `result.svg` goes wherever markup is wanted — a PDF node, an HTML response body, an MCP tool result.

```yaml
- name: chart
  invoke: !ref EmployeeHoursChart
  inputs:
    rows: !cel "steps.hours.result.rows"
```
