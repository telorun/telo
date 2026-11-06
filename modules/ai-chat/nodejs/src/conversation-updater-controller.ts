import { isInvokeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { ERR_CONVERSATION_CONFLICT, conflictAfterRetries } from "./chat-refusals.js";
import { isRunning } from "./conversation-lister-controller.js";
import { operationsOf, type OperationCall } from "./operation-call.js";
import { versionOf } from "./turn-plan.js";
import { wireSummary } from "./wire-shapes.js";

const SLOTS = ["read", "update", "journalRead"] as const;
/** How many rounds a change tries against a header that keeps changing. */
const ROUNDS = 3;

interface UpdaterResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
}

/** The private controller behind AiChat.UpdateConversation: a rename or an
 *  archive applied at the version just read, re-read on a conflict. */
class ConversationUpdater implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;

  constructor(resource: UpdaterResource, ctx: ResourceContext) {
    this.ops = operationsOf(ctx, resource, "AiChat.UpdateConversation", SLOTS);
  }

  async invoke(inputs: { id: string; title?: string; archived?: boolean }, ctx?: InvokeContext) {
    for (let round = 0; round < ROUNDS; round++) {
      const header = await this.ops.read.invoke({ conversation: inputs.id }, ctx);
      let updated: Record<string, any>;
      try {
        updated = await this.ops.update.invoke(
          {
            conversation: inputs.id,
            version: versionOf(header),
            ...(inputs.title === undefined ? {} : { title: inputs.title }),
            ...(inputs.archived === undefined ? {} : { archived: inputs.archived }),
          },
          ctx,
        );
      } catch (err) {
        if (isInvokeError(err) && err.code === ERR_CONVERSATION_CONFLICT) continue;
        throw err;
      }
      return wireSummary(updated, await isRunning(this.ops.journalRead, updated.turn ?? null, ctx));
    }
    throw conflictAfterRetries(inputs.id);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: UpdaterResource, ctx: ResourceContext): Promise<ConversationUpdater> {
  return new ConversationUpdater(resource, ctx);
}
