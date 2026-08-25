import { scaleSqrt } from "d3-scale";
import type { ResourceContext } from "@telorun/sdk";
import { CartesianChart, type PlotFrame } from "./cartesian-base.js";
import type { DrawContext } from "./chart-base.js";
import type { Canvas, ScatterResource } from "./chart-resource.js";
import type { CartesianPlan } from "./cartesian-plan.js";
import { evaluate, requireNumber, type RowScope } from "./encode-rows.js";
import { drawMarkLabel, markLabels } from "./mark-labels.js";
import { element, group } from "./svg.js";

/** The plan carries the sizes, rather than the instance holding them: a
 *  resource is shared and invoked concurrently, and a render awaits its text
 *  measurement between reading the rows and drawing them — so a field written
 *  in `plan()` and read in `drawMarks()` is a field a second render overwrites
 *  inside the first one's await. Nothing survives that await but the plan,
 *  which is what `ChartBase` is generic over. */
type ScatterPlan = CartesianPlan & { sizes: number[] };

/**
 * A point per row, coloured by series and optionally sized by a third value.
 *
 * The only cartesian chart that admits repeated coordinates: a cloud of points
 * at the same place is what it is for, so the duplicate-key rule the others
 * enforce would refuse its normal input.
 */
class ScatterChart extends CartesianChart<ScatterResource, ScatterPlan> {
  constructor(ctx: ResourceContext, resource: ScatterResource) {
    super(ctx, resource, "Scatter", { uniquePairs: false });
  }

  protected plan(rows: unknown[], scope: RowScope, canvas: Canvas): ScatterPlan {
    const plan = super.plan(rows, scope, canvas);
    const declared = this.resource.size;
    const sizes = declared
      ? rows.map((row, index) =>
          requireNumber(
            evaluate(this.ctx, declared.value, row, index, scope),
            index,
            "size.value",
            this.describe,
          ),
        )
      : [];
    return { ...plan, sizes };
  }

  protected markStrings(plan: ScatterPlan): string[] {
    return markLabels(this.resource, plan, (mark) => mark.y).map((label) => label.text);
  }

  protected drawMarks(context: DrawContext<ScatterPlan>, frame: PlotFrame): string {
    const { plan, color } = context;
    const yScale = frame.y.scale;
    if (!yScale) return "";
    const radius = this.radiusScale(plan.sizes);
    const labels = new Map(
      markLabels(this.resource, plan, (mark) => mark.y).map((label) => [label.index, label]),
    );

    let body = "";
    let placed = "";
    for (const mark of plan.marks) {
      const x = frame.x.band
        ? frame.x.band.start(mark.xKey) + frame.x.band.width / 2
        : (frame.x.scale?.(mark.x) ?? 0);
      const label = labels.get(mark.index);
      if (label) {
        placed += drawMarkLabel(label, {
          x: x + radius(mark.index) + 3,
          y: yScale(mark.y) + context.metrics.ascender / 2,
          anchor: "start",
        });
      }
      body += element("circle", {
        cx: x,
        cy: yScale(mark.y),
        r: radius(mark.index),
        fill: color(plan.seriesNames.indexOf(mark.series)),
        // Overlapping points are the normal case here, so they are drawn
        // translucent: a dense region reads as darker rather than as one blob.
        "fill-opacity": 0.75,
      });
    }
    return (
      group({ "data-part": "points" }, body) +
      (placed ? group({ "data-part": "labels" }, placed) : "")
    );
  }

  /** Area, not radius, is what a reader compares — so the value maps through a
   *  square root, which is what `scaleSqrt` is. */
  private radiusScale(sizes: number[]): (rowIndex: number) => number {
    const fixed = this.resource.radius ?? 4;
    if (sizes.length === 0) return () => fixed;
    const range = this.resource.size?.range ?? [3, 12];
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    if (min === max) return () => (range[0] + range[1]) / 2;
    const scale = scaleSqrt().domain([min, max]).range(range);
    return (rowIndex) => scale(sizes[rowIndex] ?? min);
  }
}

export function register(): void {}

export async function create(resource: ScatterResource, ctx: ResourceContext): Promise<ScatterChart> {
  return new ScatterChart(ctx, resource);
}
