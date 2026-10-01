import type { ControllerContext, InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { getRefIdentity, InvokeError } from "@telorun/sdk";
import type { AiToolProviderInstance, ToolDescriptor } from "./types.js";

/**
 * Ai.Tools — the built-in Ai.ToolProvider implementation: a static list of tools, each
 * wrapping any Telo.Invocable. `listTools()` returns the declared descriptors;
 * `callTool()` dispatches to the matching invocable, applying optional `inputs:`/`result:`
 * CEL mappings (evaluated per call via `ctx.expandValue`); `inputs:` reads the model's
 * `arguments` and the agent's caller data as `context`.
 *
 * Each call goes through the kernel's traced dispatch, as a route handler does, so
 * the tool resource's own span, its `<name>.Invoked` events and its declared span
 * attributes exist — nested under the agent's `execute_tool` span, whose context
 * rides in, so cancelling the turn stops the tool too.
 */
interface InvocableInstance {
  invoke(input: unknown, ctx?: InvokeContext): Promise<unknown>;
}

interface ToolEntry {
  /** Live Telo.Invocable instance after Phase 5 injection ({kind,name} before it). */
  tool: InvocableInstance;
  name?: string;
  description?: string;
  parameters: Record<string, unknown>;
  /** Raw CEL template mapping model `arguments` and caller `context` → the
   *  invocable's input. */
  inputs?: Record<string, unknown>;
  /** Raw CEL template shaping the invocable's `result` into the fed-back value:
   *  a string, or a content part / list of parts for a multimodal result. */
  result?: string | Record<string, unknown> | unknown[];
}

interface AiToolsResource {
  metadata: { name: string; module?: string };
  tools: ToolEntry[];
}

class AiTools implements ResourceInstance, AiToolProviderInstance {
  /** Each tool's referenced resource, captured before injection so `name` can
   *  default to it and the dispatch can name its target. */
  private readonly refs: Array<{ kind?: string; name?: string }>;

  constructor(
    private readonly resource: AiToolsResource,
    private readonly ctx: ResourceContext,
  ) {
    this.refs = resource.tools.map((t) => {
      const ref = t.tool as unknown;
      if (!ref || typeof ref !== "object") return {};
      const { kind, name } = ref as { kind?: unknown; name?: unknown };
      return {
        kind: typeof kind === "string" ? kind : undefined,
        name: typeof name === "string" ? name : undefined,
      };
    });
  }

  private toolName(entry: ToolEntry, index: number): string | undefined {
    return entry.name ?? this.refs[index]?.name;
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    context?: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.callToolWithOutput(name, args, invokeCtx, context)).result;
  }

  async callToolWithOutput(
    name: string,
    args: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    context: Record<string, unknown> = {},
  ): Promise<{ output: unknown; result: unknown }> {
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
    // The identity the kernel stamped at injection names the dispatch; the ref
    // captured before injection is the fallback for a slot injection did not reach.
    const identity = getRefIdentity(tool as object);
    const kind = identity?.kind ?? this.refs[index]?.kind ?? "";
    const target = identity?.name ?? this.refs[index]?.name ?? name;
    const invokeInput =
      entry.inputs !== undefined
        ? this.ctx.expandValue(entry.inputs, { arguments: args, context })
        : args;
    const output = await this.ctx.invokeResolved(
      kind,
      target,
      tool as unknown as ResourceInstance,
      invokeInput,
      invokeCtx,
    );
    const result =
      entry.result !== undefined ? this.ctx.expandValue(entry.result, { result: output }) : output;
    return { output, result };
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

