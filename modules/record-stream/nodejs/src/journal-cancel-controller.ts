import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type Journal, type JournalCancelOutcome, isJournal } from "./journal.js";

interface JournalCancelResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

/**
 * RecordStream.JournalCancel — ask the writer of one key to stop, through the
 * journal's store alone, so the request reaches it from any replica. The
 * protocol lives in the journal; this only resolves it and relays the outcome.
 */
class JournalCancel implements ResourceInstance<{ key: string }, { outcome: JournalCancelOutcome }> {
  constructor(
    private readonly resource: JournalCancelResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: { key: string }): Promise<{ outcome: JournalCancelOutcome }> {
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalCancel "${this.resource.metadata.name}": 'journal'`,
      "Self.Journal",
    );
    return { outcome: await journal.cancel(inputs.key) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalCancelResource, ctx: ResourceContext): Promise<JournalCancel> {
  return new JournalCancel(resource, ctx);
}
