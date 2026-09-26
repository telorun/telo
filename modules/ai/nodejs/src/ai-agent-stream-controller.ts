import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import { tokenCounts, withTokenQuantity } from "./usage.js";
import { InvokeError, Stream } from "@telorun/sdk";
import {
  assembleTools,
  buildInitialMessages,
  dispatchToolCall,
  mergeAgentOptions,
  normalizeToolCall,
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
 * Stream — see `runLoop()` for the part order and the cancellation contract.
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
  /** Opaque state a previous run's `provider-state` part carried, handed to the
   *  first model call so a conversation's reasoning continues across turns. */
  providerState?: unknown;
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

    return {
      output: new Stream(
        this.runLoop(messages, mergedOptions, this.assembled, inputs.providerState, ctx),
      ),
    };
  }

  /**
   * The multi-turn loop, run lazily as the Stream is consumed.
   *
   * Each model call's own `finish` becomes a `step-finish` carrying that call's
   * usage and finish reason, emitted when the call's stream ends and before its
   * tools run; the one terminal `finish` carries the usage of every call summed.
   * `text-delta`, `reasoning-delta`, `content-part` and `provider-state` parts
   * forward verbatim, a `tool-call` forwards with the id it keeps for the rest of
   * the run, and each executed tool emits a `tool-result`. Provider state is also
   * kept and replayed to the next call.
   *
   * Cancellation is re-checked after every part, between calls and before each
   * tool, and the invocation's context reaches every model call and every tool —
   * so a cancelled turn ends with `ERR_INVOKE_CANCELLED`. A call interrupted
   * before its `finish` reports no `step-finish`; one whose `finish` arrived still
   * reports it, even when the cancellation lands before that part is handled.
   */
  private async *runLoop(
    messages: Message[],
    options: Record<string, unknown>,
    tools: AssembledTools,
    initialProviderState: unknown,
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
    // Carried across calls, opaque throughout.
    let providerState: unknown = initialProviderState;

    for (let step = 0; step < maxSteps; step++) {
      ctx?.cancellation.throwIfCancelled();

      const turnCalls: ToolCall[] = [];
      let turnText = "";
      let turnFinish: { usage: Usage; finishReason: FinishReason } | undefined;
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
        // A `finish` is recorded whatever the cancellation state: the call it
        // closes completed and was billed, so its usage must still be reported.
        if (part.type === "finish") {
          turnFinish = { usage: tokenCounts(part.usage), finishReason: part.finishReason };
          continue;
        }
        ctx?.cancellation.throwIfCancelled();
        if (part.type === "text-delta") {
          turnText += part.delta;
          yield part;
        } else if (part.type === "tool-call") {
          const call = normalizeToolCall(part.toolCall);
          turnCalls.push(call);
          yield { type: "tool-call", toolCall: call };
        } else if (part.type === "provider-state") {
          // Forwarded so a caller can keep it for its next run, and kept for the
          // next call, which is what lets reasoning survive the loop.
          providerState = part.providerState;
          yield part;
        } else {
          // Anything else the vocabulary carries — reasoning deltas, completed
          // content parts — is the model's output and is forwarded verbatim.
          // A model FAILURE is not here at all: it rejects the iteration, and
          // that rejection propagates out of this generator to the caller.
          yield part;
        }
      }
      if (!turnFinish) {
        // Interrupted before its finish: the call reports no step-finish.
        ctx?.cancellation.throwIfCancelled();
        throw new InvokeError(
          "ERR_CONTRACT_VIOLATION",
          `${label}: the model's stream ended without a 'finish' part, which every Ai.ModelStream call must end with.`,
        );
      }

      finishReason = turnFinish.finishReason;
      usage.promptTokens += turnFinish.usage.promptTokens;
      usage.completionTokens += turnFinish.usage.completionTokens;
      usage.totalTokens += turnFinish.usage.totalTokens;
      yield {
        type: "step-finish",
        usage: withTokenQuantity(turnFinish.usage),
        finishReason: turnFinish.finishReason,
      };
      ctx?.cancellation.throwIfCancelled();

      // No tools requested this call — the model has answered.
      if (turnCalls.length === 0) {
        const total = withTokenQuantity(usage);
        // Reported on the same terms as the buffered agent: the aggregate across
        // every call, since a per-call figure understates a run that looped.
        logCompletion(this.ctx.log, "Agent stream finished", total, finishReason, {
          "ai.agent.steps": step,
        });
        yield { type: "finish", usage: total, finishReason };
        return;
      }

      messages.push({ role: "assistant", content: turnText, toolCalls: turnCalls });

      for (const call of turnCalls) {
        ctx?.cancellation.throwIfCancelled();
        // With onToolError: "throw", dispatch throws — and the throw PROPAGATES,
        // rejecting the iteration, so `catches:`, a throws union and a `try:`
        // step all see it; none of them could see a data part.
        const record = await dispatchToolCall(call, tools.dispatch, onToolError, label, ctx);
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

