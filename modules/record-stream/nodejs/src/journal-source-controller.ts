import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { type JournalEntry, JournalStore, resolveJournal } from "./journal-store.js";

interface JournalSourceResource {
  metadata: { name: string; module?: string };
  journal?: JournalStore | { name: string; alias?: string };
}

interface JournalSourceInputs {
  key: string;
  fromId?: number;
}

interface JournalSourceOutputs {
  output: Stream<JournalEntry>;
}

/**
 * RecordStream.JournalSource — read a resumable stream from a Journal. Yields
 * `{ id, data }` entries with id greater than `fromId` (0 replays from the
 * start), then tails live until the key is finished or failed. A reconnecting
 * client passes its last seen id as `fromId` (an SSE `Last-Event-ID`) so it
 * replays exactly what it missed and then continues live; the `id` on each entry
 * is what the client checkpoints and sends back.
 */
class JournalSource implements ResourceInstance<JournalSourceInputs, JournalSourceOutputs> {
  constructor(
    private readonly resource: JournalSourceResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalSourceInputs): Promise<JournalSourceOutputs> {
    const name = this.resource.metadata.name;
    const key = inputs?.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.JournalSource "${name}": 'key' must be a non-empty string.`);
    }
    // Coerce: a CEL integer can cross the boundary as a bigint, and a value
    // derived from a query param may arrive as a numeric string.
    const fromId = Number(inputs?.fromId ?? 0);
    if (!Number.isInteger(fromId) || fromId < 0) {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.JournalSource "${name}": 'fromId' must be a non-negative integer.`);
    }
    const journal = resolveJournal(this.resource.journal, this.ctx);
    return { output: new Stream(journal.read(key, fromId)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: JournalSourceResource, ctx: ResourceContext): Promise<JournalSource> {
  return new JournalSource(resource, ctx);
}
