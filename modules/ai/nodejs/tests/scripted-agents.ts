import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError, UNCANCELLABLE_CONTEXT } from "@telorun/sdk";
import { create as createAgent } from "../src/ai-agent-controller.js";
import { create as createAgentStream } from "../src/ai-agent-stream-controller.js";
import type { ToolProviderEntry } from "../src/agent-tools.js";
import type {
  AgentStreamPart,
  AiToolProviderInstance,
  CompletionResult,
  ModelInvokeInput,
  StreamPart,
  ToolCall,
} from "../src/types.js";

/**
 * Scripted models, a one-tool provider and a tracing-off context, for tests that
 * drive both agent kinds through the same run.
 */

export const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/** The context with tracing off, as the kernel's is by default: a span is a
 *  pass-through of the context it is opened on, and a resolved dispatch calls the
 *  instance with the context it is given. */
export const ctx = {
  log: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
  openSpan: async (base: InvokeContext | undefined) => ({
    context: base ?? UNCANCELLABLE_CONTEXT,
    settle: async () => undefined,
  }),
  // A mapping is a function of its scope here, standing in for compiled CEL.
  expandValue: (value: unknown, scope: Record<string, unknown>) =>
    typeof value === "function" ? value(scope) : value,
  invokeResolved: (
    _kind: string,
    _name: string,
    instance: { invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> },
    inputs: unknown,
    invokeCtx?: InvokeContext,
  ) => instance.invoke(inputs, invokeCtx),
} as unknown as ResourceContext;

/** One model call's plan: request tools (by name, with or without ids and
 *  arguments) or answer. */
export type CallPlan =
  | { tools: Array<{ name: string; id?: string; args?: Record<string, unknown> }> }
  | { answer: string };

/** Records every input a scripted model saw. */
export interface Seen {
  inputs: ModelInvokeInput[];
}

function toolCallsOf(plan: CallPlan): ToolCall[] {
  return "tools" in plan
    ? plan.tools.map((t) => ({ id: t.id ?? "", name: t.name, arguments: t.args ?? {} }))
    : [];
}

/** A buffered model following `plans`, one per call (the last one repeats). */
export function bufferedModel(plans: CallPlan[], seen: Seen) {
  let call = 0;
  return {
    async invoke(input: ModelInvokeInput): Promise<CompletionResult> {
      seen.inputs.push(structuredClone(input));
      const plan = plans[Math.min(call++, plans.length - 1)]!;
      const calls = toolCallsOf(plan);
      const text = "answer" in plan ? plan.answer : "";
      return {
        content: text ? [{ type: "text", text }] : [],
        text,
        usage: USAGE,
        finishReason: calls.length > 0 ? "tool-calls" : "stop",
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      };
    },
  };
}

/** A streaming model following `plans`; `hang` makes the given call stall after
 *  its first part until the call's context is cancelled. */
export function streamingModel(plans: CallPlan[], seen: Seen, hang?: number) {
  let call = 0;
  return {
    async invoke(input: ModelInvokeInput, invokeCtx?: InvokeContext) {
      seen.inputs.push(structuredClone(input));
      const index = call++;
      const plan = plans[Math.min(index, plans.length - 1)]!;
      async function* parts(): AsyncIterable<StreamPart> {
        for (const toolCall of toolCallsOf(plan)) yield { type: "tool-call", toolCall };
        if ("answer" in plan) yield { type: "text-delta", delta: plan.answer };
        if (index === hang) {
          await new Promise<void>((_, reject) =>
            invokeCtx!.cancellation.onCancelled(() =>
              reject(new InvokeError(ERR_INVOKE_CANCELLED, "model call cancelled")),
            ),
          );
        }
        yield { type: "finish", usage: USAGE, finishReason: "tool-calls" in plan ? "tool-calls" : "stop" };
      }
      return { output: parts() };
    },
  };
}

/** A provider with one tool whose behaviour the test supplies. */
export function provider(
  run: (args: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>,
): AiToolProviderInstance & { contexts: Array<InvokeContext | undefined> } {
  const contexts: Array<InvokeContext | undefined> = [];
  return {
    contexts,
    listTools: () => [{ name: "work", parameters: { type: "object" } }],
    callTool: (name, args, invokeCtx) => {
      contexts.push(invokeCtx);
      return run(args, invokeCtx);
    },
  };
}

export async function drain(output: AsyncIterable<AgentStreamPart>): Promise<{
  parts: AgentStreamPart[];
  error?: unknown;
}> {
  const parts: AgentStreamPart[] = [];
  try {
    for await (const part of output) parts.push(part);
    return { parts };
  } catch (error) {
    return { parts, error };
  }
}

/** What both agents are built from and called with. */
export interface AgentRun {
  plans: CallPlan[];
  toolProviders: ToolProviderEntry[];
  /** Agent config beyond the model and its tool providers. */
  config?: Record<string, unknown>;
  /** The call's inputs; `{ prompt: "go" }` when omitted. */
  inputs?: Record<string, unknown>;
  invokeCtx?: InvokeContext;
}

/** Both agent kinds, run to their end: parts for the stream, the result for the
 *  buffered agent, and the error either ended with. */
export async function runAgents({ plans, toolProviders, config, inputs, invokeCtx }: AgentRun) {
  const call = inputs ?? { prompt: "go" };
  const bufferedSeen: Seen = { inputs: [] };
  let buffered: { result?: AgentResult; error?: unknown };
  try {
    const agent = await createAgent(
      { metadata: { name: "agent" }, model: bufferedModel(plans, bufferedSeen), toolProviders, ...config },
      ctx,
    );
    buffered = { result: await agent.invoke(structuredClone(call), invokeCtx) };
  } catch (error) {
    buffered = { error };
  }

  const streamSeen: Seen = { inputs: [] };
  let streamed: { parts: AgentStreamPart[]; error?: unknown };
  try {
    const stream = await createAgentStream(
      { metadata: { name: "stream" }, model: streamingModel(plans, streamSeen), toolProviders, ...config },
      ctx,
    );
    streamed = await drain((await stream.invoke(structuredClone(call), invokeCtx)).output);
  } catch (error) {
    // Raised by the call itself, before any stream exists.
    streamed = { parts: [], error };
  }
  return { buffered, bufferedSeen, streamed, streamSeen };
}

type AgentResult = Awaited<ReturnType<Awaited<ReturnType<typeof createAgent>>["invoke"]>>;

/** {@link runAgents} over one provider mounted whole. */
export function runBoth(
  plans: CallPlan[],
  tool: AiToolProviderInstance,
  invokeCtx?: InvokeContext,
  maxToolResultBytes?: number,
  config: { maxParallelTools?: number; onToolError?: "feedback" | "throw" } = {},
) {
  return runAgents({
    plans,
    toolProviders: [{ provider: tool }],
    config: { maxToolResultBytes, ...config },
    invokeCtx,
  });
}

/** The parts of one type. */
export function partsOf<T extends AgentStreamPart["type"]>(
  parts: AgentStreamPart[],
  type: T,
): Array<Extract<AgentStreamPart, { type: T }>> {
  return parts.filter((p): p is Extract<AgentStreamPart, { type: T }> => p.type === type);
}
