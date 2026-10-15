import { type ObservationDeadline, type NeedConstraint } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";

/**
 * The observations a resource owes the kernel: one per concrete pointer at an
 * observing slot of its kind, due by the end of its startup — the deadline its
 * capability has (`OBSERVATION_DEADLINES`). Settled once, at the first return
 * of the entry point the deadline names; whatever is still missing then is
 * `ERR_NEED_OBSERVATION_INVALID`.
 */
export class NeedObservations {
  private readonly verified = new Set<string>();
  private settled = false;

  constructor(
    readonly label: string,
    readonly deadline: ObservationDeadline | undefined,
    /** Pointer → the constraints its slot observes. */
    readonly required: ReadonlyMap<string, readonly NeedConstraint[]>,
  ) {}

  record(pointer: string): void {
    this.verified.add(pointer);
  }

  /** Called when an entry point returns; refuses once the deadline is reached
   *  with an observation still missing. */
  settle(stage: ObservationDeadline): void {
    if (this.settled || stage !== this.deadline) return;
    this.settled = true;
    const missing = [...this.required.keys()].filter((pointer) => !this.verified.has(pointer));
    if (missing.length === 0) return;
    throw new RuntimeError(
      "ERR_NEED_OBSERVATION_INVALID",
      `${this.label} reported no observation for ${missing.map((p) => `'${p}'`).join(", ")} by the ` +
        `end of its startup (${STAGE_TEXT[stage]}). Its kind observes ` +
        `${missing.map((p) => `${this.required.get(p)!.join(" and ")} at '${p}'`).join(", ")}, so its ` +
        `controller must call ctx.verifyNeed for each before then.`,
    );
  }
}

const STAGE_TEXT: Record<ObservationDeadline, string> = {
  init: "when init() returns",
  run: "when run() returns",
  invoke: "when its first invoke() returns",
};

const trackers = new WeakMap<object, NeedObservations>();

export function trackNeedObservations(instance: object, tracker: NeedObservations): void {
  if (tracker.required.size > 0) trackers.set(instance, tracker);
}

export function needObservationsOf(instance: object): NeedObservations | undefined {
  return trackers.get(instance);
}

/** The deadline hook: an entry point of `instance` returned. */
export function settleNeedObservations(instance: object, stage: ObservationDeadline): void {
  trackers.get(instance)?.settle(stage);
}
