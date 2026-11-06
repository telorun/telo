import { durationMs, type ResourceContext } from "@telorun/sdk";
import { ScheduleRunner, type ScheduleResource } from "./schedule-runner.js";

interface IntervalResource extends ScheduleResource {
  every: unknown;
}

export const interval = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: IntervalResource, ctx: ResourceContext) {
    const everyMs = durationMs(resource.every);
    if (everyMs === undefined) {
      throw new Error(`Schedule.Interval "${resource.metadata.name}": 'every' must be a duration`);
    }
    // Constant gap — the first tick lands one full period after the schedule
    // starts, so a restart never fires immediately.
    return new ScheduleRunner(
      resource,
      ctx,
      `Schedule.Interval "${resource.metadata.name}"`,
      () => everyMs,
    );
  },
};
