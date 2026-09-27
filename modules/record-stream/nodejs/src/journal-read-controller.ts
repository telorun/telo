import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { type Journal, type JournalSnapshot, isJournal } from "./journal.js";

interface JournalReadResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

interface JournalReadInputs {
  key: string;
  fromId?: number | bigint;
  limit?: number | bigint;
}

/**
 * RecordStream.JournalRead — one snapshot of a key: its state (`unknown`,
 * `open`, `finished`, `failed` or `removed`), the recorded error of a failed
 * key, the id of its last record, and the entries after `fromId`. Never waits
 * and never raises for the key's state; a store failure still raises.
 */
class JournalRead implements ResourceInstance<JournalReadInputs, JournalSnapshot> {
  constructor(
    private readonly resource: JournalReadResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalReadInputs): Promise<JournalSnapshot> {
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalRead "${this.resource.metadata.name}": 'journal'`,
      "Self.Journal",
    );
    // A CEL integer crosses the boundary as a bigint.
    const fromId = Number(inputs.fromId ?? 0);
    const limit = inputs.limit === undefined ? undefined : Number(inputs.limit);
    return journal.read(inputs.key, fromId, limit);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalReadResource, ctx: ResourceContext): Promise<JournalRead> {
  return new JournalRead(resource, ctx);
}
