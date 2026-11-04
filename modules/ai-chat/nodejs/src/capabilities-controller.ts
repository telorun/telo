import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isProviding, type ConversationSpec } from "./conversation-spec.js";

interface CapabilitiesResource {
  metadata: { name: string; module?: string };
  conversation?: unknown;
}

/** AiChat.Capabilities — answers, and publishes as its reading, what the
 *  conversation offers. */
class Capabilities implements ResourceInstance {
  private spec?: ConversationSpec;

  constructor(private readonly resource: CapabilitiesResource) {}

  async init(ctx: ResourceContext): Promise<void> {
    const conversation = ctx.resolveRef(
      this.resource.conversation,
      isProviding,
      () => `AiChat.Capabilities "${this.resource.metadata.name}": 'conversation'`,
      "AiChat.Conversation",
    );
    this.spec = (await conversation.provide()) as ConversationSpec;
  }

  async invoke(): Promise<ConversationSpec> {
    return this.spec!;
  }

  snapshot(): Record<string, unknown> {
    return { ...this.spec };
  }
}

export function register(): void {}

export async function create(resource: CapabilitiesResource): Promise<Capabilities> {
  return new Capabilities(resource);
}
