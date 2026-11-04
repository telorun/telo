import {
  Stream,
  integerInput,
  isInvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { turnNotFound } from "./chat-refusals.js";
import { operationsOf, type OperationCall } from "./operation-call.js";

const SLOTS = ["journalRead", "journalSource"] as const;
const ERR_JOURNAL_CANCELLED = "ERR_JOURNAL_CANCELLED";

interface ReaderResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
}

interface KeySnapshot {
  state: string;
  error: { code?: string; message: string; data?: unknown } | null;
  lastId: number;
}

/**
 * The frames that close a turn its writer never ended: derived from the key,
 * after its last record, so a resume from any id reads them again alike. A
 * cancelled key ends `cancelled`; any other recorded error is an `error` frame,
 * then `failed`.
 */
export function closingFrames(snapshot: KeySnapshot): Array<{ id: number; event: Record<string, unknown> }> {
  const error = snapshot.error;
  if (snapshot.state !== "failed" || !error) return [];
  const next = snapshot.lastId + 1;
  if (error.code === ERR_JOURNAL_CANCELLED) return [{ id: next, event: { type: "turn-end", reason: "cancelled" } }];
  const data = error.data;
  return [
    {
      id: next,
      event: {
        type: "error",
        code: error.code ?? "ERR_TURN_FAILED",
        detail: error.message,
        ...(data && typeof data === "object" && !Array.isArray(data) ? { data } : {}),
      },
    },
    { id: next + 1, event: { type: "turn-end", reason: "failed" } },
  ];
}

/** The private controller behind AiChat.TurnEvents. */
class EventReader implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;

  constructor(resource: ReaderResource, ctx: ResourceContext) {
    this.ops = operationsOf(ctx, resource, "AiChat.TurnEvents", SLOTS);
  }

  private async keyState(turn: string, ctx: InvokeContext | undefined): Promise<KeySnapshot> {
    const read = await this.ops.journalRead.invoke({ key: turn, limit: 0 }, ctx);
    return { state: read.state, error: read.error, lastId: integerInput(read.lastId) ?? 0 };
  }

  async invoke(inputs: { turn: string; after?: unknown }, ctx?: InvokeContext): Promise<{ output: Stream<unknown> }> {
    const after = integerInput(inputs.after) ?? 0;
    const first = await this.keyState(inputs.turn, ctx);
    if (first.state === "unknown" || first.state === "removed") throw turnNotFound(inputs.turn);
    let source: AsyncIterable<{ id: unknown; data: Record<string, any> }>;
    try {
      source = (await this.ops.journalSource.invoke({ key: inputs.turn, fromId: after }, ctx)).output;
    } catch (err) {
      if (isInvokeError(err) && err.code === "ERR_JOURNAL_KEY_REMOVED") throw turnNotFound(inputs.turn);
      throw err;
    }
    return { output: new Stream(this.frames(inputs.turn, after, source, ctx)) };
  }

  private async *frames(
    turn: string,
    after: number,
    source: AsyncIterable<{ id: unknown; data: Record<string, any> }>,
    ctx: InvokeContext | undefined,
  ): AsyncGenerator<{ id: number; event: Record<string, unknown> }> {
    try {
      // An event is journaled as the wire carries it; its position goes beside it,
      // since an event carries an `id` of its own (a tool call's, an approval's).
      for await (const entry of source) yield { id: integerInput(entry.id) ?? 0, event: entry.data };
      return;
    } catch (err) {
      // A recorded ERR_INVOKE_CANCELLED is the turn's ending; only this read's
      // own cancellation stops it.
      if (ctx?.cancellation.isCancelled) throw err;
      const ended = await this.keyState(turn, ctx);
      if (ended.state === "unknown" || ended.state === "removed") throw turnNotFound(turn);
      if (ended.state !== "failed") throw err;
      for (const frame of closingFrames(ended)) {
        if (frame.id > after) yield frame;
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: ReaderResource, ctx: ResourceContext): Promise<EventReader> {
  return new EventReader(resource, ctx);
}
