/**
 * `DurableLocal.Status` — what is this run doing right now?
 *
 * Separate from `Result` because the questions have different answers and
 * different costs: status is a live reading that an operator polls, while a
 * result is a terminal value that may be worth waiting for. One kind answering
 * both would have to decide which of the two it was on every call.
 */
import type { InvokeContext, ResourceContext, ResourceManifest } from "@telorun/sdk";
import { journalOf } from "./journal-ref.js";
import { runIdOf } from "./run-id.js";

interface StatusManifest extends ResourceManifest {
  journal: unknown;
  run?: string;
}

class StatusController {
  constructor(
    private readonly resource: StatusManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, _invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const run = runIdOf(this.ctx, this.resource.run, input, `DurableLocal.Status '${name}'`);
    const journal = journalOf(this.ctx, this.resource.journal, `DurableLocal.Status "${name}"`);
    const record = await journal.readRun(run);
    // A run nobody admitted is `unknown` rather than an error: asking about an id
    // that was never started is a legitimate question with a legitimate answer,
    // and it is the same answer a purged run gives.
    if (!record) return { run, status: "unknown" };
    return {
      run,
      status: record.status,
      ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
      ...(record.parked === undefined
        ? {}
        : { parked: { path: record.parked.path, resource: record.parked.resource } }),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: StatusManifest,
  ctx: ResourceContext,
): Promise<StatusController> {
  return new StatusController(resource, ctx);
}
