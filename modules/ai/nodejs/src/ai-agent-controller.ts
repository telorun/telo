import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import type { MessageContent } from "./content.js";
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
import { Conversation, pendingWork } from "./conversation.js";
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
  type AiModelInstance,
  type ApprovalDecision,
  type CompletionResult,
  type FinishReason,
  type Message,
  type ToolApproval,
  type ToolCall,
  type Usage,
} from "./types.js";

/**
 * Ai.Agent — the tool-use loop. Calls the model with the merged tool set; while the
 * model requests tools, dispatches each to its provider, replays the results, and loops
 * until the model finishes (no tool calls) or `maxSteps` is reached — where
 * `onMaxSteps` decides between failing, returning the last turn and one concluding
 * call. Buffered only.
 *
 * A call that needs a decision is settled before it runs: by the caller's
 * `approvals`, by the agent's `approver`, or by ending the run with
 * `interrupt: approval` — to be continued from the returned `messages`.
 *
 * The loop lives here (not in the provider) so it is provider-agnostic and observable —
 * every model call lands in `steps` and every settled tool call in `toolResults`. Tool assembly and dispatch
 * are shared with Ai.AgentStream via `agent-tools.ts`, the settling of a turn's
 * calls via `tool-approval.ts`, and the record of the run via `conversation.ts`.
 */
interface AiAgentResource extends StepBudgetConfig {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
  onToolError?: "feedback" | "throw";
  maxToolResultBytes?: number | bigint;
  maxParallelTools?: number | bigint;
  toolProviders?: ToolProviderEntry[];
  approver?: ApproverConfig;
}

interface AiAgentInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** The caller's decisions on the calls `messages` leaves pending. */
  approvals?: ToolApproval[];
  /** Opaque state a previous run returned, handed to the first model call. */
  providerState?: unknown;
}

/** One model call of the run. */
interface StepTrace {
  text: string;
  toolCalls: ToolCall[];
}

/** A settled tool call as the model saw it; the tool's own result travels on
 *  the streaming agent's part only. */
interface SettledToolCall {
  toolCallId: string;
  name: string;
  content: MessageContent;
  error?: boolean;
  denied?: boolean;
}

interface AiAgentOutput {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  /** Set when the step budget, not the model, ended the run. */
  limit?: typeof MAX_STEPS_LIMIT;
  steps: StepTrace[];
  /** Every tool call the run settled, in the order its result was recorded. */
  toolResults: SettledToolCall[];
  /** Every message the run appended to the conversation, in order. */
  messages: Message[];
  /** Set when the run ended with calls waiting for a decision. */
  interrupt?: typeof APPROVAL_INTERRUPT;
  /** The calls waiting for a decision, in call order. */
  approvalRequests?: ToolCall[];
  /** What the approver answered, in the order it answered. */
  approvalDecisions?: ApprovalDecision[];
  /** Opaque model state to hand to the next run. */
  providerState?: unknown;
}

class AiAgent implements ResourceInstance<AiAgentInputs, AiAgentOutput> {
  /** Tool set assembled lazily on first invoke and cached (list_changed refresh deferred). */
  private assembled?: AssembledTools;

  private readonly maxToolResultBytes: number | undefined;

  private readonly maxParallelTools: number;

  private readonly budget: StepBudget;

  constructor(
    private readonly resource: AiAgentResource,
    private readonly ctx: ResourceContext,
  ) {
    const label = `Ai.Agent "${resource.metadata.name}"`;
    this.maxToolResultBytes = toolResultByteLimit(resource.maxToolResultBytes, label);
    this.maxParallelTools = parallelToolLimit(resource.maxParallelTools, label);
    this.budget = stepBudget(resource, label);
    checkApprovalNames(resource.toolProviders, label);
  }

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

    // Resolved for every run, gated call or not, before anything is settled or called.
    const approver =
      this.resource.approver && new Approver(this.resource.approver, this.ctx, label);

    const conversation = new Conversation(buildInitialMessages(inputs, this.resource, label));
    const pending = pendingWork(conversation, inputs, label);
    const mergedOptions = mergeAgentOptions(this.resource, inputs);

