import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type Journal, isJournal } from "./journal.js";

interface JournalRemovalResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

interface JournalRemovalOutputs {
  outcome: "removed" | "unknown";
}

/**
 * RecordStream.JournalRemoval — remove one key through a journal. Its records
 * are dropped and a marker left, so readers are told it was removed; removing
 * an already-removed key reports `removed` again.
 */
class JournalRemoval implements ResourceInstance<{ key: string }, JournalRemovalOutputs> {
  constructor(
    private readonly resource: JournalRemovalResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: { key: string }): Promise<JournalRemovalOutputs> {
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalRemoval "${this.resource.metadata.name}": 'journal'`,
      "Self.Journal",
    );
    return { outcome: await journal.remove(inputs.key) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalRemovalResource, ctx: ResourceContext): Promise<JournalRemoval> {
  return new JournalRemoval(resource, ctx);
}
