import type { ResourceContext } from "@telorun/sdk";
import type { PieResource } from "./chart-resource.js";
import { PieChart } from "./pie-chart.js";

export function register(): void {}

export async function create(resource: PieResource, ctx: ResourceContext): Promise<PieChart> {
  return new PieChart(ctx, resource, "Donut", 0.6);
}
