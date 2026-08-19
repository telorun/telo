/**
 * `DurableLocal.Cancel` — call a run off.
 *
 * `cancelled` is a state of its own, and not a synonym for `failed`. A failed
 * run earned a verdict; a cancelled one was stopped, which is a statement about
 * the caller rather than about the work. Collapsing them would also make every
 * cancelled run indistinguishable from a run that broke, in exactly the report
 * an operator reads to find out which happened.
 *
 * Terminal, so the resumer will not pick it up again. What it does NOT do is
 * interrupt a body executing right now in some process: that process owns its
 * own cancellation scope, and reaching into it is not something a journal can
 * do. The effect is that the run stops at its next park or resume, which is
 * stated here rather than discovered.
 */
import type { InvokeContext, ResourceContext, ResourceManifest } from "@telorun/sdk";
import { journalOf } from "./journal-ref.js";
import { runIdOf } from "./run-id.js";

interface CancelManifest extends ResourceManifest {
  journal: unknown;
  run?: string;
  reason?: string;
}

class CancelController {
  constructor(
    private readonly resource: CancelManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, _invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const cel = { inputs: input ?? {} };
    const run = runIdOf(this.ctx, this.resource.run, input, `DurableLocal.Cancel '${name}'`);
    const journal = journalOf(this.ctx, this.resource.journal, `DurableLocal.Cancel "${name}"`);

    const record = await journal.readRun(run);
    if (!record) return { run, cancelled: false, status: "unknown" };
    // A run that already finished is not cancelled retroactively — its result
    // exists and callers may already have read it.
    if (record.status === "completed" || record.status === "failed") {
      return { run, cancelled: false, status: record.status };
    }
    const reason = String(this.ctx.expandValue(this.resource.reason ?? "cancelled", cel));
    await journal.completeRun(run, {
      status: "cancelled",
      error: { code: "ERR_DURABLE_RUN_CANCELLED", message: reason },
    });
    return { run, cancelled: true, status: "cancelled" };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: CancelManifest,
  ctx: ResourceContext,
): Promise<CancelController> {
  return new CancelController(resource, ctx);
}
