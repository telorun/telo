import { isEventFrame, type DebugFrame } from "@telorun/debug-wire";

import type { RunTrigger } from "../contract.js";
import type { SessionRegistry } from "../session/registry.js";

/**
 * Projects per-app `run` events out of the kernel lifecycle events the debug
 * stream already carries.
 *
 * The runner cannot see inside the container, and parsing the merged PTY stream
 * is not a contract — so a watch session always runs with the kernel debug
 * stream on and this reads it. A watch reload is a stop/start pair on ONE debug
 * connection, so `generation` is counted here and the kernel is asked for
 * nothing.
 *
 * Three event names are read, and only three:
 *  - `Kernel.Starting`  → the generation began
 *  - `Kernel.Stopped`   → it ended, carrying `exitCode`
 *  - `Kernel.RunFailed` → it never reached a running state, carrying why
 *
 * `Kernel.Started` is deliberately ignored: it and `Kernel.Starting` bracket the
 * same transition, and one `started` per generation is the contract.
 */
export class RunProjection {
  /** What to attribute the NEXT generation of each app to. A reload is a watch
   *  reload unless something told us otherwise, so `watch` is the resting value
   *  and `initial` / `manual` / `resume` are set by whoever caused them. */
  private readonly triggers = new Map<string, RunTrigger>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly sessionId: string,
  ) {}

  /** Attribute an app's next generation. Called with `initial` when the session
   *  comes up, `manual` from the reload route, `resume` after a pod recreate. */
  expect(app: string, trigger: RunTrigger): void {
    this.triggers.set(app, trigger);
  }

  /** Attribute every app's next generation — the session-wide cases (initial,
   *  resume) always move all of them together. */
  expectAll(trigger: RunTrigger): void {
    const entry = this.registry.get(this.sessionId);
    for (const app of entry?.apps.keys() ?? []) this.triggers.set(app, trigger);
  }

  /** Feed one frame from `app`'s debug stream. Frames that are not one of the
   *  three lifecycle events pass through untouched. */
  frame(app: string, frame: DebugFrame): void {
    if (!isEventFrame(frame)) return;
    switch (frame.event) {
      case "Kernel.Starting":
        this.begin(app);
        return;
      case "Kernel.Stopped":
        this.registry.finishGeneration(this.sessionId, app, {
          phase: "completed",
          code: exitCodeOf(frame.payload),
        });
        return;
      case "Kernel.RunFailed":
        // A LOAD failure emits no `Kernel.Starting` — the kernel never got that
        // far — so open the generation here rather than reporting a failure of a
        // generation the client never saw start. The pair is what a consumer
        // reads as "this attempt happened and did not survive".
        this.begin(app);
        this.registry.finishGeneration(this.sessionId, app, {
          phase: "failed",
          reason: failureReason(frame.payload),
        });
        return;
      default:
        return;
    }
  }

  /**
   * Close the open generation because its WORKLOAD ended, not because the kernel
   * said so. A container that goes away under `--watch` emits no `Kernel.Stopped`
   * — there is nothing left to emit it — so the backend reports the ending and
   * this turns it into the same run outcome the kernel path produces.
   */
  endGeneration(app: string, outcome: { code?: number; reason?: string }): void {
    const channel = this.registry.get(this.sessionId)?.apps.get(app);
    if (!channel || channel.startedAt === null) return;
    this.registry.finishGeneration(
      this.sessionId,
      app,
      outcome.reason === undefined && outcome.code !== undefined
        ? { phase: "completed", code: outcome.code }
        : { phase: "failed", reason: outcome.reason ?? "workload ended" },
    );
  }

  /** Open a generation unless one is already open — `Kernel.Starting` followed
   *  by a `Kernel.RunFailed` from the boot phase must not count twice. */
  private begin(app: string): void {
    const channel = this.registry.get(this.sessionId)?.apps.get(app);
    if (!channel || channel.startedAt !== null) return;
    const trigger = this.triggers.get(app) ?? "watch";
    // Consumed: the next generation is a plain watch reload unless something
    // says otherwise again.
    this.triggers.delete(app);
    this.registry.startGeneration(this.sessionId, app, trigger);
  }
}

function exitCodeOf(payload: unknown): number {
  const code = (payload as { exitCode?: unknown } | undefined)?.exitCode;
  return typeof code === "number" ? code : 0;
}

/** The most actionable thing the failure carries: a diagnostic code when the
 *  kernel had one (`CEL_UNKNOWN_FIELD`, `ERR_MANIFEST_VALIDATION_FAILED`), else
 *  its message. A code is what a reader — an agent above all — branches on. */
function failureReason(payload: unknown): string {
  const p = payload as { code?: unknown; message?: unknown } | undefined;
  if (typeof p?.code === "string" && p.code !== "") return p.code;
  if (typeof p?.message === "string" && p.message !== "") return p.message;
  return "run failed";
}
