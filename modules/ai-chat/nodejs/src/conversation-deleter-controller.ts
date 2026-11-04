import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { operationsOf, type OperationCall } from "./operation-call.js";

const SLOTS = ["read", "journalCancel", "delete"] as const;

interface DeleterResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
}

/**
 * The private controller behind AiChat.DeleteConversation: asks the running
 * turn to stop, then deletes the conversation, which releases its files in the
 * same write; an expiry pass removes their bytes.
 */
class ConversationDeleter implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;

  constructor(resource: DeleterResource, ctx: ResourceContext) {
    this.ops = operationsOf(ctx, resource, "AiChat.DeleteConversation", SLOTS);
  }

  async invoke(inputs: { id: string }, ctx?: InvokeContext) {
    const header = await this.ops.read.invoke({ conversation: inputs.id }, ctx);
    if (header.turn !== null && header.turn !== undefined) {
      await this.ops.journalCancel.invoke({ key: String(header.turn) }, ctx);
    }
    await this.ops.delete.invoke({ conversation: inputs.id }, ctx);
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: DeleterResource, ctx: ResourceContext): Promise<ConversationDeleter> {
  return new ConversationDeleter(resource, ctx);
}