    const tools = await this.tools();
    const { toolDefs } = tools;
    const { maxSteps, onMaxSteps, conclusionPrompt } = this.budget;

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const steps: StepTrace[] = [];
    const toolResults: SettledToolCall[] = [];
    const decisions: ApprovalDecision[] = [];
    let last: CompletionResult | undefined;
    // Carried across turns, opaque throughout.
    let providerState: unknown = inputs.providerState;

    const agent: AgentSpanIdentity = { kind: "Ai.Agent", name };
    const modelName = modelNameOf(model);
    let calls = 0;
    const runAttributes = () => ({ "ai.agent.steps": calls, ...usageAttributes(usage) });
    const agentSpan = await openAgentSpan(this.ctx, ctx, agent);
    const settlement: ToolSettlement = {
      tools,
      onToolError: this.resource.onToolError ?? "feedback",
      maxToolResultBytes: this.maxToolResultBytes,
      maxParallelTools: this.maxParallelTools,
      label,
      spans: this.ctx,
      agent,
      ctx: agentSpan.context,
      context: inputs.context ?? {},
      approver,
    };

    /** Settle a set of calls, recording each result as it lands; returns the
     *  calls left waiting. */
    const settle = async (
      toolCalls: readonly ToolCall[],
      approvals: ReadonlyMap<string, ToolApproval>,
    ): Promise<ToolCall[]> => {
      const round = settleToolCalls(settlement, toolCalls, approvals, conversation);
      let step = await round.next();
      while (!step.done) {
        const part = step.value;
        if (part.type === "tool-approval-decision") decisions.push(part.approvalDecision);
        if (part.type === "tool-result") {
          const record = part.toolResult;
          toolResults.push({
            toolCallId: record.toolCallId,
            name: record.name,
            content: record.content,
            ...(record.error ? { error: true } : {}),
            ...(record.denied ? { denied: true } : {}),
          });
        }
        step = await round.next();
      }
      return step.value;
    };

    const finished = (
      text: string,
      finishReason: FinishReason,
      ending: Pick<AiAgentOutput, "limit" | "interrupt" | "approvalRequests"> = {},
    ): AiAgentOutput => ({
      text,
      usage: withTokenQuantity(usage),
      finishReason,
      ...ending,
      steps,
      toolResults,
      messages: conversation.appended,
      ...(decisions.length > 0 ? { approvalDecisions: decisions } : {}),
      ...(providerState === undefined ? {} : { providerState }),
    });

    /** The run ends asking: nothing more is called until its caller decides. */
    const interrupted = async (text: string, waiting: ToolCall[]): Promise<AiAgentOutput> => {
      const output = finished(text, "tool-calls", {
        interrupt: APPROVAL_INTERRUPT,
        approvalRequests: waiting,
      });
      logCompletion(this.ctx.log, "Agent run interrupted for tool approval", output.usage, "tool-calls", {
        "ai.agent.steps": calls,
      });
      await agentSpan.settle("ok", { attributes: runAttributes() });
      return output;
    };

