import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { type Canvas, type ChartOutput, type ChartResource, MEDIA_TYPE, readCanvas } from "./chart-resource.js";
import { readRows, type RowScope } from "./encode-rows.js";
import { frameChart, type LegendEntry } from "./layout-canvas.js";
import { measureText, type TextMetrics } from "./measure-text.js";
import { paletteFor } from "./palette.js";
import { document } from "./svg.js";

/**
 * The rendering order every chart type follows.
 *
 * The order is forced by measurement: text has to be measured before anything
 * is placed (the legend's width and the axis gutter both come from it), and
 * measuring takes ONE call, so every string a chart will draw has to be known
 * up front. That is why `plan` comes before `draw` — a plan is everything
 * derivable from the data alone, including the formatted tick labels, and
 * `draw` is everything that needs a rectangle.
 *
 * The one thing this costs is that ticks are chosen from the domain rather than
 * from the final plot width. Thinning covers the difference, and it has to
 * exist regardless.
 */
export abstract class ChartBase<Resource extends ChartResource, Plan>
  implements ResourceInstance<Record<string, unknown>, ChartOutput>
{
  constructor(
    protected readonly ctx: ResourceContext,
    protected readonly resource: Resource,
  ) {}

  /** `SvgChart.<Kind> "name"`, the prefix on every message this chart raises. */
  protected abstract get describe(): string;

  /** Everything derivable from the rows alone: encoded marks, domains,
   *  formatted labels, and the legend. Runs before any measurement. */
  protected abstract plan(rows: unknown[], scope: RowScope, canvas: Canvas): Plan;

  /** Every string the chart will draw, so one call measures all of them. */
  protected abstract strings(plan: Plan): string[];

  protected abstract legendEntries(plan: Plan, color: (index: number) => string): LegendEntry[];

  /** The marks, given the rectangle left after the title and the legend. */
  protected abstract draw(context: DrawContext<Plan>): string;

  async invoke(inputs: Record<string, unknown>, invokeCtx?: InvokeContext): Promise<ChartOutput> {
    const call = inputs ?? {};
    const canvas = readCanvas(this.resource);
    const rows = readRows(this.ctx, this.resource.rows, call, this.describe);
    const plan = this.plan(rows, { inputs: call, rows }, canvas);

    const color = paletteFor(this.resource.palette);
    const entries = this.legendEntries(plan, color);
    const metrics = await measureText(
      [
        ...this.strings(plan),
        ...entries.map((entry) => entry.label),
        ...(this.resource.title ? [this.resource.title] : []),
        ...(this.resource.legend?.title ? [this.resource.legend.title] : []),
      ],
      canvas.fontSize,
      this.dispatchMetrics(),
      invokeCtx,
    );

    const frame = frameChart({
      canvas,
      title: this.resource.title,
      legend: this.resource.legend,
      entries,
      metrics,
    });

    const body =
      frame.furniture +
      this.draw({
        plan,
        canvas,
        metrics,
        plot: frame.plot,
        color,
        locale: this.resource.locale ?? "en-US",
      });

    return {
      svg: document({
        width: canvas.width,
        height: canvas.height,
        title: this.resource.title,
        description: this.resource.description,
        fontFamily: metrics.family,
        fontSize: canvas.fontSize,
        body,
      }),
      width: canvas.width,
      height: canvas.height,
      mediaType: MEDIA_TYPE,
    };
  }

  snapshot(): Record<string, unknown> {
    const canvas = readCanvas(this.resource);
    return { width: canvas.width, height: canvas.height, mediaType: MEDIA_TYPE };
  }

  /** Resolved once: the reference does not change, and re-resolving it per
   *  render would walk the ref machinery on every chart drawn. */
  private dispatcher?: ReturnType<typeof resolveInvocableDispatcher> | null;

  private dispatchMetrics() {
    if (this.dispatcher === undefined) {
      const metrics = this.resource.font?.metrics;
      this.dispatcher = metrics
        ? resolveInvocableDispatcher(metrics, this.ctx, () => `${this.describe}: 'font.metrics'`)
        : null;
    }
    return this.dispatcher ?? undefined;
  }
}

export interface DrawContext<Plan> {
  plan: Plan;
  canvas: Canvas;
  metrics: TextMetrics;
  plot: import("./layout-canvas.js").Rect;
  color: (index: number) => string;
  locale: string;
}
