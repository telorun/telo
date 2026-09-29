import type { InvokeContext, OpenSpan, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import { tokenCounts, withTokenQuantity } from "./usage.js";
import {
  chatAttributes,
  modelNameOf,
  openAgentSpan,
  openChatSpan,
  settleFailure,
  usageAttributes,
  type AgentSpanIdentity,
} from "./agent-spans.js";
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
import { toolResultByteLimit } from "./tool-result-bound.js";
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
  maxToolResultBytes?: number | bigint;
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

/** Why a span ends when the stream's consumer stops reading before the run does. */
const ABANDONED = "the stream's consumer stopped reading";

class AiAgentStream implements ResourceInstance<AiAgentStreamInputs, AiAgentStreamOutput> {
  private assembled?: AssembledTools;

  private readonly maxToolResultBytes: number | undefined;

  constructor(
    private readonly resource: AiAgentStreamResource,
    private readonly ctx: ResourceContext,
  ) {
    this.maxToolResultBytes = toolResultByteLimit(
      resource.maxToolResultBytes,
      `Ai.AgentStream "${resource.metadata.name}"`,
    );
  }

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
   *
   * The run is one `invoke_agent` span; each model call a `chat` span, open until
   * its stream ends; each tool call an `execute_tool` span. A consumer that stops
   * reading ends every open span as cancelled.
   */
  private async *runLoop(
    messages: Message[],
    options: Record<string, unknown>,
    tools: AssembledTools,
    initialProviderState: unknown,
    ctx?: InvokeContext,
  ): AsyncGenerator<AgentStreamPart> {
    const name = this.resource.metadata.name;
    const label = `Ai.AgentStream "${name}"`;
    const maxSteps = this.resource.maxSteps ?? 8;
    const onMaxSteps = this.resource.onMaxSteps ?? "throw";
    const onToolError = this.resource.onToolError ?? "feedback";
    const agent: AgentSpanIdentity = { kind: "Ai.AgentStream", name };
    const modelName = modelNameOf(this.resource.model);

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: FinishReason = "stop";
    // Carried across calls, opaque throughout.
    let providerState: unknown = initialProviderState;
    let calls = 0;
    const runAttributes = () => ({ "ai.agent.steps": calls, ...usageAttributes(usage) });

    const agentSpan = await openAgentSpan(this.ctx, ctx, agent);
    try {
      for (let step = 0; step < maxSteps; step++) {
        ctx?.cancellation.throwIfCancelled();

        calls += 1;
        const turn = yield* this.modelCall(
          { messages, options, tools, providerState },
          { agentSpan, agent, modelName, label },
          ctx,
        );
        if (turn.providerState !== undefined) providerState = turn.providerState;

        finishReason = turn.finish.finishReason;
        usage.promptTokens += turn.finish.usage.promptTokens;
        usage.completionTokens += turn.finish.usage.completionTokens;
        usage.totalTokens += turn.finish.usage.totalTokens;
        yield {
          type: "step-finish",
          usage: withTokenQuantity(turn.finish.usage),
          finishReason: turn.finish.finishReason,
        };
        ctx?.cancellation.throwIfCancelled();

        // No tools requested this call — the model has answered.
        if (turn.toolCalls.length === 0) {
          const total = withTokenQuantity(usage);
          // Reported on the same terms as the buffered agent: the aggregate across
          // every call, since a per-call figure understates a run that looped.
          logCompletion(this.ctx.log, "Agent stream finished", total, finishReason, {
            "ai.agent.steps": calls,
          });
          await agentSpan.settle("ok", { attributes: runAttributes() });
          yield { type: "finish", usage: total, finishReason };
          return;
        }

        messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

        for (const call of turn.toolCalls) {
          ctx?.cancellation.throwIfCancelled();
          // With onToolError: "throw", dispatch throws — and the throw PROPAGATES,
          // rejecting the iteration, so `catches:`, a throws union and a `try:`
          // step all see it; none of them could see a data part.
          const record = await dispatchToolCall(
            call,
            tools.dispatch,
            onToolError,
            this.maxToolResultBytes,
            label,
            this.ctx,
            agent,
            agentSpan.context,
          );
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
      await agentSpan.settle("ok", { attributes: runAttributes() });
      yield { type: "finish", usage: total, finishReason };
    } catch (err) {
      await settleFailure(agentSpan, err, runAttributes());
      throw err;
    } finally {
      // Reached unsettled only when the consumer stopped reading mid-run.
      await agentSpan.settle("cancelled", {
        attributes: { ...runAttributes(), "telo.cancellation.reason": ABANDONED },
      });
    }
  }

  /**
   * One model call, under its `chat` span: forwards the call's parts and returns
   * what the loop needs of it. The span stays open until the call's stream ends.
   */
  private async *modelCall(
    request: {
      messages: Message[];
      options: Record<string, unknown>;
      tools: AssembledTools;
      providerState: unknown;
    },
    spans: { agentSpan: OpenSpan; agent: AgentSpanIdentity; modelName: string; label: string },
    ctx?: InvokeContext,
  ): AsyncGenerator<
    AgentStreamPart,
    {
      toolCalls: ToolCall[];
      text: string;
      finish: { usage: Usage; finishReason: FinishReason };
      providerState: unknown;
    }
  > {
    const chatSpan = await openChatSpan(this.ctx, spans.agentSpan, spans.agent, spans.modelName);
    const toolCalls: ToolCall[] = [];
    let text = "";
    let finish: { usage: Usage; finishReason: FinishReason } | undefined;
    let providerState: unknown;
    try {
      const turn = await this.resource.model.invoke(
        {
          messages: request.messages,
          options: request.options,
          ...(request.tools.toolDefs.length > 0 ? { tools: request.tools.toolDefs } : {}),
          ...(request.providerState === undefined ? {} : { providerState: request.providerState }),
        },
        chatSpan.context,
      );
      for await (const part of turn.output) {
        // A `finish` is recorded whatever the cancellation state: the call it
        // closes completed and was billed, so its usage must still be reported.
        if (part.type === "finish") {
          finish = { usage: tokenCounts(part.usage), finishReason: part.finishReason };
          continue;
        }
        ctx?.cancellation.throwIfCancelled();
        if (part.type === "text-delta") {
          text += part.delta;
          yield part;
        } else if (part.type === "tool-call") {
          const call = normalizeToolCall(part.toolCall);
          toolCalls.push(call);
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
      if (!finish) {
        // Interrupted before its finish: the call reports no step-finish.
        ctx?.cancellation.throwIfCancelled();
        throw new InvokeError(
          "ERR_CONTRACT_VIOLATION",
          `${spans.label}: the model's stream ended without a 'finish' part, which every Ai.ModelStream call must end with.`,
        );
      }
      await chatSpan.settle("ok", {
        attributes: chatAttributes(finish.usage, finish.finishReason),
      });
      return { toolCalls, text, finish, providerState };
    } catch (err) {
      await settleFailure(chatSpan, err);
      throw err;
    } finally {
      // Reached unsettled only when the consumer stopped reading mid-call.
      await chatSpan.settle("cancelled", { attributes: { "telo.cancellation.reason": ABANDONED } });
    }
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

