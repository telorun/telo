import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";

/** What an endpoint offers before any event arrives, as `Conversation.Spec` says. */
export interface ConversationSpec {
  attachments?: {
    accepts: { type: string; mediaTypes: string[]; maxBytes: number }[];
    maxPerMessage: number;
  };
  operations: string[];
}

export interface ConversationSourceInstance {
  readonly basePath: string;
  spec(): Promise<ConversationSpec>;
}

export function isConversationSource(candidate: unknown): candidate is ConversationSourceInstance {
  const source = candidate as ConversationSourceInstance | null;
  return typeof source?.basePath === "string" && typeof source.spec === "function";
}

interface ProvidingInstance {
  provide(): Promise<unknown> | unknown;
}

const isProviding = (candidate: unknown): candidate is ProvidingInstance =>
  typeof (candidate as ProvidingInstance | null)?.provide === "function";

type ConversationSourceResource = RuntimeResource & { conversation: unknown; basePath: string };

type Reading = {
  attachments?: { accepts?: { type: string; mediaTypes: string[]; maxBytes: number | bigint }[]; maxPerMessage?: number | bigint } | null;
  operations?: string[];
};

class ConversationSource implements ResourceInstance, ConversationSourceInstance {
  readonly basePath: string;
  private offered?: ConversationSpec;

  constructor(
    private readonly resource: ConversationSourceResource,
    private readonly ctx: ResourceContext,
  ) {
    this.basePath = resource.basePath;
  }

  async spec(): Promise<ConversationSpec> {
    if (this.offered) return this.offered;
    const owner = `Ui.ConversationSource '${this.resource.metadata.name}'`;
    const instance = this.ctx.resolveRef(
      this.resource.conversation,
      isProviding,
      () => `'conversation' of ${owner}`,
      "Conversation.Conversation",
    );
    const reading = (await instance.provide()) as Reading | null;
    if (!Array.isArray(reading?.operations)) {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `${owner}: 'conversation' publishes no operations. Point it at a conversation endpoint.`,
      );
    }
    const offer = reading.attachments;
    return (this.offered = {
      ...(offer
        ? {
            attachments: {
              accepts: (offer.accepts ?? []).map((entry) => ({
                type: entry.type,
                mediaTypes: entry.mediaTypes,
                maxBytes: Number(entry.maxBytes),
              })),
              maxPerMessage: Number(offer.maxPerMessage),
            },
          }
        : {}),
      operations: reading.operations,
    });
  }

  async init(): Promise<void> {
    await this.spec();
  }

  snapshot(): Record<string, unknown> {
    return { basePath: this.basePath };
  }
}

export async function create(resource: ConversationSourceResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new ConversationSource(resource, ctx);
}
