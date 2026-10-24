import { isEventFrame, type DebugFrame } from "@telorun/debug-wire";

import type { RunTrigger } from "../contract.js";
import type { SessionRegistry } from "../session/registry.js";

/**
 * Projects per-app `run` events out of the kernel lifecycle events the debug
 * stream already carries.
 *
 * The runner cannot see inside the process, and parsing the merged PTY stream
 * is not a contract — so every run is started with the kernel debug stream on
 * and this reads it. A watch reload is a stop/start pair on ONE debug
 * connection, so `generation` is counted here and the kernel is asked for
 * nothing.
 *
 * Three event names are read, and only three:
 *  - `Kernel.Starting`  → the generation began, carrying the runtime's `telo`
 *                         version when it reports one
 *  - `Kernel.Stopped`   → it ended, carrying `exitCode`
 *  - `Kernel.RunFailed` → it never reached a running state, carrying why
 *
 * `Kernel.Started` is deliberately ignored: it and `Kernel.Starting` bracket the
 * same transition, and one `started` per generation is the contract.
 */
export class RunProjection {
  /** What to attribute the NEXT generation of each app to. A reload is a watch
   *  reload unless something told us otherwise, so `watch` is the resting value
   *  and `run` / `manual` are set by whoever caused them. */
  private readonly triggers = new Map<string, RunTrigger>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly sessionId: string,
  ) {}

  /** Attribute an app's next generation: `run` when a Run starts its process,
   *  `manual` from the reload route. */
  expect(app: string, trigger: RunTrigger): void {
    this.triggers.set(app, trigger);
  }

  /** Feed one frame from `app`'s debug stream. Frames that are not one of the
   *  three lifecycle events pass through untouched. */
  frame(app: string, frame: DebugFrame): void {
    if (!isEventFrame(frame)) return;
    switch (frame.event) {
      case "Kernel.Starting":
        this.begin(app, teloOf(frame.payload));
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
   * Close the open generation because its PROCESS ended, not because the kernel
   * said so: a process killed, or one whose `Kernel.Stopped` never reached the
   * runner, leaves the generation open, so the run's ending closes it with the
   * same run outcome the kernel path produces. Every pending attribution of
   * the app goes with it — the next process is attributed by whoever starts it.
   */
  endGeneration(app: string, outcome: { code?: number; signal?: string; reason?: string }): void {
    this.triggers.delete(app);
    const channel = this.registry.get(this.sessionId)?.apps.get(app);
    if (!channel || channel.startedAt === null) return;
    this.registry.finishGeneration(this.sessionId, app, runOutcome(outcome));
  }

  /** Open a generation unless one is already open — `Kernel.Starting` followed
   *  by a `Kernel.RunFailed` from the boot phase must not count twice. */
  private begin(app: string, telo?: string): void {
    const channel = this.registry.get(this.sessionId)?.apps.get(app);
    if (!channel || channel.startedAt !== null) return;
    const trigger = this.triggers.get(app) ?? "watch";
    // Consumed: the next generation is a plain watch reload unless something
    // says otherwise again.
    this.triggers.delete(app);
    this.registry.startGeneration(this.sessionId, app, trigger, telo);
  }
}

function runOutcome(outcome: {
  code?: number;
  signal?: string;
  reason?: string;
}): { phase: "completed"; code: number } | { phase: "failed"; reason: string } {
  if (outcome.reason !== undefined) return { phase: "failed", reason: outcome.reason };
  if (outcome.signal !== undefined) return { phase: "failed", reason: `terminated by ${outcome.signal}` };
  if (outcome.code !== undefined) return { phase: "completed", code: outcome.code };
  return { phase: "failed", reason: "the process ended" };
}

/** The version the runtime says it is. Passed on, never compared: by the time
 *  this frame arrives the manifest has loaded on that runtime. */
function teloOf(payload: unknown): string | undefined {
  const telo = (payload as { telo?: unknown } | undefined)?.telo;
  return typeof telo === "string" && telo !== "" ? telo : undefined;
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
