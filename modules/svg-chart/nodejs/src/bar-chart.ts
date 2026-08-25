import type { ResourceContext } from "@telorun/sdk";
import { CartesianChart, type PlotFrame } from "./cartesian-base.js";
import type { DrawContext } from "./chart-base.js";
import type { BarResource } from "./chart-resource.js";
import type { CartesianPlan } from "./cartesian-plan.js";
import { drawMarkLabel, markLabels } from "./mark-labels.js";
import { element, group } from "./svg.js";

/**
 * Bars, grouped side by side or stacked, at each position along a band axis.
 *
 * Grouped and stacked answer different questions — parts compared with each
 * other, versus a total split into parts — so which one is drawn is declared
 * rather than inferred from the data.
 *
 * `orientation` is what decides which axis carries the categories: it sets the
 * default scale on both axes and the direction the bars grow. Declaring it is
 * therefore the whole switch — an author does not also restate `scale: band` on
 * the other axis, and the two cannot come to disagree.
 */
class BarChart extends CartesianChart<BarResource> {
  constructor(ctx: ResourceContext, resource: BarResource) {
    super(ctx, resource, "Bar", {
      bandAxis: (resource.orientation ?? "vertical") === "horizontal" ? "y" : "x",
      uniquePairs: true,
      baselineZero: true,
      stacked: resource.stacked ?? false,
    });
  }

  protected markStrings(plan: CartesianPlan): string[] {
    return markLabels(this.resource, plan, (mark) =>
      plan.valueAxis === "y" ? mark.y : mark.x,
    ).map((label) => label.text);
  }

  protected drawMarks(context: DrawContext<CartesianPlan>, frame: PlotFrame): string {
    const { plan, color } = context;
    const horizontal = plan.valueAxis === "x";
    const band = horizontal ? frame.y.band : frame.x.band;
    const scale = horizontal ? frame.x.scale : frame.y.scale;
    if (!band || !scale) return "";

    const domain = horizontal ? plan.x.domain : plan.y.domain;
    const baseline = scale(clampBaseline(domain));
    const stacked = this.resource.stacked ?? false;
    const seriesCount = Math.max(1, plan.seriesNames.length);
    const slot = stacked ? band.width : band.width / seriesCount;

    // Running total per position, so a stacked bar sits on the one below it.
    const stackedEnd = new Map<string, number>();
    const labels = new Map(
      markLabels(this.resource, plan, (mark) => (horizontal ? mark.x : mark.y)).map((label) => [
        label.index,
        label,
      ]),
    );
    const placed: string[] = [];

    let body = "";
    for (const mark of plan.marks) {
      const seriesIndex = plan.seriesNames.indexOf(mark.series);
      const key = horizontal ? mark.yKey : mark.xKey;
      const along = band.start(key) + (stacked ? 0 : slot * seriesIndex);
      const base = stacked ? (stackedEnd.get(key) ?? 0) : 0;
      const value = horizontal ? mark.x : mark.y;
      const far = scale(base + value);
      const near = stacked ? scale(base) : baseline;
      if (stacked) stackedEnd.set(key, base + value);

      body += element("rect", {
        x: horizontal ? Math.min(near, far) : along,
        y: horizontal ? along : Math.min(near, far),
        width: horizontal ? Math.abs(far - near) : Math.max(0, slot),
        height: horizontal ? Math.max(0, slot) : Math.abs(far - near),
        fill: color(seriesIndex),
      });

      const label = labels.get(mark.index);
      if (label) {
        placed.push(
          drawMarkLabel(
            label,
            horizontal
              ? { x: far + 4, y: along + slot / 2 + context.metrics.ascender / 2, anchor: "start" }
              : { x: along + slot / 2, y: far - 4, anchor: "middle" },
          ),
        );
      }
    }
    return (
      group({ "data-part": "bars" }, body) +
      (placed.length ? group({ "data-part": "labels" }, placed.join("")) : "")
    );
  }
}


/** Bars are read as a length from a baseline, so the baseline is zero whenever
 *  zero is in range — a bar chart truncated at the smallest value exaggerates
 *  every difference on it. */
function clampBaseline(domain: [number, number]): number {
  if (domain[0] <= 0 && domain[1] >= 0) return 0;
  return domain[0];
}

export function register(): void {}

export async function create(resource: BarResource, ctx: ResourceContext): Promise<BarChart> {
  return new BarChart(ctx, resource);
}
