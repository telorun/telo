import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type Journal, isJournal } from "./journal.js";

interface JournalExpiryResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

/**
 * RecordStream.JournalExpiry — one expiry pass over a journal's store: keys of
 * writers that stopped heartbeating are failed, finished and failed keys older
 * than the journal's retention are removed (counted), and removal markers older
 * than it are forgotten. Triggered by the application's scheduler.
 */
class JournalExpiry implements ResourceInstance<Record<string, never>, { count: number }> {
  constructor(
    private readonly resource: JournalExpiryResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(): Promise<{ count: number }> {
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalExpiry "${this.resource.metadata.name}": 'journal'`,
      "Self.Journal",
    );
    return { count: await journal.expire() };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalExpiryResource, ctx: ResourceContext): Promise<JournalExpiry> {
  return new JournalExpiry(resource, ctx);
}
