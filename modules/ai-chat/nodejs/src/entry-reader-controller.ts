import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { operationsOf, type OperationCall } from "./operation-call.js";
import { wireEntry } from "./wire-shapes.js";

const SLOTS = ["entries"] as const;

interface EntryReaderResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
}

/** The private controller behind AiChat.ConversationEntries. */
class EntryReader implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;

  constructor(resource: EntryReaderResource, ctx: ResourceContext) {
    this.ops = operationsOf(ctx, resource, "AiChat.ConversationEntries", SLOTS);
  }

  async invoke(inputs: { id: string; through?: string; limit?: unknown; cursor?: string }, ctx?: InvokeContext) {
    const page = await this.ops.entries.invoke(
      {
        conversation: inputs.id,
        ...(inputs.through === undefined ? {} : { through: inputs.through }),
        ...(inputs.limit === undefined ? {} : { limit: inputs.limit }),
        ...(inputs.cursor === undefined ? {} : { cursor: inputs.cursor }),
      },
      ctx,
    );
    return {
      rows: (page.rows as Array<Record<string, any>>).map((row) => wireEntry(row, inputs.id)),
      total: page.total,
      next: page.next ?? null,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: EntryReaderResource, ctx: ResourceContext): Promise<EntryReader> {
  return new EntryReader(resource, ctx);
}
