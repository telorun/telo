import { InvokeError, integerInput, isInvokeError, timestampNanos, type CelTimestamp, type InvokeContext } from "@telorun/sdk";
import { attachmentKey, ATTACHMENT_SCHEME } from "./chat-ids.js";
import { inputInvalid } from "./chat-refusals.js";
import { offeredEntry, type ConversationSpec } from "./conversation-spec.js";
import type { OperationCall } from "./operation-call.js";

export const TURN_OPERATIONS = [
  "agent",
  "create",
  "read",
  "admit",
  "append",
  "entries",
  "recordApproval",
  "journalRead",
  "journalClaim",
  "journalSink",
  "journalSource",
  "journalRemoval",
  "registerAttachment",
  "readAttachment",
  "blobGet",
  "blobHead",
  "blobPut",
] as const;

export type TurnOperations = Record<(typeof TURN_OPERATIONS)[number], OperationCall>;

/** A `Conversation.TurnRequest` as `AiChat.StartTurn` takes it. */
export interface TurnRequest {
  conversation?: string;
  /** Absent, `null` or an entry id — three different requests. */
  parent?: string | null;
  message: string;
  attachments: string[];
  approvals?: Array<{ id: string; approved: boolean; reason?: string }>;
}

/** A human decision on a pending call, recorded before the agent runs. */
export interface Decision {
  id: string;
  toolCallId: string;
  approved: boolean;
  reason?: string;
}

/** What admission decided from the request and the stored branch. */
export interface TurnPlan {
  /** The entry the turn follows; null for a new root. */
  parent: string | null;
  /** The branch from its root down to `parent`, as stored. */
  history: Array<Record<string, any>>;
  decisions: Decision[];
  /** The user message's media parts, each by attachment reference. */
  media: Array<Record<string, unknown>>;
  /** The attachment ids the user message carries, in order. */
  attachments: string[];
}

const ENTRY_PAGE = 500;

