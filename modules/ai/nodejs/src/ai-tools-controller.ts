import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { AiToolProviderInstance, ToolDescriptor } from "./types.js";

/**
 * Ai.Tools — the built-in Ai.ToolProvider implementation: a static list of tools, each
 * wrapping any Telo.Invocable. `listTools()` returns the declared descriptors;
 * `callTool()` dispatches to the matching invocable, applying optional `inputs:`/`result:`
 * CEL mappings (evaluated per call via `ctx.expandValue`).
 */
interface InvocableInstance {
  invoke(input: unknown): Promise<unknown>;
}

interface ToolEntry {
  /** Live Telo.Invocable instance after Phase 5 injection ({kind,name} before it). */
  tool: InvocableInstance;
  name?: string;
  description?: string;
  parameters: Record<string, unknown>;
  /** Raw CEL template mapping model `arguments` → the invocable's input. */
  inputs?: Record<string, unknown>;
  /** Raw CEL template shaping the invocable's `result` into the fed-back value. */
  result?: string;
}

interface AiToolsResource {
  metadata: { name: string; module?: string };
  tools: ToolEntry[];
}

class AiTools implements ResourceInstance, AiToolProviderInstance {
  /** Each tool's referenced resource name, captured before injection so `name` can
   *  default to it. */
  private readonly refNames: Array<string | undefined>;

  constructor(
    private readonly resource: AiToolsResource,
    private readonly ctx: ResourceContext,
  ) {
    this.refNames = resource.tools.map((t) => {
      const ref = t.tool as unknown;
      return ref && typeof ref === "object" && typeof (ref as { name?: unknown }).name === "string"
        ? ((ref as { name: string }).name)
        : undefined;
    });
  }

  private toolName(entry: ToolEntry, index: number): string | undefined {
    return entry.name ?? this.refNames[index];
  }

  listTools(): ToolDescriptor[] {
    return this.resource.tools.map((entry, i) => {
      const name = this.toolName(entry, i);
      if (!name) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.Tools "${this.resource.metadata.name}": tool at index ${i} has no 'name' and the referenced resource name could not be determined.`,
        );
      }
      return { name, description: entry.description, parameters: entry.parameters };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const index = this.resource.tools.findIndex((entry, i) => this.toolName(entry, i) === name);
    if (index === -1) {
      throw new InvokeError(
        "ERR_AGENT_UNKNOWN_TOOL",
        `Ai.Tools "${this.resource.metadata.name}": no tool named "${name}".`,
      );
    }
    const entry = this.resource.tools[index]!;
    const tool = entry.tool;
    if (!tool || typeof tool.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.Tools "${this.resource.metadata.name}": tool "${name}" did not resolve to a live invocable instance — check Phase 5 injection.`,
      );
    }
    const invokeInput =
      entry.inputs !== undefined ? this.ctx.expandValue(entry.inputs, { arguments: args }) : args;
    const output = await tool.invoke(invokeInput);
    return entry.result !== undefined ? this.ctx.expandValue(entry.result, { result: output }) : output;
  }

  snapshot(): Record<string, unknown> {
    return {
      tools: this.resource.tools.map((entry, i) => ({
        name: this.toolName(entry, i),
        description: entry.description,
      })),
    };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: AiToolsResource, ctx: ResourceContext): Promise<AiTools> {
  return new AiTools(resource, ctx);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
