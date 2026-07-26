import { type ResourceContext } from "@telorun/sdk";
import { CronExpressionParser } from "cron-parser";
import { ScheduleRunner, type ScheduleResource } from "./schedule-runner.js";

interface CronResource extends ScheduleResource {
  cron: string;
  timezone?: string;
}

export const cron = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: CronResource, ctx: ResourceContext) {
    const label = `Schedule.Cron "${resource.metadata.name}"`;
    const tz = resource.timezone ?? "UTC";

    // Parse once at create time so a malformed expression or unknown timezone
    // fails the manifest at boot, not silently at the first missed tick.
    try {
      CronExpressionParser.parse(resource.cron, { tz });
    } catch (err) {
      throw new Error(
        `${label}: invalid cron expression "${resource.cron}" for timezone "${tz}". ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-parse from "now" on every arm rather than holding one iterator: the
    // gap between cron occurrences is irregular (DST, month lengths), so the
    // next fire must be computed against the current clock, not stepped from
    // the schedule's start.
    const nextDelay = () => {
      const next = CronExpressionParser.parse(resource.cron, { tz, currentDate: new Date() });
      try {
        return Math.max(0, next.next().toDate().getTime() - Date.now());
      } catch {
        // A bounded expression can run out of occurrences — end the schedule
        // rather than re-arming forever.
        return null;
      }
    };

    return new ScheduleRunner(resource, ctx, label, nextDelay);
  },
};
