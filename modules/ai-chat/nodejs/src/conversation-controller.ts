import {
  InvokeError,
  durationNanos,
  integerInput,
  isCelDuration,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { conversationSpec, type ConversationSpec } from "./conversation-spec.js";

/** The schema's `default:` values, which never reach a controller; the module's
 *  unit test holds these to the manifest. */
export const DEFAULT_ATTACHMENT_BOUNDS = { maxBytes: 10485760, maxPerMessage: 4 } as const;

/** How long an upload no message has sent is kept when `pendingRetention` is
 *  omitted; a duration has no schema `default:`, since the kernel would not decode it. */
export const DEFAULT_PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;

const NANOS_PER_MILLISECOND = 1_000_000n;

interface ConversationResource {
  metadata: { name: string; module?: string };
  agent?: unknown;
  attachments?: { maxBytes?: unknown; maxPerMessage?: unknown; pendingRetention?: unknown };
}

/** What the endpoint's own operations read beside the spec it provides. */
export interface ChatEndpoint {
  provide(): Promise<ConversationSpec>;
  /** How long an upload no message has sent is kept, in milliseconds. */
  pendingRetentionMs(): number;
}

export const isChatEndpoint = (candidate: unknown): candidate is ChatEndpoint =>
  typeof (candidate as ChatEndpoint | null)?.provide === "function" &&
  typeof (candidate as ChatEndpoint | null)?.pendingRetentionMs === "function";

/** The controller twin of the `AI_CHAT_PENDING_RETENTION_NOT_POSITIVE` rule. */
function pendingRetentionOf(written: unknown, label: string): number {
  if (written === undefined || written === null) return DEFAULT_PENDING_RETENTION_MS;
  if (!isCelDuration(written)) {
    throw new InvokeError("ERR_INVALID_VALUE", `${label}: 'attachments.pendingRetention' must be a duration.`);
  }
  const nanos = durationNanos(written);
  if (nanos <= 0n) {
    throw new InvokeError(
      "ERR_AI_CHAT_PENDING_RETENTION_NOT_POSITIVE",
      `${label} sets 'attachments.pendingRetention' to zero or less, so every upload would expire before a message could send it.`,
    );
  }
  return Number(nanos / NANOS_PER_MILLISECOND);
}

interface PublishingInstance {
  snapshot(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

const isPublishing = (candidate: unknown): candidate is PublishingInstance =>
  typeof (candidate as PublishingInstance | null)?.snapshot === "function";

/**
 * AiChat.Conversation — publishes the `Conversation.Spec` of a chat endpoint over
 * an agent, and holds the retention of uploads no message has sent. The other
 * slots (store, journal, blobs, detector) are read by the operations through
 * the template crossing rule; this controller dispatches nothing.
 */
class ChatConversation implements ResourceInstance, ChatEndpoint {
  private spec?: ConversationSpec;
  private readonly retentionMs: number;

  constructor(
    private readonly resource: ConversationResource,
    private readonly label: string,
  ) {
    this.retentionMs = pendingRetentionOf(resource.attachments?.pendingRetention, label);
  }

  pendingRetentionMs(): number {
    return this.retentionMs;
  }

  async init(ctx: ResourceContext): Promise<void> {
    const agent = ctx.resolveRef(this.resource.agent, isPublishing, () => `${this.label}: 'agent'`, "Ai.AgentStream");
    const accepts = (await agent.snapshot()).accepts;
    if (!Array.isArray(accepts)) {
      throw new InvokeError(
        "ERR_REF_UNRESOLVED",
        `${this.label}: 'agent' publishes no 'accepts' list. Point it at an Ai.AgentStream.`,
      );
    }
    const bound = (field: "maxBytes" | "maxPerMessage"): number => {
      const written = this.resource.attachments?.[field];
      if (written === undefined || written === null) return DEFAULT_ATTACHMENT_BOUNDS[field];
      const value = integerInput(written);
      if (value === undefined || value < 1) {
        throw new InvokeError("ERR_INVALID_VALUE", `${this.label}: 'attachments.${field}' must be a positive integer.`);
      }
      return value;
    };
    const maxBytes = bound("maxBytes");
    const maxPerMessage = bound("maxPerMessage");
    this.spec = conversationSpec(accepts, { maxBytes, maxPerMessage });
  }

  private offered(): ConversationSpec {
    if (!this.spec) throw new Error(`${this.label} was read before it was initialized.`);
    return this.spec;
  }

  async provide(): Promise<ConversationSpec> {
    return this.offered();
  }

  snapshot(): Record<string, unknown> {
    return { ...this.offered() };
  }
}

export function register(): void {}

export async function create(resource: ConversationResource): Promise<ChatConversation> {
  return new ChatConversation(resource, `AiChat.Conversation "${resource.metadata.name}"`);
}
