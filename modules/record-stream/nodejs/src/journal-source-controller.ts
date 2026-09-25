import type { InvokeContext, KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { NEVER_CANCELLED, Stream } from "@telorun/sdk";
import { type Journal, type JournalEntry, isJournal } from "./journal.js";

interface JournalSourceResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

interface JournalSourceInputs {
  key: string;
  fromId?: number | bigint;
}

interface JournalSourceOutputs {
  output: Stream<JournalEntry>;
}

/**
 * RecordStream.JournalSource — read a key from an offset: `{ id, data }` entries
 * with id greater than `fromId`, then whatever the key's state says — tail it
 * while it is live, end once finished, raise the recorded error once failed,
 * raise `ERR_JOURNAL_WRITER_LOST` once its writer stopped heartbeating, and
 * raise `ERR_JOURNAL_KEY_REMOVED` for a removed key (from this invoke when it is
 * removed at open). A key never written is waited for. The stream ends when its
 * consumer stops, and raises `ERR_INVOKE_CANCELLED` once this invocation is
 * cancelled.
 */
class JournalSource implements ResourceInstance<JournalSourceInputs, JournalSourceOutputs> {
  constructor(
    private readonly resource: JournalSourceResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalSourceInputs, invokeCtx?: InvokeContext): Promise<JournalSourceOutputs> {
    const name = this.resource.metadata.name;
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalSource "${name}": 'journal'`,
      "Self.Journal",
    );
    // A CEL integer crosses the boundary as a bigint.
    const fromId = Number(inputs.fromId ?? 0);
    // The stream ends when its consumer stops, and is cancelled with this invocation.
    const cancellation = invokeCtx?.cancellation ?? NEVER_CANCELLED;
    return { output: new Stream(await journal.open(inputs.key, fromId, cancellation)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalSourceResource, ctx: ResourceContext): Promise<JournalSource> {
  return new JournalSource(resource, ctx);
}
