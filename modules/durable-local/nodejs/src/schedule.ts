/**
 * `DurableLocal.Schedule` — admit a run now, execute it later.
 *
 * The one operation that must NOT dispatch. A start's whole shape is
 * admit-then-execute-here; a schedule admits and stops, leaving the resumer to
 * pick the run up when its time comes. That is also why a scheduled run stores
 * its inputs: there is no caller at the moment it starts, so what it was
 * scheduled with is the only place they can come from.
 *
 * Distinct from `Scheduler.Cron`, and the difference is the point: a cron firing
 * missed while the process is down is simply missed, while a scheduled run is a
 * durable record that a restart still finds due.
 */
import {
  InvokeError,
  parseDurationMs,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import type { WorkflowController } from "./workflow.js";

interface ScheduleManifest extends ResourceManifest {
  workflow: unknown;
  runId?: string;
  after?: string;
  at?: string;
  inputs?: Record<string, unknown>;
}

class ScheduleController {
  constructor(
    private readonly resource: ScheduleManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, _invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const cel = { inputs: input ?? {} };
    const workflow = this.workflow();
    const journal = workflow.journal();

    const inputs = this.ctx.expandValue(this.resource.inputs ?? {}, cel) as Record<string, unknown>;
    const runId =
      this.resource.runId === undefined
        ? `${name}:${crypto.randomUUID()}`
        : String(this.ctx.expandValue(this.resource.runId, cel));
    const dueAt = this.dueAt(cel);

    const admission = await journal.admitRun(runId, { status: "scheduled", dueAt, inputs });
    // An id already taken is not scheduled a second time. Same rule the
    // workflow's own `attach` follows, and for the same reason: a caller-chosen
    // id is how "do this once" is expressed, and it must mean that here too.
    if (!admission.admitted) {
      return { runId, scheduled: false, status: admission.existing?.status ?? "unknown" };
    }
    return { runId, scheduled: true, dueAt };
  }

  private dueAt(cel: { inputs: unknown }): number {
    const name = String(this.resource.metadata.name);
    if (this.resource.at !== undefined) {
      const raw = this.ctx.expandValue(this.resource.at, cel);
      const at = typeof raw === "number" ? raw : Date.parse(String(raw));
      if (!Number.isFinite(at)) {
        throw new InvokeError(
          "ERR_DURABLE_SCHEDULE_INVALID",
          `DurableLocal.Schedule '${name}': 'at' evaluated to ${JSON.stringify(raw)}, which ` +
            `is neither epoch milliseconds nor a parseable timestamp.`,
          { resource: name, value: raw },
        );
      }
      return at;
    }
    return Date.now() + parseDurationMs(String(this.ctx.expandValue(this.resource.after, cel)));
  }

  private workflow(): WorkflowController {
    return this.ctx.resolveRef(
      this.resource.workflow,
      (v): v is object => !!v && typeof (v as WorkflowController).execute === "function",
      () => `DurableLocal.Schedule "${String(this.resource.metadata.name)}": 'workflow'`,
      "DurableLocal.Workflow",
    ) as unknown as WorkflowController;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ScheduleManifest,
  ctx: ResourceContext,
): Promise<ScheduleController> {
  return new ScheduleController(resource, ctx);
}
