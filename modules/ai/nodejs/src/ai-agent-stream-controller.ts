import type { InvokeContext, OpenSpan, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import { addUsage, tokenCounts, withTokenQuantity } from "./usage.js";
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
  assertUniqueCallId,
  buildInitialMessages,
  checkApprovalNames,
  mergeAgentOptions,
  normalizeToolCall,
  type AssembledTools,
  type ToolProviderEntry,
} from "./agent-tools.js";
import { Conversation, pendingWork, type PendingWork } from "./conversation.js";
import {
  conclusionRequest,
  MAX_STEPS_LIMIT,
  stepBudget,
  type StepBudget,
  type StepBudgetConfig,
} from "./step-budget.js";
import {
  Approver,
  settleToolCalls,
  type ApproverConfig,
  type ToolSettlement,
} from "./tool-approval.js";
import { parallelToolLimit } from "./tool-concurrency.js";
import { toolResultByteLimit } from "./tool-result-bound.js";
import {
  APPROVAL_INTERRUPT,
  type AgentStreamPart,
  type AiModelStreamInstance,
  type FinishReason,
  type Message,
  type ModelInvokeInput,
  type StreamPart,
  type ToolApproval,
  type ToolCall,
  type Usage,
} from "./types.js";

/**
 * Ai.AgentStream — the streaming tool-use agent. Stands to Ai.Agent as Ai.TextStream
 * stands to Ai.Text: same tool-use loop, but it emits a `Stream<AgentStreamPart>` on
 * `result.output` instead of a buffered object, so the assistant's text and every tool
 * call surface as they happen.
 *
 * Tool assembly and dispatch are shared with Ai.Agent via `agent-tools.ts`, the
 * settling of a turn's calls via `tool-approval.ts` and the record of the run via
 * `conversation.ts`, so the two agents cannot drift on tool semantics. The loop
 * runs lazily inside the returned Stream — see `runLoop()` for the part order and
 * the cancellation contract.
 */
interface AiAgentStreamResource extends StepBudgetConfig {
  metadata: { name: string; module?: string };
  model: AiModelStreamInstance;
  system?: string;
  options?: Record<string, unknown>;
  onToolError?: "feedback" | "throw";
  maxToolResultBytes?: number | bigint;
  maxParallelTools?: number | bigint;
  toolProviders?: ToolProviderEntry[];
  approver?: ApproverConfig;
}

interface AiAgentStreamInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
  /** Opaque state a previous run's `provider-state` part carried, handed to the
   *  first model call so a conversation's reasoning continues across turns. */
  providerState?: unknown;
  context?: Record<string, unknown>;
  /** The caller's decisions on the calls `messages` leaves pending. */
  approvals?: ToolApproval[];
}

interface AiAgentStreamOutput {
  output: Stream<AgentStreamPart>;
}

/** Why a span ends when the stream's consumer stops reading before the run does. */
const ABANDONED = "the stream's consumer stopped reading";

/** What a model call's spans are opened under. */
interface CallSpans {
  agentSpan: OpenSpan;
  agent: AgentSpanIdentity;
  modelName: string;
  label: string;
}

/** A model call that has been dispatched and not yet read. */
interface OpenedCall {
  chatSpan: OpenSpan;
  output: AsyncIterable<StreamPart>;
}

class AiAgentStream implements ResourceInstance<AiAgentStreamInputs, AiAgentStreamOutput> {
  private assembled?: AssembledTools;

  private readonly maxToolResultBytes: number | undefined;

  private readonly maxParallelTools: number;

  private readonly budget: StepBudget;