    try {
      // Calls the conversation left pending are settled before any model call.
      if (pending.calls.length > 0) {
        const waiting = await settle(pending.calls, pending.approvals);
        if (waiting.length > 0) return await interrupted("", waiting);
      }

      for (let step = 0; step < maxSteps; step++) {
        ctx?.cancellation.throwIfCancelled();
        calls += 1;
        const chatSpan = await openChatSpan(this.ctx, agentSpan, agent, modelName);
        let result: CompletionResult;
        let turnUsage: Usage;
        try {
          result = await model.invoke(
            {
              messages: conversation.forModel(),
              options: mergedOptions,
              ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
              // Replayed verbatim so a provider that keeps its reasoning
              // server-side can pick the chain back up. This is what makes
              // reasoning survive a tool loop rather than restarting at every
              // turn; `ai` never looks inside it.
              ...(providerState === undefined ? {} : { providerState }),
            },
            chatSpan.context,
          );
          // Converted before adding: a declared integer arrives as an int64, and
          // `0 + 1n` is a TypeError rather than a sum.
          turnUsage = tokenCounts(result.usage);
        } catch (err) {
          await settleFailure(chatSpan, err);
          throw err;
        }
        await chatSpan.settle("ok", { attributes: chatAttributes(turnUsage, result.finishReason) });
        last = result;
        if (result.providerState !== undefined) providerState = result.providerState;
        addUsage(usage, turnUsage);

        const toolCalls = result.toolCalls ?? [];
        if (toolCalls.length === 0) {
          // A step is one model call, the answering one included.
          steps.push({ text: result.text ?? "", toolCalls: [] });
          conversation.append({ role: "assistant", content: result.text ?? "" });
          const output = finished(result.text, result.finishReason);
          // The aggregate across every turn, which is what the run actually cost —
          // a per-turn figure would understate an agent that looped eight times.
          logCompletion(this.ctx.log, "Agent run finished", output.usage, result.finishReason, {
            "ai.agent.steps": calls,
          });
          await agentSpan.settle("ok", { attributes: runAttributes() });
          return output;
        }

        const normalized: ToolCall[] = [];
        for (const toolCall of toolCalls) {
          const call = normalizeToolCall(toolCall);
          assertUniqueCallId(call, normalized, label);
          normalized.push(call);
        }
        conversation.append({ role: "assistant", content: result.text ?? "", toolCalls: normalized });
        steps.push({ text: result.text ?? "", toolCalls: normalized });
        const waiting = await settle(normalized, new Map());
        if (waiting.length > 0) return await interrupted(result.text ?? "", waiting);
      }

      if (onMaxSteps === "throw") {
        throw new InvokeError(
          "ERR_AGENT_MAX_STEPS",
          `Ai.Agent "${name}": did not converge within maxSteps=${maxSteps}.`,
        );
      }
      if (onMaxSteps === "conclude") {
        // One call beyond the budget, which may not use a tool: the model is asked
        // to answer from what it has. A tool call it returns anyway is not run.
        ctx?.cancellation.throwIfCancelled();
        calls += 1;
        const chatSpan = await openChatSpan(this.ctx, agentSpan, agent, modelName);
        let result: CompletionResult;
        let turnUsage: Usage;
        try {
          result = await model.invoke(
            conclusionRequest(
              conversation.forModel(),
              conclusionPrompt,
              mergedOptions,
              toolDefs,
              providerState,
            ),
            chatSpan.context,
          );
          turnUsage = tokenCounts(result.usage);
        } catch (err) {
          await settleFailure(chatSpan, err);
          throw err;
        }
        await chatSpan.settle("ok", { attributes: chatAttributes(turnUsage, result.finishReason) });
        if (result.providerState !== undefined) providerState = result.providerState;
        addUsage(usage, turnUsage);
        steps.push({ text: result.text ?? "", toolCalls: [] });
        conversation.append({ role: "assistant", content: result.text ?? "" });
        const output = finished(result.text, result.finishReason, { limit: MAX_STEPS_LIMIT });
        logCompletion(this.ctx.log, "Agent run concluded at maxSteps", output.usage, result.finishReason, {
          "ai.agent.steps": calls,
          "ai.agent.max_steps": maxSteps,
        });
        await agentSpan.settle("ok", { attributes: runAttributes() });
        return output;
      }
      // `onMaxSteps: "return"` — the last turn is handed back, marked by `limit`.
      // `warn`, because the answer is a truncation.
      const output = finished(last?.text ?? "", last?.finishReason ?? "tool-calls", {
        limit: MAX_STEPS_LIMIT,
      });
      this.ctx.log.warn("Agent stopped at maxSteps without converging; returning the last turn", {
        "ai.agent.max_steps": maxSteps,
        "gen_ai.usage.input_tokens": output.usage.promptTokens,
        "gen_ai.usage.output_tokens": output.usage.completionTokens,
      });
      await agentSpan.settle("ok", { attributes: runAttributes() });
      return output;
    } catch (err) {
      await settleFailure(agentSpan, err, runAttributes());
      throw err;
    }
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

export async function create(
  resource: AiAgentResource,
  ctx: ResourceContext,
): Promise<AiAgent> {
  return new AiAgent(resource, ctx);
}

