/**
 * `DurableLocal.Resume` — the operator's override.
 *
 * Force a parked run forward against the code that is deployed now. It exists
 * for one situation and says so: a run parked because the manifest moved under
 * it (`ERR_DURABLE_MANIFEST_CHANGED`), where the alternatives are to strand the
 * run or to abandon it. Parking is a hold, not a grave.
 *
 * **The override is RECORDED**, as an ordinary journal entry, and that is what
 * makes it usable at all: a run continued against changed code may diverge from
 * what it would have done, and a divergent run has to be identifiable afterwards
 * rather than indistinguishable from a clean one.
 *
 * It does not execute the body here — it clears the park and lets the resumer
 * take it, which is the same path every other wake follows. One path means one
 * behaviour to keep correct.
 */
import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { runIdOf } from "./run-id.js";
import type { WorkflowController } from "./workflow.js";

interface ResumeManifest extends ResourceManifest {
  workflow: unknown;
  run?: string;
  reason?: string;
}

class ResumeController {
  constructor(
    private readonly resource: ResumeManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, _invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const run = runIdOf(this.ctx, this.resource.run, input, `DurableLocal.Resume '${name}'`);
    const journal = this.workflow().journal();

    const record = await journal.readRun(run);
    if (!record) {
      throw new InvokeError(
        "ERR_DURABLE_RUN_NOT_FOUND",
        `DurableLocal.Resume '${name}': no run '${run}' in this journal.`,
        { resource: name, run },
      );
    }
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      return { run, resumed: false, status: record.status };
    }

    const reason = String(
      this.ctx.expandValue(this.resource.reason ?? "resumed by operator", {
        inputs: input ?? {},
      }),
    );
    // Written at a root key of its own, outside `steps/`, because it is a fact
    // about the RUN rather than about any step of it — the same place the run's
    // inputs decision lives, and for the same reason.
    await journal.append(run, {
      path: `override/resume/${Date.now()}`,
      kind: "decision",
      decision: "value",
      value: { reason, at: new Date().toISOString() },
    });
    await journal.unparkRun(run);
    return { run, resumed: true };
  }

  private workflow(): WorkflowController {
    return this.ctx.resolveRef(
      this.resource.workflow,
      (v): v is object => !!v && typeof (v as WorkflowController).execute === "function",
      () => `DurableLocal.Resume "${String(this.resource.metadata.name)}": 'workflow'`,
      "DurableLocal.Workflow",
    ) as unknown as WorkflowController;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ResumeManifest,
  ctx: ResourceContext,
): Promise<ResumeController> {
  return new ResumeController(resource, ctx);
}
