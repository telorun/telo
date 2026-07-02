import type { InvokeContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
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
  AgentStreamPart,
  AiModelInstance,
  FinishReason,
  Message,
  ToolCall,
  Usage,
} from "./types.js";

/**
 * Ai.AgentStream — the streaming tool-use agent. Stands to Ai.Agent as Ai.TextStream
 * stands to Ai.Text: same tool-use loop, but it emits a `Stream<AgentStreamPart>` on
 * `result.output` instead of a buffered object, so the assistant's text and every tool
 * call surface as they happen.
 *
 * Tool assembly and dispatch are shared with Ai.Agent via `agent-tools.ts`, so the two
 * agents cannot drift on tool semantics. The loop runs lazily inside the returned
 * Stream — see `run()` for the per-turn finish handling and cancellation contract.
 */
interface AiAgentStreamResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
  maxSteps?: number;
  onMaxSteps?: "throw" | "return";
  onToolError?: "feedback" | "throw";
  toolProviders?: ToolProviderEntry[];
}

interface AiAgentStreamInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
}

interface AiAgentStreamOutput {
  output: Stream<AgentStreamPart>;
}

class AiAgentStream implements ResourceInstance<AiAgentStreamInputs, AiAgentStreamOutput> {
  private assembled?: AssembledTools;

  constructor(private readonly resource: AiAgentStreamResource) {}

  async invoke(
    inputs: AiAgentStreamInputs = {},
    ctx?: InvokeContext,
  ): Promise<AiAgentStreamOutput> {
    const name = this.resource.metadata.name;
    const label = `Ai.AgentStream "${name}"`;
    const model = this.resource.model;
    if (!model || typeof model.stream !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `${label}: 'model' is not a live Ai.Model instance with a stream() method — check that Phase 5 injection ran.`,
      );
    }

    const messages = buildInitialMessages(inputs, this.resource, label);
    const mergedOptions = mergeAgentOptions(this.resource, inputs);

    // Assemble tools eagerly so a collision / bad-reference error surfaces from
    // invoke() rather than mid-stream. Cached across invokes (list_changed deferred).
    if (!this.assembled) {
      this.assembled = await assembleTools(this.resource.toolProviders, label);
    }

    return { output: new Stream(this.runLoop(messages, mergedOptions, this.assembled, ctx)) };
  }

  /**
   * The multi-turn loop, run lazily as the Stream is consumed.
   *
   * Per-turn finish is consumed, not forwarded: each `model.stream()` turn yields its
   * own `finish`, whose `usage` accumulates and whose `finishReason` decides
   * continuation, but only one synthesized terminal `finish` is emitted. `text-delta`
   * and `tool-call` parts forward through; each executed tool emits a `tool-result`.
   *
   * Cancellation is active, not capture-once: because tools have real side effects and
   * run lazily as the consumer pulls, the signal is re-checked between turns and before
   * each dispatch, and forwarded to every `model.stream()`. An abandoned connection
   * stops the loop before the next model turn or tool execution.
   */
  private async *runLoop(
    messages: Message[],
    options: Record<string, unknown>,
    tools: AssembledTools,
    ctx?: InvokeContext,
  ): AsyncGenerator<AgentStreamPart> {
    const name = this.resource.metadata.name;
    const model = this.resource.model;
    const label = `Ai.AgentStream "${name}"`;
    const maxSteps = this.resource.maxSteps ?? 8;
    const onMaxSteps = this.resource.onMaxSteps ?? "throw";
    const onToolError = this.resource.onToolError ?? "feedback";

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: FinishReason = "stop";

    for (let step = 0; step < maxSteps; step++) {
      ctx?.cancellation.throwIfCancelled();

      const turnCalls: ToolCall[] = [];
      let turnText = "";
      for await (const part of model.stream({
        messages,
        options,
        signal: ctx?.cancellation.signal,
        ...(tools.toolDefs.length > 0 ? { tools: tools.toolDefs } : {}),
      })) {
        if (part.type === "text-delta") {
          turnText += part.delta;
          yield part;
        } else if (part.type === "tool-call") {
          turnCalls.push(part.toolCall);
          yield part;
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage.promptTokens += part.usage.promptTokens;
          usage.completionTokens += part.usage.completionTokens;
          usage.totalTokens += part.usage.totalTokens;
        } else {
          // Model-side error: forward as the terminal frame and stop the loop.
          yield part;
          return;
        }
      }

      // No tools requested this turn — the model has answered. Emit the single
      // synthesized terminal finish with accumulated usage.
      if (turnCalls.length === 0) {
        yield { type: "finish", usage, finishReason };
        return;
      }

      const normalized = normalizeToolCalls(turnCalls, step);
      messages.push({ role: "assistant", content: turnText, toolCalls: normalized });

      for (const call of normalized) {
        ctx?.cancellation.throwIfCancelled();
        // With onToolError: "throw", dispatch throws (an unknown tool or a tool's own
        // error). On the streaming path we convert that to a terminal `error` frame
        // rather than letting the exception escape the generator — otherwise the SSE
        // client sees a silently truncated stream (200 + frames already flushed, no
        // terminator), breaking the one-terminal-frame contract. Cancellation is
        // deliberately left to propagate above: the client is already gone.
        let record;
        try {
          record = await dispatchToolCall(call, tools.dispatch, onToolError, label);
        } catch (err) {
          const code = err instanceof InvokeError ? err.code : "ERR_AGENT_TOOL_ERROR";
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "error", error: { code, message } };
          return;
        }
        yield { type: "tool-result", toolResult: record };
        messages.push({ role: "tool", content: record.content, toolCallId: call.id });
      }
    }

    // maxSteps exhausted without the model converging.
    if (onMaxSteps === "throw") {
      yield {
        type: "error",
        error: {
          code: "ERR_AGENT_MAX_STEPS",
          message: `${label}: did not converge within maxSteps=${maxSteps}.`,
        },
      };
      return;
    }
    yield { type: "finish", usage, finishReason };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: AiAgentStreamResource): Promise<AiAgentStream> {
  return new AiAgentStream(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
