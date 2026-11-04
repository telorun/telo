import { InvokeError, type CancellationSource, type InvokeContext, type Logger } from "@telorun/sdk";
import { ATTACHMENT_SCHEME, attachmentKey, mintId } from "./chat-ids.js";
import { plainEvent } from "./part-events.js";
import { bytesOf, type TurnOperations, type TurnPlan } from "./turn-plan.js";
import { wirePart, wireToolResult } from "./wire-shapes.js";

const MEDIA = new Set(["image", "audio", "video", "file"]);

/** The turn a run belongs to. */
export interface TurnIdentity {
  conversation: string;
  turn: string;
}

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/**
 * The media a turn produces, kept as attachments: each is registered bound to
 * the turn's conversation — refused once another turn is current — then stored,
 * so it is readable as soon as its part is shown and no expiry pass reaches it.
 */
class ProducedMedia {
  constructor(
    private readonly ops: TurnOperations,
    private readonly identity: TurnIdentity,
    private readonly ctx: InvokeContext,
  ) {}

  /** A media part's bytes kept as a new attachment, the part then referring to it. */
  async kept(part: Record<string, any>): Promise<Record<string, any>> {
    if (!MEDIA.has(part.type) || part.data === undefined) return part;
    const bytes = isBytes(part.data) ? part.data : Buffer.from(String(part.data), "base64");
    const mediaType = String(part.mediaType ?? "application/octet-stream");
    const { id } = await this.ops.registerAttachment.invoke(
      {
        ...(typeof part.name === "string" && part.name.length > 0 ? { name: part.name } : {}),
        binding: { conversation: this.identity.conversation, turn: this.identity.turn },
      },
      this.ctx,
    );
    await this.ops.blobPut.invoke({ key: attachmentKey(id), content: bytes, contentType: mediaType }, this.ctx);
    const rest = { ...part };
    delete rest.data;
    return { ...rest, uri: `${ATTACHMENT_SCHEME}${id}`, mediaType };
  }

  /** A message the store can keep: every media part carrying bytes kept as an
   *  attachment and referred to. */
  async storable(message: Record<string, any>): Promise<Record<string, any>> {
    if (!Array.isArray(message.content)) return message;
    const content = [];
    for (const part of message.content) content.push(await this.kept(part));
    return { ...message, content };
  }
}

/** A stored message as the model is sent it: every attachment it refers to
 *  loaded into a `data` part. */
async function forModel(ops: TurnOperations, message: Record<string, any>, ctx: InvokeContext) {
  if (!Array.isArray(message.content)) return message;
  const content = [];
  for (const part of message.content) {
    if (MEDIA.has(part.type) && typeof part.uri === "string" && part.uri.startsWith(ATTACHMENT_SCHEME)) {
      const id = part.uri.slice(ATTACHMENT_SCHEME.length);
      const found = await ops.blobGet.invoke({ key: attachmentKey(id) }, ctx);
      const rest = { ...part };
      delete rest.uri;
      content.push({ ...rest, data: await bytesOf(found.output) });
    } else {
      content.push(part);
    }
  }
  return { ...message, content };
}

/** The user message a turn appends: its text, then its attachments by reference. */
function userMessage(text: string, media: Array<Record<string, unknown>>): Record<string, unknown> {
  if (media.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [...(text.length > 0 ? [{ type: "text", text }] : []), ...media],
  };
}

/**
 * The records of one turn, as its journal sink pulls them: the human decisions
 * and the user message are stored first, then each agent part becomes its
 * `Conversation.Event` and each `message` part is appended to the store. A
 * record is yielded before the store write it leads to, so whatever reaches the
 * store was journaled first — and nothing is stored once the journal refuses.
 */
