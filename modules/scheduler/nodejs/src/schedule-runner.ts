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
 * `targets` and returns the effect that disarms and drains. Starting in `init()` would fire
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

  // Nothing is armed in `init()` on purpose — see the class docstring.

  run() {
    return this.ctx.effect("armed schedule", async () => {
      this.arm();
      return { result: undefined, inverse: () => this.disarm() };
    });
  }

  /** Disarm and drain: the inverse of arming. An occurrence already in flight is
   *  awaited rather than abandoned, so a schedule cannot be torn down mid-run. */
  private async disarm(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private arm(): void {
    if (this.stopped) return;
    const delay = this.nextDelay();
    if (delay === null) {
      this.ctx.log.info("No further occurrences; the schedule has ended");
      return;
    }
    if (this.ctx.log.enabled(SEVERITY.debug)) {
      this.ctx.log.debug("Armed for the next occurrence", { "schedule.delay_ms": delay });
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
      const gate = this.gate();
      // A skipped tick is indistinguishable from one that never came due — the
      // schedule just goes quiet — so the gate's verdict is only visible here.
      // An invalid gate has already reported itself at `error`.
      if (gate === "closed") {
        this.ctx.log.debug("Tick skipped: the `when` gate is closed");
        return;
      }
      if (gate === "invalid") return;
      const inputs = (this.ctx.expandValue(this.resource.inputs ?? {}, {}) ??
        {}) as Record<string, unknown>;
      const dispatch = resolveInvocableDispatcher(
        this.resource.invoke,
        this.ctx,
        () => this.label,
      );
      this.ctx.log.debug("Tick firing");
      // rootContext: a timer-driven inbound dispatch starts from a context
      // inheriting nothing ambient (kernel/specs/execution-zones.md §7).
      await dispatch(inputs, this.ctx.rootContext());
    } catch (err) {
      // The thrown value goes in `error`, not into an attribute: the record's
      // `error` field is the structured ErrorValue (§4.2), so it keeps the type,
      // the stack, and the `cause` chain that `err.message` alone discards.
      this.ctx.log.error("Tick failed", undefined, { error: err });
    }
  }

  /** A `when` that isn't a boolean is an authoring error, not a silent skip —
   *  reported, and the tick is skipped so a bad gate can't fire the body. The
   *  three verdicts stay distinct because they are reported differently: a closed
   *  gate is routine, an invalid one is a defect. */
  private gate(): "open" | "closed" | "invalid" {
    if (this.resource.when === undefined) return "open";
    const verdict = this.ctx.expandValue(this.resource.when, {});
    if (typeof verdict !== "boolean") {
      this.ctx.log.error(
        `\`when\` evaluated to ${typeof verdict}, expected a boolean — tick skipped`,
      );
      return "invalid";
    }
    return verdict ? "open" : "closed";
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}
