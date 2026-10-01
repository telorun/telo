import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import type { MessageContent } from "./content.js";
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
import {
  assembleTools,
  buildInitialMessages,
  dispatchToolCall,
  mergeAgentOptions,
  normalizeToolCall,
  type AssembledTools,
  type ToolProviderEntry,
} from "./agent-tools.js";
import {
  conclusionRequest,
  MAX_STEPS_LIMIT,
  stepBudget,
  type StepBudget,
  type StepBudgetConfig,
} from "./step-budget.js";
import { toolResultByteLimit } from "./tool-result-bound.js";
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
 * until the model finishes (no tool calls) or `maxSteps` is reached — where
 * `onMaxSteps` decides between failing, returning the last turn and one concluding
 * call. Buffered only.
 *
 * The loop lives here (not in the provider) so it is provider-agnostic and observable —
 * every turn's calls + results land in the `steps` trace. Tool assembly and dispatch
 * are shared with Ai.AgentStream via `agent-tools.ts`.
 */
interface AiAgentResource extends StepBudgetConfig {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
  onToolError?: "feedback" | "throw";
  maxToolResultBytes?: number | bigint;
  toolProviders?: ToolProviderEntry[];
}

interface AiAgentInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
  context?: Record<string, unknown>;
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
  /** Set when the step budget, not the model, ended the run. */
  limit?: typeof MAX_STEPS_LIMIT;
  steps: StepTrace[];
}

class AiAgent implements ResourceInstance<AiAgentInputs, AiAgentOutput> {
  /** Tool set assembled lazily on first invoke and cached (list_changed refresh deferred). */
  private assembled?: AssembledTools;

  private readonly maxToolResultBytes: number | undefined;

  private readonly budget: StepBudget;

  constructor(
    private readonly resource: AiAgentResource,
    private readonly ctx: ResourceContext,
  ) {
    const label = `Ai.Agent "${resource.metadata.name}"`;
    this.maxToolResultBytes = toolResultByteLimit(resource.maxToolResultBytes, label);
    this.budget = stepBudget(resource, label);
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

    const messages = buildInitialMessages(inputs, this.resource, label);
    const mergedOptions = mergeAgentOptions(this.resource, inputs);

    const { toolDefs, dispatch } = await this.tools();
    const { maxSteps, onMaxSteps, conclusionPrompt } = this.budget;
    const context = inputs.context ?? {};
    const onToolError = this.resource.onToolError ?? "feedback";

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const steps: StepTrace[] = [];
    let last: CompletionResult | undefined;
    // Carried across turns, opaque throughout.
    let providerState: unknown;

    const agent: AgentSpanIdentity = { kind: "Ai.Agent", name };
    const modelName = modelNameOf(model);
    let calls = 0;
    const runAttributes = () => ({ "ai.agent.steps": calls, ...usageAttributes(usage) });
    const agentSpan = await openAgentSpan(this.ctx, ctx, agent);
    try {
      for (let step = 0; step < maxSteps; step++) {
        ctx?.cancellation.throwIfCancelled();
        calls += 1;
        const chatSpan = await openChatSpan(this.ctx, agentSpan, agent, modelName);
        let result: CompletionResult;
        let turnUsage: Usage;
        try {
          result = await model.invoke(
            {
              messages,
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
        providerState = result.providerState;
        usage.promptTokens += turnUsage.promptTokens;
        usage.completionTokens += turnUsage.completionTokens;
        usage.totalTokens += turnUsage.totalTokens;

        const toolCalls = result.toolCalls ?? [];
        if (toolCalls.length === 0) {
          // A step is one model call, the answering one included.
          steps.push({ text: result.text ?? "", toolCalls: [], toolResults: [] });
          const total = withTokenQuantity(usage);
          // The aggregate across every turn, which is what the run actually cost —
          // a per-turn figure would understate an agent that looped eight times.
          logCompletion(this.ctx.log, "Agent run finished", total, result.finishReason, {
            "ai.agent.steps": calls,
          });
          await agentSpan.settle("ok", { attributes: runAttributes() });
          return {
            text: result.text,
            usage: total,
            finishReason: result.finishReason,
            steps,
          };
        }

        const normalized = toolCalls.map(normalizeToolCall);
        messages.push({ role: "assistant", content: result.text ?? "", toolCalls: normalized });

        const trace: StepTrace = { text: result.text ?? "", toolCalls: normalized, toolResults: [] };
        for (const call of normalized) {
          ctx?.cancellation.throwIfCancelled();
          const record = await dispatchToolCall(
            call,
            dispatch,
            onToolError,
            this.maxToolResultBytes,
            label,
            this.ctx,
            agent,
            agentSpan.context,
            context,
          );
          // The buffered trace keeps the record the model saw; the tool's own
          // result travels on the streaming agent's part only.
          trace.toolResults.push({
            toolCallId: record.toolCallId,
            name: record.name,
            content: record.content,
            ...(record.error ? { error: true } : {}),
          });
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
            conclusionRequest(messages, conclusionPrompt, mergedOptions, toolDefs, providerState),
            chatSpan.context,
          );
          turnUsage = tokenCounts(result.usage);
        } catch (err) {
          await settleFailure(chatSpan, err);
          throw err;
        }
        await chatSpan.settle("ok", { attributes: chatAttributes(turnUsage, result.finishReason) });
        usage.promptTokens += turnUsage.promptTokens;
        usage.completionTokens += turnUsage.completionTokens;
        usage.totalTokens += turnUsage.totalTokens;
        steps.push({ text: result.text ?? "", toolCalls: [], toolResults: [] });
        const total = withTokenQuantity(usage);
        logCompletion(this.ctx.log, "Agent run concluded at maxSteps", total, result.finishReason, {
          "ai.agent.steps": calls,
          "ai.agent.max_steps": maxSteps,
        });
        await agentSpan.settle("ok", { attributes: runAttributes() });
        return {
          text: result.text,
          usage: total,
          finishReason: result.finishReason,
          limit: MAX_STEPS_LIMIT,
          steps,
        };
      }
      // `onMaxSteps: "return"` — the last turn is handed back, marked by `limit`.
      // `warn`, because the answer is a truncation.
      const total = withTokenQuantity(usage);
      this.ctx.log.warn("Agent stopped at maxSteps without converging; returning the last turn", {
        "ai.agent.max_steps": maxSteps,
        "gen_ai.usage.input_tokens": total.promptTokens,
        "gen_ai.usage.output_tokens": total.completionTokens,
      });
      await agentSpan.settle("ok", { attributes: runAttributes() });
      return {
        text: last?.text ?? "",
        usage: total,
        finishReason: last?.finishReason ?? "tool-calls",
        limit: MAX_STEPS_LIMIT,
        steps,
      };
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

