import { parseDurationMs, type ResourceContext } from "@telorun/sdk";
import { ScheduleRunner, type ScheduleResource } from "./schedule-runner.js";

interface IntervalResource extends ScheduleResource {
  every: string;
}

export const interval = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: IntervalResource, ctx: ResourceContext) {
    const everyMs = parseDurationMs(resource.every);
    if (!(everyMs > 0)) {
      throw new Error(
        `Schedule.Interval "${resource.metadata.name}": \`every\` must be a positive duration ` +
          `(got "${resource.every}"). A zero or negative period would busy-loop the body.`,
      );
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
