import type { InvokeContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { MessageContent } from "./content.js";
import {
  assembleTools,
  buildInitialMessages,
  dispatchToolCall,
  mergeAgentOptions,
  normalizeToolCalls,
  type AssembledTools,
  type ToolProviderEntry,
} from "./agent-tools.js";
import type {
  AiModelInstance,
  CompletionResult,
  FinishReason,
  Message,
  ToolCall,
  Usage,
} from "./types.js";

/**
 * Ai.Agent — the tool-use loop. Calls the model with the merged tool set; while the
 * model requests tools, dispatches each to its provider, replays the results, and loops
 * until the model finishes (no tool calls) or `maxSteps` is reached. Buffered only.
 *
 * The loop lives here (not in the provider) so it is provider-agnostic and observable —
 * every turn's calls + results land in the `steps` trace. Tool assembly and dispatch
 * are shared with Ai.AgentStream via `agent-tools.ts`.
 */
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
  toolResults: Array<{
    toolCallId: string;
    name: string;
    content: MessageContent;
    error?: boolean;
  }>;
}

interface AiAgentOutput {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  steps: StepTrace[];
}

class AiAgent implements ResourceInstance<AiAgentInputs, AiAgentOutput> {
  /** Tool set assembled lazily on first invoke and cached (list_changed refresh deferred). */
  private assembled?: AssembledTools;

  constructor(private readonly resource: AiAgentResource) {}

  async invoke(inputs: AiAgentInputs = {}, ctx?: InvokeContext): Promise<AiAgentOutput> {
    const name = this.resource.metadata.name;
    const label = `Ai.Agent "${name}"`;
    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `${label}: 'model' is not a live Ai.Model instance — check that Phase 5 injection ran.`,
      );
    }

    const messages = buildInitialMessages(inputs, this.resource, label);
    const mergedOptions = mergeAgentOptions(this.resource, inputs);

    const { toolDefs, dispatch } = await this.tools();
    const maxSteps = this.resource.maxSteps ?? 8;
    const onMaxSteps = this.resource.onMaxSteps ?? "throw";
    const onToolError = this.resource.onToolError ?? "feedback";

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const steps: StepTrace[] = [];
    let last: CompletionResult | undefined;

    for (let step = 0; step < maxSteps; step++) {
      ctx?.cancellation.throwIfCancelled();
      const result = await model.invoke({
        messages,
        options: mergedOptions,
        signal: ctx?.cancellation.signal,
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

      const normalized = normalizeToolCalls(calls, step);
      messages.push({ role: "assistant", content: result.text ?? "", toolCalls: normalized });

      const trace: StepTrace = { text: result.text ?? "", toolCalls: normalized, toolResults: [] };
      for (const call of normalized) {
        const record = await dispatchToolCall(call, dispatch, onToolError, label);
        trace.toolResults.push(record);
        messages.push({ role: "tool", content: record.content, toolCallId: call.id });
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

  /** Assemble the tool set lazily on first invoke and cache it (list_changed refresh
   *  deferred). Delegates to the shared unit so both agents assemble identically. */
  private async tools(): Promise<AssembledTools> {
    if (!this.assembled) {
      this.assembled = await assembleTools(this.resource.toolProviders, `Ai.Agent "${this.resource.metadata.name}"`);
    }
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