/** Every row of a branch, leaf to root. */
async function branchRows(
  ops: TurnOperations,
  conversation: string,
  through: string | undefined,
  ctx: InvokeContext,
): Promise<Array<Record<string, any>>> {
  const rows: Array<Record<string, any>> = [];
  let cursor: string | undefined;
  do {
    const page = await ops.entries.invoke(
      {
        conversation,
        limit: ENTRY_PAGE,
        ...(through === undefined ? {} : { through }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      ctx,
    );
    rows.push(...page.rows);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

/** The branch a turn follows, and the entry it follows: the parent rules of the
 *  conversation contract. */
async function resolveParent(
  ops: TurnOperations,
  request: TurnRequest,
  conversation: string,
  isNew: boolean,
  ctx: InvokeContext,
): Promise<{ parent: string | null; history: Array<Record<string, any>> }> {
  if (isNew || request.parent === null) return { parent: null, history: [] };
  if (request.parent === undefined) {
    const rows = await branchRows(ops, conversation, undefined, ctx);
    return { parent: rows[0]?.id ?? null, history: rows.reverse() };
  }
  let rows: Array<Record<string, any>>;
  try {
    rows = await branchRows(ops, conversation, request.parent, ctx);
  } catch (err) {
    if (isInvokeError(err) && err.code === "ERR_CONVERSATION_ENTRY_NOT_FOUND") {
      throw inputInvalid(`Conversation '${conversation}' has no entry '${request.parent}'.`, [
        { pointer: "/parent" },
      ]);
    }
    throw err;
  }
  // The branch continues below the parent; the turn follows the parent itself.
  const at = rows.findIndex((row) => row.id === request.parent);
  return { parent: request.parent, history: rows.slice(at).reverse() };
}

/** The decisions a turn records: a parent with undecided approvals must have
 *  every one decided, and a decision must name one of them. */
function decisionsOf(request: TurnRequest, parentRow: Record<string, any> | undefined): Decision[] {
  const pending = ((parentRow?.approvals ?? []) as Array<Record<string, any>>).filter(
    (approval) => approval.decision === null || approval.decision === undefined,
  );
  const approvals = request.approvals;
  if (pending.length === 0) {
    if (approvals === undefined) return [];
    throw inputInvalid("The entry this turn follows has no approval waiting for a decision.", [
      { pointer: "/approvals" },
    ]);
  }
  if (approvals === undefined) {
    throw inputInvalid(
      `The entry this turn follows has ${pending.length} undecided approval(s); decide every one in 'approvals'.`,
      [{ pointer: "/approvals" }],
    );
  }
  const byId = new Map(pending.map((approval) => [approval.id as string, approval]));
  const seen = new Set<string>();
  const decisions: Decision[] = [];
  approvals.forEach((approval, index) => {
    const waiting = byId.get(approval.id);
    if (!waiting || seen.has(approval.id)) {
      throw inputInvalid(`'${approval.id}' names no undecided approval of the entry this turn follows.`, [
        { pointer: `/approvals/${index}` },
      ]);
    }
    seen.add(approval.id);
    decisions.push({
      id: approval.id,
      toolCallId: waiting.toolCallId,
      approved: approval.approved,
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    });
  });
  if (seen.size !== pending.length) {
    throw inputInvalid("Every undecided approval of the entry this turn follows must be decided.", [
      { pointer: "/approvals" },
    ]);
  }
  return decisions;
}

/** A blob's content, read whole. */
export async function bytesOf(output: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of output) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export const ERR_CONVERSATION_ATTACHMENT_NOT_FOUND = "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND";

/** The one refusal of an attachment a turn may not name, wherever it is decided. */
export function attachmentRefused(id: string, index: number): InvokeError {
  return inputInvalid(
    `Attachment '${id}' is not available to this conversation: it is unknown, expired or deleted, or held by another conversation.`,
    [{ pointer: `/attachments/${index}` }],
  );
}

const millisOf = (instant: CelTimestamp) => Number(timestampNanos(instant) / 1_000_000n);

/** Each attachment held to what the conversation may name and what it offers,
 *  as the media part the user message refers to it by. A file is named by the
 *  conversation holding it, or while it is pending and not expired; admission
 *  binds it, deciding again in the same write. */
async function mediaOf(
  ops: TurnOperations,
  request: TurnRequest,
  conversation: string,
  isNew: boolean,
  expiredBefore: CelTimestamp,
  spec: ConversationSpec,
  ctx: InvokeContext,
): Promise<Array<Record<string, unknown>>> {
  if (request.attachments.length === 0) return [];
  const limit = spec.attachments?.maxPerMessage ?? 0;
  if (request.attachments.length > limit) {
    throw inputInvalid(`A message may carry at most ${limit} attachment(s).`, [
      { pointer: "/attachments", keyword: "maxItems", params: { limit } },
    ]);
  }
  const cutoff = millisOf(expiredBefore);
  const parts: Array<Record<string, unknown>> = [];
  for (const [index, id] of request.attachments.entries()) {
    const refuse = (why: string) =>
      inputInvalid(`Attachment '${id}' ${why}.`, [{ pointer: `/attachments/${index}` }]);
    if (!/^att_[0-9A-Za-z]{22}$/.test(id)) throw refuse("is not an attachment id");
    let record: { conversation: string | null; name: string | null; createdAt: CelTimestamp };
    let head: { size: unknown; contentType: string };
    try {
      record = await ops.readAttachment.invoke({ attachment: id }, ctx);
      const held = record.conversation;
      const nameable =
        held === null ? millisOf(record.createdAt) >= cutoff : !isNew && held === conversation;
      if (!nameable) throw attachmentRefused(id, index);
      head = await ops.blobHead.invoke({ key: attachmentKey(id) }, ctx);
    } catch (err) {
      if (isInvokeError(err) && (err.code === ERR_CONVERSATION_ATTACHMENT_NOT_FOUND || err.code === "ERR_BLOB_NOT_FOUND")) {
        throw attachmentRefused(id, index);
      }
      throw err;
    }
    const entry = offeredEntry(spec, head.contentType);
    if (!entry) throw refuse(`is ${head.contentType}, which the conversation no longer accepts`);
    const size = integerInput(head.size) ?? 0;
    if (size > entry.maxBytes) throw refuse(`is over the ${entry.maxBytes} bytes its type allows`);
    parts.push({
      type: entry.type,
      uri: `${ATTACHMENT_SCHEME}${id}`,
      mediaType: head.contentType,
      ...(record.name === null ? {} : { name: record.name }),
    });
  }
  return parts;
}

/** Everything a turn is admitted on, decided before its key is claimed. */
export async function planTurn(
  ops: TurnOperations,
  request: TurnRequest,
  conversation: string,
  isNew: boolean,
  expiredBefore: CelTimestamp,
  spec: ConversationSpec,
  ctx: InvokeContext,
): Promise<TurnPlan> {
  const media = await mediaOf(ops, request, conversation, isNew, expiredBefore, spec, ctx);
  const { parent, history } = await resolveParent(ops, request, conversation, isNew, ctx);
  const decisions = decisionsOf(request, history[history.length - 1]);
  return { parent, history, decisions, media, attachments: [...request.attachments] };
}

/** A turn request read from the invocable's inputs. A string parent without a
 *  conversation is refused before anything is read. */
export function turnRequestOf(inputs: Record<string, any>): TurnRequest {
  const request: TurnRequest = {
    ...(inputs.conversation === undefined ? {} : { conversation: inputs.conversation }),
    ...(Object.hasOwn(inputs, "parent") && inputs.parent !== undefined ? { parent: inputs.parent } : {}),
    message: inputs.message,
    attachments: inputs.attachments ?? [],
    ...(inputs.approvals === undefined ? {} : { approvals: inputs.approvals }),
  };
  if (typeof request.parent === "string" && request.conversation === undefined) {
    throw inputInvalid("A parent entry belongs to a conversation; name the conversation too.", [
      { pointer: "/parent" },
    ]);
  }
  return request;
}

export function versionOf(header: Record<string, unknown>): number {
  const version = integerInput(header.version);
  if (version === undefined) throw new InvokeError("ERR_CONTRACT_VIOLATION", "A conversation header carries no version.");
  return version;
}
