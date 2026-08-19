/**
 * `DurableLocal.Resumer` — the recovery and wake path, and NOT the scheduler.
 *
 * A start does its own first execution in the process that received it, so this
 * does not balance starts across workers; it picks up runs whose process died.
 * The trade is recorded rather than hidden: routing every start through this
 * poll interval would put seconds of latency on a request-triggered run for no
 * gain in recovery, since admitting before dispatch already makes an in-between
 * crash recoverable.
 *
 * Resuming is not a second code path. It calls the workflow's own `execute`,
 * because continuing an interrupted run and starting a fresh one are the SAME
 * operation — replay is what a resume IS. Two implementations here would be two
 * behaviours to keep agreeing, and the one that ran rarely would be the one that
 * drifted.
 */
import {
  SEVERITY,
  parseDurationMs,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import type { WorkflowController } from "./workflow.js";

interface ResumerManifest extends ResourceManifest {
  workflow: unknown;
  interval?: string;
}

/** How long a poller owns a run it claimed. Bounded so a poller that dies frees
 *  the run rather than wedging it — the same self-healing shape a lease has, and
 *  for the same reason. */
const CLAIM_TTL_MS = 60_000;

/** One pass at a time, so a slow batch cannot overlap itself into two pollers
 *  racing for the same runs inside one process. */
const BATCH = 10;

export class ResumerController {
  #timer: ReturnType<typeof setInterval> | undefined;
  #release: (() => void) | undefined;
  #sweeping = false;
  readonly #holder = crypto.randomUUID();

  constructor(
    private readonly resource: ResumerManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async run(): Promise<void> {
    const interval = parseDurationMs(this.resource.interval ?? "5s");
    // A service that is polling holds the kernel: an app whose only job is to
    // recover interrupted runs must not exit the moment its targets return.
    this.#release = this.ctx.acquireHold("resuming interrupted durable runs");
    this.#timer = setInterval(() => void this.sweep(), interval);
    // Never hold the process open for the timer ALONE — the hold above is what
    // keeps the app alive, and it is released at teardown.
    this.#timer.unref?.();
    // One pass immediately, so a restart recovers without waiting out an
    // interval it has no reason to.
    await this.sweep();
  }

  async teardown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#release?.();
  }

  private async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      const workflow = this.workflow();
      const journal = workflow.journal();
      for (const run of await journal.interruptedRuns(BATCH)) {
        // Claim before continuing, so several pollers against one store do not
        // both resume the same run and duplicate every unrecorded effect in it.
        if (!(await journal.claimRun(run, this.#holder, CLAIM_TTL_MS))) continue;
        try {
          await workflow.execute(run, journal, { inputs: {} });
          this.ctx.log.info("Resumed an interrupted run", { "durable.run": run });
        } catch (err) {
          // A resumed run that fails again is the run's own failure, already
          // settled in the journal by `execute`. It is reported and the sweep
          // continues — one bad run must not stop recovery of the others.
          this.ctx.log.warn("A resumed run failed", {
            "durable.run": run,
            "error.message": (err as Error).message,
          });
        }
      }
    } catch (err) {
      // The journal itself is unreachable. Logged rather than thrown: this runs
      // on a timer with no caller to receive it, and the next sweep may succeed.
      this.ctx.log.warn("Could not look for interrupted runs", {
        "error.message": (err as Error).message,
      });
    } finally {
      this.#sweeping = false;
    }
  }

  private workflow(): WorkflowController {
    return this.ctx.resolveRef(
      this.resource.workflow,
      (v): v is object => !!v && typeof (v as WorkflowController).execute === "function",
      () => `DurableLocal.Resumer "${this.resource.metadata.name}": 'workflow'`,
      "DurableLocal.Workflow",
    ) as unknown as WorkflowController;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ResumerManifest,
  ctx: ResourceContext,
): Promise<ResumerController> {
  if (ctx.log.enabled(SEVERITY.debug)) {
    ctx.log.debug("Resumer created", { "durable.interval": resource.interval ?? "5s" });
  }
  return new ResumerController(resource, ctx);
}
