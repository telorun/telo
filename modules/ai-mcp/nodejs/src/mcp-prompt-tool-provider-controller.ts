import type { AiToolProviderInstance, ToolDescriptor } from "@telorun/ai";
import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { liveMcpClient, type McpClientInstance } from "./mcp-client-instance.js";
import { normalizeMcpContent } from "./mcp-content.js";
import { untilTurnCancelled } from "./turn-cancellation.js";

/**
 * AiMcp.PromptToolProvider — offers every prompt an MCP server lists to an agent as a
 * tool, over any Mcp.Client:
 *
 *   listTools() → prompts/list, every page (at most 100) → one tool per prompt, its
 *                 arguments as string parameters
 *   callTool()  → prompts/get              → every message's content block, in order
 *
 * Roles are dropped: a tool result has one author.
 */
/** Far past any prompt catalogue a model can take as tools; ends a server that hands
 *  out a fresh cursor on every page. */
const MAX_PROMPT_PAGES = 100;

interface McpPromptToolProviderResource {
  metadata: { name: string; module?: string };
  /** Live Mcp.Client instance after Phase 5 injection. */
  client: unknown;
}

interface PromptArgument {
  name: string;
  description?: unknown;
  required?: unknown;
}

interface Prompt {
  name: string;
  description?: unknown;
  arguments?: PromptArgument[];
}

class McpPromptToolProvider implements ResourceInstance, AiToolProviderInstance {
  private readonly label: string;

  constructor(
    private readonly resource: McpPromptToolProviderResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `AiMcp.PromptToolProvider "${resource.metadata.name}"`;
  }

  private client(): McpClientInstance {
    return liveMcpClient(this.resource.client, this.label);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const client = this.client();
    const tools: ToolDescriptor[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages === MAX_PROMPT_PAGES) {
        throw this.protocolError(`prompts/list did not end within ${MAX_PROMPT_PAGES} pages`);
      }
      pages++;
      const page = await client.invoke({
        method: "prompts/list",
        params: cursor === undefined ? {} : { cursor },
      });
      for (const prompt of this.promptsOf(page)) tools.push(toolOf(prompt));
      cursor = this.nextCursorOf(page);
      if (cursor !== undefined) {
        if (cursors.has(cursor)) {
          throw this.protocolError(`prompts/list returned the cursor "${cursor}" a second time`);
        }
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<unknown> {
    const call = this.client().invoke(
      { method: "prompts/get", params: { name, arguments: args } },
      invokeCtx,
    );
    const result = await untilTurnCancelled(call, invokeCtx, {
      subject: `${this.label}: MCP prompt "${name}"`,
      log: this.ctx.log,
      lateFailure: "AiMcp.PromptToolProvider's cancelled MCP prompt request failed after it was abandoned",
      attributes: { "mcp.prompt.name": name },
    });
    const messages = (result as { messages?: unknown } | null | undefined)?.messages;
    if (!Array.isArray(messages)) {
      throw this.protocolError(`prompts/get of "${name}" returned no 'messages' array`);
    }
    const blocks = messages.map((message, index) => {
      const content = (message as { content?: unknown } | null | undefined)?.content;
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        throw this.protocolError(
          `prompts/get of "${name}" returned message ${index} without a 'content' block`,
        );
      }
      return content;
    });
    return normalizeMcpContent(blocks);
  }

  private promptsOf(page: unknown): Prompt[] {
    const prompts = (page as { prompts?: unknown } | null | undefined)?.prompts;
    if (!Array.isArray(prompts)) {
      throw this.protocolError("prompts/list returned no 'prompts' array");
    }
    prompts.forEach((prompt, index) => {
      const p = prompt as { name?: unknown; arguments?: unknown } | null | undefined;
      if (typeof p?.name !== "string") {
        throw this.protocolError(`prompts/list returned prompt ${index} without a string 'name'`);
      }
      if (p.arguments === undefined) return;
      if (
        !Array.isArray(p.arguments) ||
        p.arguments.some((a) => typeof (a as { name?: unknown } | null)?.name !== "string")
      ) {
        throw this.protocolError(
          `prompts/list returned prompt "${p.name}" whose 'arguments' are not a list of named arguments`,
        );
      }
    });
    return prompts as Prompt[];
  }

  private nextCursorOf(page: unknown): string | undefined {
    const next = (page as { nextCursor?: unknown }).nextCursor;
    if (next === undefined || next === null) return undefined;
    if (typeof next !== "string") {
      throw this.protocolError("prompts/list returned a 'nextCursor' that is not a string");
    }
    return next;
  }

  private protocolError(problem: string): InvokeError {
    return new InvokeError("ERR_MCP_PROTOCOL", `${this.label}: ${problem}.`);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** A prompt as a tool: its arguments become string parameters, closed to any other. */
function toolOf(prompt: Prompt): ToolDescriptor {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const argument of prompt.arguments ?? []) {
    properties[argument.name] = {
      type: "string",
      ...(typeof argument.description === "string" ? { description: argument.description } : {}),
    };
    if (argument.required === true) required.push(argument.name);
  }
  return {
    name: prompt.name,
    ...(typeof prompt.description === "string" ? { description: prompt.description } : {}),
    parameters: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

export function register(): void {}

export async function create(
  resource: McpPromptToolProviderResource,
  ctx: ResourceContext,
): Promise<McpPromptToolProvider> {
  return new McpPromptToolProvider(resource, ctx);
}
