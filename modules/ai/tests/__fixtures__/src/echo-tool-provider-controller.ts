import type { ResourceInstance } from "@telorun/sdk";
import type { AiToolProviderInstance, ToolDescriptor } from "@telorun/ai";

/**
 * Internal Ai.ToolProvider test fixture: a provider whose tools are known only
 * to its instance, as a discovering provider's are. It advertises `advertises`
 * and answers each call with the tool's name and arguments.
 */
interface EchoToolProviderResource {
  metadata: { name: string; module?: string };
  advertises?: string[];
}

class EchoToolProvider implements ResourceInstance, AiToolProviderInstance {
  constructor(private readonly resource: EchoToolProviderResource) {}

  listTools(): ToolDescriptor[] {
    return (this.resource.advertises ?? []).map((name) => ({
      name,
      parameters: { type: "object" },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return { called: name, arguments: args };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: EchoToolProviderResource): Promise<EchoToolProvider> {
  return new EchoToolProvider(resource);
}
