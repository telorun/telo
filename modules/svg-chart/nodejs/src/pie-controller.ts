import type { ResourceContext } from "@telorun/sdk";
import type { PieResource } from "./chart-resource.js";
import { PieChart } from "./pie-chart.js";

export function register(): void {}

/** A pie is a donut with no hole, which is why the two share one renderer. */
export async function create(resource: PieResource, ctx: ResourceContext): Promise<PieChart> {
  return new PieChart(ctx, resource, "Pie", 0);
}
