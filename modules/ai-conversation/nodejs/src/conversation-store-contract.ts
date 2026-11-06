import type { CelTimestamp, InvokeContext } from "@telorun/sdk";

/** A conversation's header. `title` is null until one is set; `turn` is the
 *  latest admitted turn id, null before the first. */
export interface ConversationHeader {
  readonly id: string;
  readonly title: string | null;
  readonly archived: boolean;
  readonly turn: string | null;
  readonly version: number;
  readonly createdAt: CelTimestamp;
  readonly updatedAt: CelTimestamp;
}

export interface Siblings {
  /** 1-based place among the entries sharing a parent, in append order. */
  readonly position: number;
  readonly count: number;
  readonly previous: string | null;
  readonly next: string | null;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly decidedAt: CelTimestamp;
  /** The turn that decided. */
  readonly turn: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly toolCallId: string;
  readonly requestedAt: CelTimestamp;
  /** Null while pending. */
  readonly decision: ApprovalDecision | null;
}

/** An entry as appended. */
export interface StoredEntry {
  readonly id: string;
  /** Null for a root. */
  readonly parent: string | null;
  /** Append sequence, unique within the conversation. */
  readonly sequence: number;
  /** A root is 1. */
  readonly depth: number;
  readonly turn: string;
  readonly createdAt: CelTimestamp;
  /** An `Ai.Message`. */
  readonly message: unknown;
  readonly siblings: Siblings;
}

/** An entry as a branch page reads it: its approvals folded in. */
export interface EntryRow extends StoredEntry {
  readonly approvals: readonly ApprovalRecord[];
}

export interface Page<T> {
  readonly rows: readonly T[];
  readonly total: number;
  /** Opaque; null on the last page. */
  readonly next: string | null;
}

export interface CreateRequest {
  readonly id: string;
  readonly title?: string;
}

export interface ListRequest {
  readonly query?: string;
  /** Absent lists archived and active conversations alike. */
  readonly archived?: boolean;
  /** `desc` lists the most recently updated first. */
  readonly direction: "asc" | "desc";
  readonly limit: number;
  readonly cursor?: string;
}

export interface EntriesRequest {
  readonly conversation: string;
  readonly through?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface AppendRequest {
  readonly conversation: string;
  readonly id: string;
  /** Null appends a root. */
  readonly parent: string | null;
  readonly turn: string;
  readonly message: unknown;
  /** Attachments bound to the conversation with the entry: each pending, or already this conversation's. */
  readonly attachments: readonly string[];
}

export interface UpdateRequest {
  readonly conversation: string;
  readonly version: number;
  readonly title?: string;
  readonly archived?: boolean;
}

export interface AdmitRequest {
  readonly conversation: string;
  readonly version: number;
  readonly turn: string;
  /** Bound with the admission: each pending and registered at or after `expiredBefore`, or already this conversation's. */
  readonly attachments: readonly string[];
  readonly expiredBefore: CelTimestamp;
}

/** An attachment's record. `conversation` and `boundAt` are null while it is pending. */
export interface AttachmentRecord {
  readonly id: string;
  readonly conversation: string | null;
  readonly name: string | null;
  readonly createdAt: CelTimestamp;
  readonly boundAt: CelTimestamp | null;
}

/** A turn a file is registered bound for: the file is its conversation's at once,
 *  provided the turn is the header's current one. */
export interface AttachmentBinding {
  readonly conversation: string;
  readonly turn: string;
}

export interface RegisterAttachmentRequest {
  readonly id: string;
  readonly name?: string;
  /** Absent registers the file pending. */
  readonly binding?: AttachmentBinding;
}

export interface ExpireAttachmentsRequest {
  /** Pending attachments registered before this are released. */
  readonly expiredBefore: CelTimestamp;
  readonly limit: number;
}

export interface RecordApprovalRequest {
  readonly conversation: string;
  readonly turn: string;
  readonly id: string;
  readonly entry: string;
  readonly toolCallId: string;
  readonly decision?: { readonly approved: boolean; readonly reason?: string };
}

/**
 * What a backend implements. Every method raises the contract's coded errors
 * (`conflict`, `notFound`, …) itself; an operation passes them through. A
 * store keeps no claim: `turn` is a fencing token. An attachment is pending
 * until the write that first makes a conversation refer to it binds it
 * (`admit`, `append`) — or bound from its registration, fenced on a turn — and
 * released by `delete` or by `expireAttachments`.
 */
export interface ConversationStore {
  create(request: CreateRequest, ctx?: InvokeContext): Promise<ConversationHeader>;
  read(conversation: string, ctx?: InvokeContext): Promise<ConversationHeader>;
  list(request: ListRequest, ctx?: InvokeContext): Promise<Page<ConversationHeader>>;
  update(request: UpdateRequest, ctx?: InvokeContext): Promise<ConversationHeader>;
  delete(conversation: string, ctx?: InvokeContext): Promise<void>;
  entries(request: EntriesRequest, ctx?: InvokeContext): Promise<Page<EntryRow>>;
  append(request: AppendRequest, ctx?: InvokeContext): Promise<StoredEntry>;
  recordApproval(request: RecordApprovalRequest, ctx?: InvokeContext): Promise<ApprovalRecord>;
  admit(request: AdmitRequest, ctx?: InvokeContext): Promise<ConversationHeader>;
  registerAttachment(request: RegisterAttachmentRequest, ctx?: InvokeContext): Promise<AttachmentRecord>;
  readAttachment(attachment: string, ctx?: InvokeContext): Promise<AttachmentRecord>;
  /** Releases up to `limit` expired pending attachments, then answers up to `limit` released ones. */
  expireAttachments(request: ExpireAttachmentsRequest, ctx?: InvokeContext): Promise<{ ids: string[] }>;
  /** Deletes the rows of released attachments; an id not released is left alone. */
  forgetAttachments(request: { readonly ids: readonly string[] }, ctx?: InvokeContext): Promise<void>;
}

const METHODS = [
  "create",
  "read",
  "list",
  "update",
  "delete",
  "entries",
  "append",
  "recordApproval",
  "admit",
  "registerAttachment",
  "readAttachment",
  "expireAttachments",
  "forgetAttachments",
] as const;

/** A store is recognised by its methods, never by having imported this module. */
export function isConversationStore(value: unknown): value is ConversationStore {
  return (
    typeof value === "object" &&
    value !== null &&
    METHODS.every((m) => typeof (value as Record<string, unknown>)[m] === "function")
  );
}
