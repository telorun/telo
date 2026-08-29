import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import { tokenCounts, withTokenQuantity } from "./usage.js";
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
  AiModelStreamInstance,
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
  model: AiModelStreamInstance;
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

  constructor(
    private readonly resource: AiAgentStreamResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(
    inputs: AiAgentStreamInputs = {},
    ctx?: InvokeContext,
  ): Promise<AiAgentStreamOutput> {
    const name = this.resource.metadata.name;
    const label = `Ai.AgentStream "${name}"`;
    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `${label}: 'model' is not a live Ai.ModelStream instance — check that Phase 5 injection ran.`,
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
    // Carried across turns, opaque throughout.
    let providerState: unknown;

    for (let step = 0; step < maxSteps; step++) {
      ctx?.cancellation.throwIfCancelled();

      const turnCalls: ToolCall[] = [];
      let turnText = "";
      const turn = await model.invoke(
        {
          messages,
          options,
          ...(tools.toolDefs.length > 0 ? { tools: tools.toolDefs } : {}),
          ...(providerState === undefined ? {} : { providerState }),
        },
        ctx,
      );
      for await (const part of turn.output) {
        if (part.type === "text-delta") {
          turnText += part.delta;
          yield part;
        } else if (part.type === "tool-call") {
          turnCalls.push(part.toolCall);
          yield part;
        } else if (part.type === "provider-state") {
          // Kept for the next turn rather than forwarded: it is the model's
          // bookkeeping, not the agent's output, and replaying it is what lets
          // reasoning survive the loop.
          providerState = part.providerState;
        } else if (part.type === "finish") {
          // Each TURN's finish is consumed; exactly one synthesized terminal
          // finish is emitted for the whole run, below.
          finishReason = part.finishReason;
          const turnUsage = tokenCounts(part.usage);
          usage.promptTokens += turnUsage.promptTokens;
          usage.completionTokens += turnUsage.completionTokens;
          usage.totalTokens += turnUsage.totalTokens;
        } else {
          // Anything else the vocabulary carries — reasoning deltas, completed
          // content parts — is the model's output and is forwarded verbatim.
          // A model FAILURE is not here at all: it rejects the iteration, and
          // that rejection propagates out of this generator to the caller.
          yield part;
        }
      }

      // No tools requested this turn — the model has answered. Emit the single
      // synthesized terminal finish with accumulated usage.
      if (turnCalls.length === 0) {
        const total = withTokenQuantity(usage);
        // Reported on the same terms as the buffered agent: the aggregate across
        // every turn, since a per-turn figure understates a run that looped.
        logCompletion(this.ctx.log, "Agent stream finished", total, finishReason, {
          "ai.agent.steps": step,
        });
        yield { type: "finish", usage: total, finishReason };
        return;
      }

      const normalized = normalizeToolCalls(turnCalls, step);
      messages.push({ role: "assistant", content: turnText, toolCalls: normalized });

      for (const call of normalized) {
        ctx?.cancellation.throwIfCancelled();
        // With onToolError: "throw", dispatch throws — and the throw PROPAGATES,
        // rejecting the iteration. It used to be converted into a terminal
        // `error` frame here, to keep the wire's one-terminal-frame contract;
        // that contract is now met by the encoder, which catches the rejection
        // and frames it. Rejecting is what makes this reachable from a manifest
        // at all: `catches:`, a throws union and a `try:` step all see a thrown
        // error, and none of them can see a data part.
        const record = await dispatchToolCall(call, tools.dispatch, onToolError, label);
        yield { type: "tool-result", toolResult: record };
        messages.push({ role: "tool", content: record.content, toolCallId: call.id });
      }
    }

    // maxSteps exhausted without the model converging. Thrown rather than
    // yielded, for the same reason a tool error is.
    if (onMaxSteps === "throw") {
      throw new InvokeError(
        "ERR_AGENT_MAX_STEPS",
        `${label}: did not converge within maxSteps=${maxSteps}.`,
      );
    }
    // `onMaxSteps: "return"` — handed back as an ordinary terminal finish, so
    // nothing in the stream marks that the agent ran out of steps rather than
    // converging. The buffered agent warns here for the same reason.
    const total = withTokenQuantity(usage);
    this.ctx.log.warn("Agent stream stopped at maxSteps without converging", {
      "ai.agent.max_steps": maxSteps,
      "gen_ai.usage.input_tokens": total.promptTokens,
      "gen_ai.usage.output_tokens": total.completionTokens,
    });
    yield { type: "finish", usage: total, finishReason };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: AiAgentStreamResource,
  ctx: ResourceContext,
): Promise<AiAgentStream> {
  return new AiAgentStream(resource, ctx);
}

