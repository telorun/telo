import { InvokeError } from "@telorun/sdk";
import type { Message, ModelInvokeInput, ToolDefinition } from "./types.js";

/**
 * The agents' step budget: how many model calls a run may make, and what happens
 * when they pass without the model finishing. Shared by `Ai.Agent` and
 * `Ai.AgentStream`, so the two cannot drift on what exhaustion means.
 */
export type OnMaxSteps = "throw" | "return" | "conclude";

/** What marks a result the step budget ended. */
export const MAX_STEPS_LIMIT = "max-steps" as const;

export const DEFAULT_CONCLUSION_PROMPT =
  "You have reached the limit of steps for this run and can call no more tools. " +
  "Using only what you have learned so far, write your final answer now: say what " +
  "is done, what is not done, and what the next step would be.";

export interface StepBudgetConfig {
  maxSteps?: number | bigint;
  onMaxSteps?: OnMaxSteps;
  conclusionPrompt?: string;
}

export interface StepBudget {
  maxSteps: number;
  onMaxSteps: OnMaxSteps;
  conclusionPrompt: string;
}

/** The resolved budget, refusing a configuration nothing would act on. `maxSteps`
 *  may be CEL-computed, so it arrives as an int64. */
export function stepBudget(config: StepBudgetConfig, label: string): StepBudget {
  const maxSteps =
    config.maxSteps === undefined
      ? 8
      : typeof config.maxSteps === "bigint"
        ? Number(config.maxSteps)
        : config.maxSteps;
  const onMaxSteps = config.onMaxSteps ?? "throw";
  // The controller twin of the `AI_CONCLUSION_PROMPT_UNUSED` resource rule.
  if (config.conclusionPrompt !== undefined && onMaxSteps !== "conclude") {
    throw new InvokeError(
      "ERR_AI_CONCLUSION_PROMPT_UNUSED",
      `${label} sets 'conclusionPrompt' without 'onMaxSteps: conclude', so the prompt would never be sent.`,
    );
  }
  return {
    maxSteps,
    onMaxSteps,
    conclusionPrompt: config.conclusionPrompt ?? DEFAULT_CONCLUSION_PROMPT,
  };
}

/**
 * The request of the concluding call: the conversation so far with the conclusion
 * prompt as its final user message, and the same tools declared but not usable —
 * the history's tool calls stay valid, and the model is asked to answer instead.
 */
export function conclusionRequest(
  messages: Message[],
  conclusionPrompt: string,
  options: Record<string, unknown>,
  toolDefs: ToolDefinition[],
  providerState: unknown,
): ModelInvokeInput {
  return {
    messages: [...messages, { role: "user", content: conclusionPrompt }],
    options,
    ...(toolDefs.length > 0 ? { tools: toolDefs, toolChoice: "none" as const } : {}),
    ...(providerState === undefined ? {} : { providerState }),
  };
}
