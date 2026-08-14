# Plan — `modules/chart`: charts as scenes, formats as writers

## Problem

There is no charting anywhere in the repo, and no SVG generation at all. The one drawing primitive is `@napi-rs/canvas` behind `Image.Blank` and `Image.Overlay`, which fill a rectangle and stroke labelled boxes — nothing that produces a donut with a legend and leader labels, let alone axes and scales.

Charts are wanted first by a PDF report, but a chart is not a PDF concern: the same donut belongs in an HTML dashboard, an email, an MCP tool result and a terminal. Building it inside the PDF module would bury a transport-neutral primitive in its first consumer, which is exactly the case the breadth rule in CLAUDE.md rules out.

## Solution

A new `modules/chart` (`metadata.name: Chart`, category `Visualization`), pure JavaScript so it delivers bundled as `pkg:telo`.

The module splits *what the chart is* from *what it is rendered into*, so output formats are pluggable:

- **`Chart.Scene`** — a `Telo.Type` schema-only carrier, following `HttpDispatch.Request` / `HttpDispatch.Outcomes`. It declares an engine-neutral drawing: a coordinate space plus a list of marks — paths, texts, rectangles, groups — each with resolved geometry and style. This is a public contract, because it is what lets a writer be implemented outside this module.
- **`Chart.Chart`** — `Telo.Abstract`, capability `Telo.Invocable`: data in, a `Chart.Scene` out. It owns nothing about output format.
- **`Chart.Pie`, `Chart.Donut`, `Chart.Bar`, `Chart.Line`, `Chart.Area`, `Chart.Scatter`** — extend it. Each carries its own encoding configuration: which field is category and which is value, scales and domains, legend placement, label formatting, the colour sequence.
- **`Chart.Writer`** — `Telo.Abstract`, `Telo.Invocable`. Holds `chart:` as an `x-telo-ref` with `kind: Chart.Chart` and `use: call`, takes the data, invokes the chart, and serializes the scene it gets back.
- **`Chart.SvgWriter`** — the implementation, extending `Chart.Writer`. Outputs SVG markup plus width, height and media type.

An application invokes the *writer*; the chart is a reference it holds.

Geometry comes from `d3-shape`, `d3-scale` and `d3-array` — pure computation returning path data and tick positions, no DOM, no data files, no native code. The markup is emitted by this module, deliberately kept inside the SVG subset pdfmake renders, so a chart drops into a PDF as vector without a rasterization step.

Ships with `modules/chart/docs/` per kind (mandatory), a `modules/chart/tests/` suite asserting scene geometry and SVG structure for each chart type, a changie fragment, and a re-run of `scripts/gen-changie-config.mjs` for the new module. The authoring agent's system prompt gains the module, as CLAUDE.md requires of any surface change.

## Decisions

- **A scene sits between chart and writer, rather than charts emitting SVG that writers convert.** A raster or canvas writer would otherwise have to parse markup this module had just generated — an architecture that discards structure and then reconstructs it. The scene is the thing both formats are projections of.
- **The scene is declared publicly, not kept internal.** If a writer can only be written inside this module, the writer split buys nothing; a public geometry contract is the whole point of the indirection.
- **A kind per chart type, not one grammar-of-graphics `Chart.Plot`.** A Vega-Lite-shaped mark/encoding schema is barely type-checkable, renders as a nested form nobody can navigate, and hides the six common cases behind a vocabulary the author has to learn first. Six named kinds are discoverable in the hub and each documents its own contract.
- **SVG only; no PNG writer.** A raster writer needs `@napi-rs/canvas`, whose native binary would force the entire module onto `pkg:npm` and pull the generic primitive into the same delivery corner as `pdf` and `image`. Out of scope; a later `modules/chart-raster` mirrors the `cache` / `cache-redis` split and leaves `chart` bundled.
- **Category `Visualization`, a new label.** The vocabulary is open by design. `Data` is about shape, codecs and reshaping; a chart is presentation, and filing it under `Data` would make the facet less useful, not more.
- **Writers emit font family names, never embedded font data.** A consumer registers matching fonts or text falls back silently — stated plainly in the module docs, because it is the one failure here that produces a wrong-looking output rather than an error.

## Example after the change

```yaml
kind: Chart.Donut
metadata: { name: EmployeeHoursChart }
category: employee
value: hours
innerRadius: 0.62
legend: { placement: right }
labels: { format: "{value} ({percent})" }
---
kind: Chart.SvgWriter
metadata: { name: EmployeeHoursSvg }
chart: !ref EmployeeHoursChart
width: 360
height: 240
```

The application invokes `EmployeeHoursSvg` with the rows and passes `result.svg` wherever markup is wanted.
