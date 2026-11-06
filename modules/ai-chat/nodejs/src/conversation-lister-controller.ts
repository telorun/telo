import { integerInput, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { operationsOf, type OperationCall } from "./operation-call.js";
import { wireSummary } from "./wire-shapes.js";

const SLOTS = ["list", "journalRead"] as const;
const DEFAULT_LIMIT = 25;

interface ListerResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
}

/** Whether a conversation's latest turn is open, judged by its journal key. */
export async function isRunning(
  journalRead: OperationCall,
  turn: string | null,
  ctx: InvokeContext | undefined,
): Promise<boolean> {
  if (turn === null) return false;
  const read = await journalRead.invoke({ key: turn, limit: 0 }, ctx);
  return read.state === "open";
}

/** The private controller behind AiChat.ListConversations. */
class ConversationLister implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;

  constructor(resource: ListerResource, ctx: ResourceContext) {
    this.ops = operationsOf(ctx, resource, "AiChat.ListConversations", SLOTS);
  }

  async invoke(inputs: Record<string, unknown>, ctx?: InvokeContext) {
    const { titleContains, archived, sort, limit, cursor } = inputs;
    const page = await this.ops.list.invoke(
      {
        ...(titleContains === undefined ? {} : { query: titleContains }),
        ...(archived === undefined ? {} : { archived }),
        direction: sort === "updatedAt" ? "asc" : "desc",
        limit: integerInput(limit) ?? DEFAULT_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ctx,
    );
    const rows = [];
    for (const header of page.rows as Array<Record<string, any>>) {
      rows.push(wireSummary(header, await isRunning(this.ops.journalRead, header.turn ?? null, ctx)));
    }
    return { rows, total: page.total, next: page.next ?? null };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: ListerResource, ctx: ResourceContext): Promise<ConversationLister> {
  return new ConversationLister(resource, ctx);
}