  constructor(
    private readonly resource: AiAgentStreamResource,
    private readonly ctx: ResourceContext,
  ) {
    const label = `Ai.AgentStream "${resource.metadata.name}"`;
    this.maxToolResultBytes = toolResultByteLimit(resource.maxToolResultBytes, label);
    this.maxParallelTools = parallelToolLimit(resource.maxParallelTools, label);
    this.budget = stepBudget(resource, label);
    checkApprovalNames(resource.toolProviders, label);
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

    // Resolved for every run, gated call or not, and here rather than as the
    // stream is read, so an unusable approver fails the CALL.
    const approver =
      this.resource.approver && new Approver(this.resource.approver, this.ctx, label);

    const conversation = new Conversation(buildInitialMessages(inputs, this.resource, label));
    // Refused here, from the input alone, so a bad `approvals` fails the CALL.
    const pending = pendingWork(conversation, inputs, label);
    const mergedOptions = mergeAgentOptions(this.resource, inputs);

    // Assemble tools eagerly so a collision / bad-reference error surfaces from
    // invoke() rather than mid-stream. Cached across invokes (list_changed deferred).
    if (!this.assembled) {
      this.assembled = await assembleTools(this.resource.toolProviders, label);
    }

    // The first model call is dispatched here, not when the stream is first
    // read: a request the model refuses outright fails this CALL, where a
    // `catch:` and a route's `catches:` can still answer it, and only a failure
    // during generation rejects the iteration. A run that has pending calls to
    // settle makes no model call until they are settled, which happens as the
    // stream is read.
    const agent: AgentSpanIdentity = { kind: "Ai.AgentStream", name };
    const agentSpan = await openAgentSpan(this.ctx, ctx, agent);
    const spans: CallSpans = { agentSpan, agent, modelName: modelNameOf(model), label };
    let first: OpenedCall | undefined;
    if (pending.calls.length === 0) {
      try {
        first = await this.openModelCall(
          this.stepRequest(conversation, mergedOptions, this.assembled, inputs.providerState),
          spans,
        );
      } catch (err) {
        await settleFailure(agentSpan, err, { "ai.agent.steps": 1 });
        throw err;
      }
    }

    return {
      output: new Stream(
        this.closingUnread(
          this.runLoop(
            conversation,
            pending,
            mergedOptions,
            this.assembled,
            inputs.providerState,
            inputs.context ?? {},
            approver,
            spans,
            first,
            ctx,
          ),
          first,
          agentSpan,
        ),
      ),
    };
  }

