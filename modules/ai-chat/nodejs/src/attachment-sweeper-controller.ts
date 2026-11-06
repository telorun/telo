import { celTimestampFromMillis, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { attachmentKey } from "./chat-ids.js";
import { isChatEndpoint } from "./conversation-controller.js";
import { operationsOf, type OperationCall } from "./operation-call.js";

const SLOTS = ["expire", "forget", "blobDelete"] as const;
/** The batch one store call releases and returns. */
const BATCH = 500;

interface SweeperResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
  conversation?: unknown;
}

/**
 * The private controller behind AiChat.AttachmentExpiry: releases the uploads
 * past the endpoint's pending retention, then removes the bytes of every
 * released file — those and a deleted conversation's — before forgetting its
 * record, a batch at a time until a batch comes back short. A failed removal
 * fails the pass; its file stays released, so the next pass finishes it.
 */
class AttachmentSweeper implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;
  private readonly label: string;

  constructor(
    private readonly resource: SweeperResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `AiChat.AttachmentExpiry "${resource.metadata.name}"`;
    this.ops = operationsOf(ctx, resource, "AiChat.AttachmentExpiry", SLOTS);
  }

  async invoke(inputs: Record<string, never>, ctx?: InvokeContext): Promise<{ count: number }> {
    const endpoint = this.ctx.resolveRef(
      this.resource.conversation,
      isChatEndpoint,
      () => `${this.label}: 'conversation'`,
      "AiChat.Conversation",
    );
    const expiredBefore = celTimestampFromMillis(Date.now() - endpoint.pendingRetentionMs());
    let count = 0;
    for (;;) {
      const { ids } = (await this.ops.expire.invoke({ expiredBefore, limit: BATCH }, ctx)) as { ids: string[] };
      for (const id of ids) await this.ops.blobDelete.invoke({ key: attachmentKey(id) }, ctx);
      if (ids.length > 0) await this.ops.forget.invoke({ ids }, ctx);
      count += ids.length;
      if (ids.length < BATCH) return { count };
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: SweeperResource, ctx: ResourceContext): Promise<AttachmentSweeper> {
  return new AttachmentSweeper(resource, ctx);
}
