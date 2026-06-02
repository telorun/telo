import type { ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type {
  AiModelInstance,
  AiToolProviderInstance,
  CompletionResult,
  FinishReason,
  Message,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";

/**
 * Ai.Agent — the tool-use loop. Calls the model with the merged tool set; while the
 * model requests tools, dispatches each to its provider, replays the results, and loops
 * until the model finishes (no tool calls) or `maxSteps` is reached. Buffered only.
 *
 * The loop lives here (not in the provider) so it is provider-agnostic and observable —
 * every turn's calls + results land in the `steps` trace.
 */
interface ToolProviderEntry {
  /** Live Ai.ToolProvider instance after Phase 5 injection. */
  provider: AiToolProviderInstance;
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

interface AiAgentResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
  maxSteps?: number;
  onMaxSteps?: "throw" | "return";
  onToolError?: "feedback" | "throw";
  toolProviders?: ToolProviderEntry[];
}

interface AiAgentInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
}

interface StepTrace {
  text: string;
  toolCalls: ToolCall[];
  toolResults: Array<{ toolCallId: string; name: string; content: string; error?: boolean }>;
}

interface AiAgentOutput {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  steps: StepTrace[];
}

interface Dispatch {
  provider: AiToolProviderInstance;
  bareName: string;
}

class AiAgent implements ResourceInstance<AiAgentInputs, AiAgentOutput> {
  /** Tool set assembled lazily on first invoke and cached (list_changed refresh deferred). */
  private assembled?: { toolDefs: ToolDefinition[]; dispatch: Map<string, Dispatch> };

  constructor(private readonly resource: AiAgentResource) {}

  async invoke(inputs: AiAgentInputs = {}): Promise<AiAgentOutput> {
    const name = this.resource.metadata.name;
    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.Agent "${name}": 'model' is not a live Ai.Model instance — check that Phase 5 injection ran.`,
      );
    }

    const hasPrompt = typeof inputs.prompt === "string";
    const hasMessages = Array.isArray(inputs.messages);
    if (hasPrompt === hasMessages) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        hasPrompt
          ? `Ai.Agent "${name}": exactly one of 'prompt' or 'messages' may be provided, not both.`
          : `Ai.Agent "${name}": one of 'prompt' or 'messages' is required.`,
      );
    }

    const base: Message[] = hasMessages
      ? inputs.messages!
      : [{ role: "user", content: inputs.prompt! }];
    const systemText = inputs.system ?? this.resource.system;
    const messages: Message[] =
      systemText !== undefined
        ? base[0]?.role === "system"
          ? [{ role: "system", content: systemText }, ...base.slice(1)]
          : [{ role: "system", content: systemText }, ...base]
        : [...base];

    const mergedOptions: Record<string, unknown> = {
      ...(this.resource.options ?? {}),
      ...(inputs.options ?? {}),
    };

    const { toolDefs, dispatch } = await this.assembleTools();
    const maxSteps = this.resource.maxSteps ?? 8;
    const onMaxSteps = this.resource.onMaxSteps ?? "throw";
    const onToolError = this.resource.onToolError ?? "feedback";

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const steps: StepTrace[] = [];
    let last: CompletionResult | undefined;

    for (let step = 0; step < maxSteps; step++) {
      const result = await model.invoke({
        messages,
        options: mergedOptions,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      });
      last = result;
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.totalTokens += result.usage.totalTokens;

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) {
        return { text: result.text, usage, finishReason: result.finishReason, steps };
      }

      // Ensure every call has a stable id, threaded into the tool-result message so the
      // model can correlate result→call (providers require the match).
      const normalized: ToolCall[] = calls.map((c, i) => ({
        id: c.id || `call_${step}_${i}`,
        name: c.name,
        arguments: c.arguments ?? {},
      }));
      messages.push({ role: "assistant", content: result.text ?? "", toolCalls: normalized });

      const trace: StepTrace = { text: result.text ?? "", toolCalls: normalized, toolResults: [] };
      for (const call of normalized) {
        const content = await this.dispatchCall(call, dispatch, onToolError, trace);
        messages.push({ role: "tool", content, toolCallId: call.id });
      }
      steps.push(trace);
    }

    if (onMaxSteps === "throw") {
      throw new InvokeError(
        "ERR_AGENT_MAX_STEPS",
        `Ai.Agent "${name}": did not converge within maxSteps=${maxSteps}.`,
      );
    }
    return {
      text: last?.text ?? "",
      usage,
      finishReason: last?.finishReason ?? "tool-calls",
      steps,
    };
  }

  private async dispatchCall(
    call: ToolCall,
    dispatch: Map<string, Dispatch>,
    onToolError: "feedback" | "throw",
    trace: StepTrace,
  ): Promise<string> {
    const name = this.resource.metadata.name;
    const target = dispatch.get(call.name);
    if (!target) {
      if (onToolError === "throw") {
        throw new InvokeError(
          "ERR_AGENT_UNKNOWN_TOOL",
          `Ai.Agent "${name}": model requested unknown tool "${call.name}".`,
        );
      }
      const content = `Error: no such tool "${call.name}".`;
      trace.toolResults.push({ toolCallId: call.id, name: call.name, content, error: true });
      return content;
    }
    try {
      const output = await target.provider.callTool(target.bareName, call.arguments);
      const content = typeof output === "string" ? output : JSON.stringify(output);
      trace.toolResults.push({ toolCallId: call.id, name: call.name, content });
      return content;
    } catch (err) {
      if (onToolError === "throw") throw err;
      const message = err instanceof Error ? err.message : String(err);
      const content = `Error: ${message}`;
      trace.toolResults.push({ toolCallId: call.id, name: call.name, content, error: true });
      return content;
    }
  }

  private async assembleTools(): Promise<{
    toolDefs: ToolDefinition[];
    dispatch: Map<string, Dispatch>;
  }> {
    if (this.assembled) return this.assembled;
    const name = this.resource.metadata.name;
    const toolDefs: ToolDefinition[] = [];
    const dispatch = new Map<string, Dispatch>();

    for (const entry of this.resource.toolProviders ?? []) {
      const provider = entry.provider;
      if (
        !provider ||
        typeof provider.listTools !== "function" ||
        typeof provider.callTool !== "function"
      ) {
        throw new InvokeError(
          "ERR_INVALID_REFERENCE",
          `Ai.Agent "${name}": a toolProviders entry did not resolve to a live Ai.ToolProvider instance.`,
        );
      }
      const descriptors = await provider.listTools();
      for (const d of descriptors) {
        if (entry.include && !entry.include.includes(d.name)) continue;
        if (entry.exclude && entry.exclude.includes(d.name)) continue;
        const modelName = (entry.prefix ?? "") + d.name;
        if (dispatch.has(modelName)) {
          throw new InvokeError(
            "ERR_AGENT_TOOL_COLLISION",
            `Ai.Agent "${name}": duplicate tool name "${modelName}" across providers — set a 'prefix' to disambiguate.`,
          );
        }
        dispatch.set(modelName, { provider, bareName: d.name });
        toolDefs.push({ name: modelName, description: d.description, parameters: d.parameters });
      }
    }

    this.assembled = { toolDefs, dispatch };
    return this.assembled;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: AiAgentResource): Promise<AiAgent> {
  return new AiAgent(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