export async function* turnRecords(
  ops: TurnOperations,
  identity: TurnIdentity,
  plan: TurnPlan,
  text: string,
  ctx: InvokeContext,
  agentOutput: (iterator: AsyncIterator<Record<string, any>>) => void,
): AsyncGenerator<Record<string, unknown>> {
  const { conversation, turn } = identity;
  const produced = new ProducedMedia(ops, identity, ctx);
  for (const decision of plan.decisions) {
    await ops.recordApproval.invoke(
      {
        conversation,
        turn,
        id: decision.id,
        entry: plan.parent,
        toolCallId: decision.toolCallId,
        decision: { approved: decision.approved, ...(decision.reason === undefined ? {} : { reason: decision.reason }) },
      },
      ctx,
    );
  }
  const messages = [];
  for (const row of plan.history) messages.push(await forModel(ops, row.message, ctx));
  let last = plan.parent;
  if (plan.decisions.length === 0) {
    const message = userMessage(text, plan.media);
    const stored = await ops.append.invoke({ conversation, parent: last, turn, message, attachments: plan.attachments }, ctx);
    last = stored.id;
    messages.push(await forModel(ops, message, ctx));
  }
  const { output } = await ops.agent.invoke(
    {
      messages,
      ...(plan.decisions.length === 0
        ? {}
        : {
            approvals: plan.decisions.map((d) => ({
              toolCallId: d.toolCallId,
              approved: d.approved,
              ...(d.reason === undefined ? {} : { reason: d.reason }),
            })),
          }),
    },
    ctx,
  );
  const iterator = (output as AsyncIterable<Record<string, any>>)[Symbol.asyncIterator]();
  agentOutput(iterator);
  // The entry holding each tool call, for the approvals recorded against it.
  const callEntries = new Map<string, string>();
  const record = (toolCallId: string, id: string, decision?: { approved: boolean; reason?: string }) =>
    ops.recordApproval.invoke(
      {
        conversation,
        turn,
        id,
        entry: callEntries.get(toolCallId) ?? last,
        toolCallId,
        ...(decision ? { decision } : {}),
      },
      ctx,
    );
  while (true) {
    const step = await iterator.next();
    if (step.done) return;
    const part = step.value;
    const plain = plainEvent(part);
    if (plain) {
      yield plain;
      // The terminal event: nothing the turn stores comes after it, so the
      // turn ends here and a client may send as soon as it has read it.
      if (part.type === "finish") return;
      continue;
    }
    switch (part.type) {
      case "provider-state":
        break;
      case "message": {
        const message = await produced.storable(part.message);
        const stored = await ops.append.invoke({ conversation, parent: last, turn, message }, ctx);
        last = stored.id;
        for (const call of (part.message.toolCalls ?? []) as Array<{ id: string }>) callEntries.set(call.id, stored.id);
        break;
      }
      case "content-part": {
        const shown = wirePart(await produced.kept(part.part), conversation);
        if (shown) yield { type: "content", part: shown };
        break;
      }
      case "tool-result": {
        const result = part.toolResult;
        const content = Array.isArray(result.content)
          ? (await produced.storable({ content: result.content })).content
          : result.content;
        yield {
          type: "tool-result",
          id: result.toolCallId,
          result: result.output !== undefined ? result.output : wireToolResult(content, conversation),
          ...(result.error === true ? { isError: true } : {}),
        };
        break;
      }
      case "tool-approval-decision": {
        const decided = part.approvalDecision;
        // A deferred call is named by the approval request that follows it.
        if (decided.decision === "defer") break;
        const id = mintId("apr_");
        const decision = {
          approved: decided.decision === "approve",
          ...(decided.reason === undefined ? {} : { reason: decided.reason }),
        };
        yield { type: "approval-decision", id, ...decision };
        await record(decided.toolCallId, id, decision);
        break;
      }
      case "tool-approval-request": {
        const call = part.toolCall;
        const id = mintId("apr_");
        yield { type: "approval-request", id, toolCallId: call.id, name: call.name, arguments: call.arguments ?? {} };
        await record(call.id, id);
        break;
      }
      default:
        throw new InvokeError(
          "ERR_CONTRACT_VIOLATION",
          `The agent emitted a '${String(part.type)}' part, which no conversation event carries.`,
        );
    }
  }
}

/**
 * What a turn's journal sink pulls. When the sink stops — a cancel request, a
 * refused write — it ends this input, and the stop reaches the agent: its
 * output is ended, which aborts the model call or tools in flight; before the
 * agent runs, the turn's own cancellation stops the store call in flight.
 */
export class TurnInput implements AsyncIterableIterator<Record<string, unknown>> {
  private agent?: AsyncIterator<Record<string, any>>;
  private readonly records: AsyncGenerator<Record<string, unknown>>;

  constructor(
    build: (agentOutput: (iterator: AsyncIterator<Record<string, any>>) => void) => AsyncGenerator<Record<string, unknown>>,
    private readonly stop: CancellationSource,
    private readonly log: Logger,
    private readonly turn: string,
  ) {
    this.records = build((iterator) => {
      this.agent = iterator;
    });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<Record<string, unknown>>> {
    const step = await this.records.next();
    if (step.done) this.closeAgent();
    return step;
  }

  /** Ends the agent's stream without waiting for it; false when it has none. */
  private closeAgent(): boolean {
    if (!this.agent?.return) return false;
    this.agent.return().catch((err: unknown) =>
      this.log.warn("The agent's stream failed while its turn was stopped", {
        turn: this.turn,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true;
  }

  async return(value?: unknown): Promise<IteratorResult<Record<string, unknown>>> {
    if (!this.closeAgent()) this.stop.cancel("the turn's journal stopped taking records");
    return this.records.return(value as never);
  }
}
