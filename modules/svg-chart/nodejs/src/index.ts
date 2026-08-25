/**
 * Rows of data into a chart, as SVG markup.
 *
 * Each chart type is its own kind because their encodings are disjoint — an
 * inner radius is meaningless on a scatter, a scale on a pie, stacking outside
 * bars and areas — and one kind taking every field would validate none of those
 * combinations. What they SHARE is factored the other way, into two abstracts:
 * the canvas, palette, legend and labels on `SvgChart.Chart`, and the axes on
 * `SvgChart.Cartesian`.
 *
 * Nothing here is interactive: no script, no hover, no animation. A PDF cannot
 * run them, and a page that wants interaction wraps the markup itself.
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as PieController from "./pie-controller.js";
export * as DonutController from "./donut-controller.js";
export * as BarController from "./bar-chart.js";
export * as LineController from "./line-chart.js";
export * as AreaController from "./area-chart.js";
export * as ScatterController from "./scatter-chart.js";
