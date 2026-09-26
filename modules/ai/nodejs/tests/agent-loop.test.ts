import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import {
  ERR_DURABLE_SUSPENDED,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  createCancellationSource,
} from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create as createAgent } from "../src/ai-agent-controller.js";
import { create as createAgentStream } from "../src/ai-agent-stream-controller.js";
import { create as createTools } from "../src/ai-tools-controller.js";
import type {
  AgentStreamPart,
  AiToolProviderInstance,
  CompletionResult,
  Message,
  ModelInvokeInput,
  StreamPart,
  ToolCall,
} from "../src/types.js";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const ctx = {
  log: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
} as unknown as ResourceContext;

/** One model call's plan: request tools (by name, with or without ids) or answer. */
type CallPlan = { tools: Array<{ name: string; id?: string }> } | { answer: string };

/** Records every input a scripted model saw. */
interface Seen {
  inputs: ModelInvokeInput[];
}

function toolCallsOf(plan: CallPlan): ToolCall[] {
  return "tools" in plan
    ? plan.tools.map((t) => ({ id: t.id ?? "", name: t.name, arguments: {} }))
    : [];
}

/** A buffered model following `plans`, one per call (the last one repeats). */
function bufferedModel(plans: CallPlan[], seen: Seen) {
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
function streamingModel(plans: CallPlan[], seen: Seen, hang?: number) {
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
function provider(
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

async function drain(output: AsyncIterable<AgentStreamPart>): Promise<{
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

/** Both agent kinds, run to their end: parts for the stream, the result for the
 *  buffered agent, and the error either ended with. */
async function runBoth(
  plans: CallPlan[],
  tool: AiToolProviderInstance,
  invokeCtx?: InvokeContext,
) {
  const bufferedSeen: Seen = { inputs: [] };
  const agent = await createAgent(
    {
      metadata: { name: "agent" },
      model: bufferedModel(plans, bufferedSeen),
      toolProviders: [{ provider: tool }],
    },
    ctx,
  );
  let buffered: { result?: Awaited<ReturnType<typeof agent.invoke>>; error?: unknown };
  try {
    buffered = { result: await agent.invoke({ prompt: "go" }, invokeCtx) };
  } catch (error) {
    buffered = { error };
  }

  const streamSeen: Seen = { inputs: [] };
  const stream = await createAgentStream(
    {
      metadata: { name: "stream" },
      model: streamingModel(plans, streamSeen),
      toolProviders: [{ provider: tool }],
    },
    ctx,
  );
  const { output } = await stream.invoke({ prompt: "go" }, invokeCtx);
  const streamed = await drain(output);
  return { buffered, bufferedSeen, streamed, streamSeen };
}

const toolThenAnswer: CallPlan[] = [{ tools: [{ name: "work" }] }, { answer: "done" }];

describe("the agent loop", () => {
  it("ends a stream cancelled during its second model call after exactly one step-finish", async () => {
    const seen: Seen = { inputs: [] };
    const agent = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel(toolThenAnswer, seen, 1),
        toolProviders: [{ provider: provider(async () => "ok") }],
      },
      ctx,
    );
    const source = createCancellationSource();
    const { output } = await agent.invoke({ prompt: "go" }, source.context);
    const parts: AgentStreamPart[] = [];
    const iterator = output[Symbol.asyncIterator]();
    let error: unknown;
    try {
      while (true) {
        const step = await iterator.next();
        if (step.done) break;
        parts.push(step.value);
        // The second call's first part has arrived: cancel while it stalls.
        if (step.value.type === "text-delta") source.cancel("turn cancelled");
      }
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(parts.map((p) => p.type)).toEqual(["tool-call", "step-finish", "tool-result", "text-delta"]);
  });

  it("still reports a call's step-finish when cancellation lands after the provider's finish", async () => {
    const source = createCancellationSource();
    const agent = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: {
          async invoke() {
            async function* parts(): AsyncIterable<StreamPart> {
              yield { type: "text-delta", delta: "done" };
              // The call completed and was billed; the turn is cancelled before
              // the agent handles its finish.
              source.cancel("turn cancelled");
              yield { type: "finish", usage: USAGE, finishReason: "stop" };
            }
            return { output: parts() };
          },
        },
        toolProviders: [{ provider: provider(async () => "ok") }],
      },
      ctx,
    );
    const { output } = await agent.invoke({ prompt: "go" }, source.context);
    const { parts, error } = await drain(output);
    expect(error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(parts.map((p) => p.type)).toEqual(["text-delta", "step-finish"]);
    expect(parts[1]).toMatchObject({ type: "step-finish", finishReason: "stop" });
  });

  it("keeps one id per tool call when the model gives none, unique across runs", async () => {
    const ids = async () => {
      const { buffered, bufferedSeen, streamed, streamSeen } = await runBoth(
        toolThenAnswer,
        provider(async () => "ok"),
      );
      const streamCall = streamed.parts.find((p) => p.type === "tool-call");
      const streamResult = streamed.parts.find((p) => p.type === "tool-result");
      const replayed = (seen: Seen) =>
        (seen.inputs[1]!.messages.find((m: Message) => m.role === "assistant")!.toolCalls ?? [])[0]!.id;
      const bufferedStep = buffered.result!.steps[0]!;
      return {
        stream: [
          streamCall?.type === "tool-call" ? streamCall.toolCall.id : undefined,
          replayed(streamSeen),
          streamResult?.type === "tool-result" ? streamResult.toolResult.toolCallId : undefined,
        ],
        buffered: [bufferedStep.toolCalls[0]!.id, replayed(bufferedSeen), bufferedStep.toolResults[0]!.toolCallId],
      };
    };
    const first = await ids();
    const second = await ids();
    for (const run of [first, second]) {
      for (const triple of [run.stream, run.buffered]) {
        expect(triple[0]).toMatch(/^call_/);
        expect(new Set(triple).size).toBe(1);
      }
    }
    const all = [first.stream[0], first.buffered[0], second.stream[0], second.buffered[0]];
    expect(new Set(all).size).toBe(4);
  });

  it("hands the agent invocation's context to the tool provider", async () => {
    const source = createCancellationSource();
    const tool = provider(async () => "ok");
    await runBoth(toolThenAnswer, tool, source.context);
    expect(tool.contexts).toEqual([source.context, source.context]);
  });

  it("ends both agents with the cancellation when a tool is cancelled mid-call, even under feedback", async () => {
    let source = createCancellationSource();
    const tool = provider(
      (_, invokeCtx) =>
        new Promise((_, reject) => {
          invokeCtx!.cancellation.onCancelled(() =>
            reject(new InvokeError(ERR_INVOKE_CANCELLED, "tool cancelled")),
          );
          source.cancel("turn cancelled");
        }),
    );
    const buffered = await runBoth(toolThenAnswer, tool, source.context).then((r) => r.buffered);
    source = createCancellationSource();
    const streamed = await runBoth(toolThenAnswer, tool, source.context).then((r) => r.streamed);
    expect(buffered.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(streamed.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(streamed.parts.some((p) => p.type === "tool-result")).toBe(false);
  });

  it("rethrows a durable suspension from a tool, even under feedback", async () => {
    const suspension = Object.assign(new Error("parked"), { code: ERR_DURABLE_SUSPENDED });
    const { buffered, streamed } = await runBoth(
      toolThenAnswer,
      provider(async () => {
        throw suspension;
      }),
    );
    expect(buffered.error).toBe(suspension);
    expect(streamed.error).toBe(suspension);
    expect(streamed.parts.some((p) => p.type === "tool-result")).toBe(false);
  });

  it("still feeds a plain tool failure back as an error result", async () => {
    const { buffered, streamed } = await runBoth(
      toolThenAnswer,
      provider(async () => {
        throw new Error("disk full");
      }),
    );
    const expected = { name: "work", content: "Error: disk full", error: true };
    expect(buffered.result!.steps[0]!.toolResults[0]).toMatchObject(expected);
    expect(streamed.parts.find((p) => p.type === "tool-result")).toMatchObject({ toolResult: expected });
  });
});

describe("Ai.Tools", () => {
  it("passes the agent invocation's context into the tool's invocation", async () => {
    const received: Array<InvokeContext | undefined> = [];
    const tools = await createTools(
      {
        metadata: { name: "tools" },
        tools: [
          {
            tool: {
              invoke: async (_input: unknown, invokeCtx?: InvokeContext) => {
                received.push(invokeCtx);
                return {};
              },
            },
            name: "work",
            parameters: { type: "object" },
          },
        ],
      },
      ctx,
    );
    const source = createCancellationSource();
    await tools.callTool("work", {}, source.context);
    expect(received).toEqual([source.context]);
  });
});
