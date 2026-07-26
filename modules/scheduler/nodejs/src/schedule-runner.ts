import {
  SEVERITY,
  resolveInvocableDispatcher,
  type ResourceContext,
} from "@telorun/sdk";

export interface ScheduleResource {
  metadata: { name: string; module?: string };
  invoke?: unknown;
  inputs?: Record<string, unknown>;
  when?: unknown;
}

/** Milliseconds until the next fire, measured from now. `null` ends the schedule
 *  (a cron expression with no further occurrences). */
export type NextDelay = () => number | null;

/**
 * The shared body of both schedule kinds: arm a one-shot timer, fire, re-arm.
 *
 * A repeating `setInterval` is deliberately not used. Re-arming only after a
 * tick settles means a body slower than the period can never stack up an
 * unbounded queue of overlapping runs, and it is the only shape a cron schedule
 * (whose gaps are irregular) can use at all — so both kinds share one path.
 *
 * Lifecycle mirrors the other inbound sources (`Http.Server`, `Mcp.StdioServer`):
 * `init()` prepares and arms nothing, `run()` starts ticking from the app's
 * `targets`, `teardown()` disarms and drains. Starting in `init()` would fire
 * inside the multi-pass init loop — before resources this schedule holds no
 * `!ref` edge to exist — and would leave an author no way to order a schedule
 * after a migration target.
 */
export class ScheduleRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly resource: ScheduleResource,
    private readonly ctx: ResourceContext,
    private readonly label: string,
    private readonly nextDelay: NextDelay,
  ) {}

  async init(): Promise<void> {
    // Nothing to arm here on purpose — see the class docstring.
  }

  async run(): Promise<void> {
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    const delay = this.nextDelay();
    if (delay === null) {
      this.ctx.log.log(SEVERITY.info, `${this.label}: no further occurrences; schedule ended.`);
      return;
    }
    this.timer = setTimeout(() => {
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
        this.arm();
      });
    }, delay);
  }

  /** One tick. Never throws: a failing body must not kill the schedule, but the
   *  failure is reported in full rather than dropped. */
  private async tick(): Promise<void> {
    try {
      if (!this.gateOpen()) return;
      const inputs = (this.ctx.expandValue(this.resource.inputs ?? {}, {}) ??
        {}) as Record<string, unknown>;
      const dispatch = resolveInvocableDispatcher(
        this.resource.invoke,
        this.ctx,
        () => this.label,
      );
      await dispatch(inputs);
    } catch (err) {
      this.ctx.log.log(SEVERITY.error, `${this.label}: tick failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** A `when` that isn't a boolean is an authoring error, not a silent skip —
   *  reported, and the tick is skipped so a bad gate can't fire the body. */
  private gateOpen(): boolean {
    if (this.resource.when === undefined) return true;
    const verdict = this.ctx.expandValue(this.resource.when, {});
    if (typeof verdict !== "boolean") {
      this.ctx.log.log(
        SEVERITY.error,
        `${this.label}: \`when\` evaluated to ${typeof verdict}, expected a boolean — tick skipped.`,
      );
      return false;
    }
    return verdict;
  }

  /** Disarm first so no new tick starts, then drain the one already running. */
  async teardown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}
