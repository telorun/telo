/**
 * `Durable.Sleep` — park until a time.
 *
 * The whole kind is three lines of logic and one journaled decision, and the
 * decision is the point. A sleep's wake time is derived from `now()`, which is
 * the sharpest impure read there is: re-deriving it on a resume would push the
 * deadline forward by however long the process was down, so a 72-hour wait that
 * crashed at hour 71 would restart at 72. Recording it once makes the deadline a
 * property of the run rather than of the process that happens to be executing
 * it.
 *
 * A resume then re-runs this controller and finds the wake time already past, so
 * the sleep simply returns — there is no separate "wake" path to keep agreeing
 * with the parking one.
 */
import {
  InvokeError,
  parseDurationMs,
  parkRun,
  assertMaySuspend,
  stepPath,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { recordPath, requireRun } from "./ambient-run.js";

interface SleepManifest extends ResourceManifest {
  for?: string;
  until?: string;
}

class SleepController {
  constructor(
    private readonly resource: SleepManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const handle = requireRun(invokeCtx, "Durable.Sleep", name);
    const path = recordPath(invokeCtx, name);
    const cel = { inputs: input ?? {} };

    // The wake time, pinned. Recorded under the dispatching step's path with a
    // segment of its own, so it cannot collide with the step entry the engine
    // writes at that path when the sleep finally returns.
    const wakeAt = (await handle.decide(stepPath(path, "wakeAt"), "value", () =>
      this.wakeTime(cel),
    )) as number;

    if (Date.now() >= wakeAt) return { wokeAt: wakeAt };

    // Checked only on the path that actually parks. A sleep whose deadline has
    // already passed suspends nothing, so refusing it inside a `noSuspend` zone
    // would reject a run that was about to complete.
    assertMaySuspend(this.ctx, invokeCtx, { resource: name });
    return parkRun(handle, { path, resource: name }, { at: wakeAt });
  }

  private wakeTime(cel: { inputs: unknown }): number {
    const name = String(this.resource.metadata.name);
    if (this.resource.until !== undefined) {
      const raw = this.ctx.expandValue(this.resource.until, cel);
      const at = typeof raw === "number" ? raw : Date.parse(String(raw));
      if (!Number.isFinite(at)) {
        throw new InvokeError(
          "ERR_DURABLE_SLEEP_INVALID",
          `Durable.Sleep '${name}': 'until' evaluated to ${JSON.stringify(raw)}, which is ` +
            `neither epoch milliseconds nor a parseable timestamp.`,
          { resource: name, value: raw },
        );
      }
      return at;
    }
    const raw = this.ctx.expandValue(this.resource.for, cel);
    const ms = parseDurationMs(String(raw));
    return Date.now() + ms;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: SleepManifest,
  ctx: ResourceContext,
): Promise<SleepController> {
  return new SleepController(resource, ctx);
}