  /**
   * The run, as a stream that can be cancelled before it is read. A generator
   * that was never started runs none of its body when it is ended, so the call
   * and the spans this invocation already opened are closed here instead —
   * to the same end as a consumer that stops reading mid-run.
   */
  private closingUnread(
    run: AsyncGenerator<AgentStreamPart>,
    first: OpenedCall | undefined,
    agentSpan: OpenSpan,
  ): AsyncIterable<AgentStreamPart> {
    let started = false;
    const closeUnread = async (): Promise<void> => {
      if (started) return;
      started = true;
      const abandoned = { "telo.cancellation.reason": ABANDONED };
      try {
        await first?.output[Symbol.asyncIterator]().return?.();
      } finally {
        await first?.chatSpan.settle("cancelled", { attributes: abandoned });
        await agentSpan.settle("cancelled", {
          attributes: { "ai.agent.steps": first ? 1 : 0, ...abandoned },
        });
      }
    };
    const iterator: AsyncIterableIterator<AgentStreamPart> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => {
        started = true;
        return run.next();
      },
      return: async (value) => {
        await closeUnread();
        return run.return(value);
      },
      throw: async (err) => {
        await closeUnread();
        return run.throw(err);
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /** The request of one step of the loop. */
  private stepRequest(
    conversation: Conversation,
    options: Record<string, unknown>,
    tools: AssembledTools,
    providerState: unknown,
  ): ModelInvokeInput {
    return {
      messages: conversation.forModel(),
      options,
      ...(tools.toolDefs.length > 0 ? { tools: tools.toolDefs } : {}),
      ...(providerState === undefined ? {} : { providerState }),
    };
  }

  /**
   * The multi-turn loop, run as the Stream is consumed. Its first model call
   * arrives already dispatched; every later one is dispatched here. A run given a
   * conversation with pending calls settles those first, and has no first call.
   *
   * Each model call's own `finish` becomes a `step-finish` carrying that call's
   * usage and finish reason, emitted when the call's stream ends and before its
   * tools run; the one terminal `finish` carries the usage of every call summed.
   * `text-delta`, `reasoning-delta`, `content-part`, `tool-call-delta` and
   * `provider-state` parts forward verbatim, a `tool-call` forwards with the id it
   * keeps for the rest of the run, and each executed tool emits a `tool-result`.
   * A response's tools run side by side up to `maxParallelTools`: their
   * `tool-result` parts arrive as each completes, and the tool messages the next
   * call is given are in call order. Every message the run appends to the
   * conversation is emitted as a `message` part where it is appended: an assistant
   * turn after its `step-finish`, a tool message right after its `tool-result`.
   * A call that needs a decision is put to the approver (a
   * `tool-approval-decision` part) or left waiting; once the turn's other calls
   * have settled, each waiting call is named by a `tool-approval-request` and the
   * run ends with `finish` marked `interrupt: approval`. Provider state is also
   * kept and replayed to the next call. When `maxSteps` calls pass without the
   * model finishing, `onMaxSteps` decides: reject, finish, or make one concluding
   * call first — the last two marking the terminal `finish` `limit: max-steps`.
   *
   * Cancellation is re-checked after every part, between calls and before each
   * tool, and the invocation's cancellation reaches every model call and every
   * running tool — so a cancelled turn ends with `ERR_INVOKE_CANCELLED`. A call interrupted
   * before its `finish` reports no `step-finish`; one whose `finish` arrived still
   * reports it, even when the cancellation lands before that part is handled.
   *
   * The run is one `invoke_agent` span; each model call a `chat` span, open until
   * its stream ends; each tool call an `execute_tool` span. A consumer that stops
   * reading ends every open span as cancelled.
   */
  private async *runLoop(
    conversation: Conversation,
    pending: PendingWork,
    options: Record<string, unknown>,
    tools: AssembledTools,
    initialProviderState: unknown,
    context: Record<string, unknown>,
    approver: Approver | undefined,
    spans: CallSpans,
    first: OpenedCall | undefined,
    ctx?: InvokeContext,
  ): AsyncGenerator<AgentStreamPart> {
    const { agentSpan, agent, label } = spans;
    const { maxSteps, onMaxSteps, conclusionPrompt } = this.budget;
    const settlement: ToolSettlement = {
      tools,
      onToolError: this.resource.onToolError ?? "feedback",
      maxToolResultBytes: this.maxToolResultBytes,
      maxParallelTools: this.maxParallelTools,
      label,
      spans: this.ctx,
      agent,
      ctx: agentSpan.context,
      context,
      approver,
    };

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: FinishReason = "stop";
    // Carried across calls, opaque throughout.
    let providerState: unknown = initialProviderState;
    let calls = 0;
    const runAttributes = () => ({ "ai.agent.steps": calls, ...usageAttributes(usage) });

    // The first call is open from before this body runs, so its span is closed
    // here if the run ends without reading it.
    let unread: OpenedCall | undefined = first;
    const self = this;
    /** The run ends asking: each waiting call is named, then the one `finish`. */
    async function* interrupt(waiting: ToolCall[]): AsyncGenerator<AgentStreamPart> {
      for (const toolCall of waiting) yield { type: "tool-approval-request", toolCall };
      const total = withTokenQuantity(usage);
      logCompletion(self.ctx.log, "Agent stream interrupted for tool approval", total, "tool-calls", {
        "ai.agent.steps": calls,
      });
      await agentSpan.settle("ok", { attributes: runAttributes() });
      yield { type: "finish", usage: total, finishReason: "tool-calls", interrupt: APPROVAL_INTERRUPT };
    }
    try {
      // Calls the conversation left pending are settled before any model call.
      if (pending.calls.length > 0) {
        const waiting = yield* settleToolCalls(
          settlement,
          pending.calls,
          pending.approvals,
          conversation,
        );
        if (waiting.length > 0) {
          yield* interrupt(waiting);
          return;
        }
      }

      for (let step = 0; step < maxSteps; step++) {
        ctx?.cancellation.throwIfCancelled();

        calls += 1;
        const opened: OpenedCall =
          unread ??
          (await this.openModelCall(
            this.stepRequest(conversation, options, tools, providerState),
            spans,
          ));
        unread = undefined;
        const turn = yield* this.modelCall(opened, spans, ctx);
        if (turn.providerState !== undefined) providerState = turn.providerState;

        finishReason = turn.finish.finishReason;
        addUsage(usage, turn.finish.usage);
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
          yield conversation.append({ role: "assistant", content: turn.text });
          yield { type: "finish", usage: total, finishReason };
          return;
        }

        yield conversation.append({
          role: "assistant",
          content: turn.text,
          toolCalls: turn.toolCalls,
        });

        // With onToolError: "throw", dispatch throws — and the throw PROPAGATES,
        // rejecting the iteration, so `catches:`, a throws union and a `try:`
        // step all see it; none of them could see a data part. Results are
        // reported as each completes; the next call is given them in the order
        // they were asked for.
        const waiting = yield* settleToolCalls(settlement, turn.toolCalls, new Map(), conversation);
        if (waiting.length > 0) {
          yield* interrupt(waiting);
          return;
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
      if (onMaxSteps === "conclude") {
        // One call beyond the budget, which may not use a tool: the model is asked
        // to answer from what it has. A tool call it returns anyway is neither
        // emitted nor run, and neither are the argument deltas leading to it.
        ctx?.cancellation.throwIfCancelled();
        calls += 1;
        const turn = yield* this.modelCall(
          await this.openModelCall(
            conclusionRequest(
              conversation.forModel(),
              conclusionPrompt,
              options,
              tools.toolDefs,
              providerState,
            ),
            spans,
          ),
          spans,
          ctx,
          { withholdToolCalls: true },
        );
        finishReason = turn.finish.finishReason;
        addUsage(usage, turn.finish.usage);
        yield {
          type: "step-finish",
          usage: withTokenQuantity(turn.finish.usage),
          finishReason: turn.finish.finishReason,
        };
        const total = withTokenQuantity(usage);
        logCompletion(this.ctx.log, "Agent stream concluded at maxSteps", total, finishReason, {
          "ai.agent.steps": calls,
          "ai.agent.max_steps": maxSteps,
        });
        await agentSpan.settle("ok", { attributes: runAttributes() });
        yield conversation.append({ role: "assistant", content: turn.text });
        yield { type: "finish", usage: total, finishReason, limit: MAX_STEPS_LIMIT };
        return;
      }
      // `onMaxSteps: "return"` — the terminal finish is marked by `limit`. The
      // buffered agent warns here for the same reason.
      const total = withTokenQuantity(usage);
      this.ctx.log.warn("Agent stream stopped at maxSteps without converging", {
        "ai.agent.max_steps": maxSteps,
        "gen_ai.usage.input_tokens": total.promptTokens,
        "gen_ai.usage.output_tokens": total.completionTokens,
      });
      await agentSpan.settle("ok", { attributes: runAttributes() });
      yield { type: "finish", usage: total, finishReason, limit: MAX_STEPS_LIMIT };
    } catch (err) {
      await settleFailure(agentSpan, err, runAttributes());
      throw err;
    } finally {
      try {
        // A first call the run ended without reading is still open.
        await unread?.output[Symbol.asyncIterator]().return?.();
      } finally {
        await unread?.chatSpan.settle("cancelled");
        // Reached unsettled only when the consumer stopped reading mid-run.
        await agentSpan.settle("cancelled", {
          attributes: { ...runAttributes(), "telo.cancellation.reason": ABANDONED },
        });
      }
    }
  }

  /** Dispatch one model call under its `chat` span, which stays open until the
   *  call's stream ends. A model that refuses the request fails here. */
  private async openModelCall(request: ModelInvokeInput, spans: CallSpans): Promise<OpenedCall> {
    const chatSpan = await openChatSpan(this.ctx, spans.agentSpan, spans.agent, spans.modelName);
    try {
      const turn = await this.resource.model.invoke(request, chatSpan.context);
      return { chatSpan, output: turn.output };
    } catch (err) {
      await settleFailure(chatSpan, err);
      throw err;
    }
  }

  /**
   * Reads one dispatched model call: forwards its parts and returns what the loop
   * needs of it, then closes the call's `chat` span.
   */
  private async *modelCall(
    { chatSpan, output }: OpenedCall,
    spans: CallSpans,
    ctx?: InvokeContext,
    /** The concluding call may not use a tool: one it returns is dropped here,
     *  with its argument deltas. */
    { withholdToolCalls = false }: { withholdToolCalls?: boolean } = {},
  ): AsyncGenerator<
    AgentStreamPart,
    {
      toolCalls: ToolCall[];
      text: string;
      finish: { usage: Usage; finishReason: FinishReason };
      providerState: unknown;
    }
  > {
    const toolCalls: ToolCall[] = [];
    let text = "";
    let finish: { usage: Usage; finishReason: FinishReason } | undefined;
    let providerState: unknown;
    try {
      for await (const part of output) {
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
          if (withholdToolCalls) continue;
          const call = normalizeToolCall(part.toolCall);
          assertUniqueCallId(call, toolCalls, spans.label);
          toolCalls.push(call);
          yield { type: "tool-call", toolCall: call };
        } else if (part.type === "tool-call-delta") {
          if (withholdToolCalls) continue;
          // The id is the model's to assign: a consumer joins a delta to its
          // call by it, so one without it can be joined to nothing.
          if (!part.toolCallId) {
            throw new InvokeError(
              "ERR_CONTRACT_VIOLATION",
              `${spans.label}: the model's stream carried a 'tool-call-delta' with no 'toolCallId'. Every delta names the id of the 'tool-call' that completes it.`,
            );
          }
          yield part;
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

