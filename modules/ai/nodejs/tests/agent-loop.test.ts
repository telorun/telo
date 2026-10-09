import type { CancellationSource, InvokeContext } from "@telorun/sdk";
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
} from "../src/types.js";
import {
  USAGE,
  ctx,
  drain,
  provider,
  runBoth,
  streamingModel,
  type CallPlan,
  type Seen,
} from "./scripted-agents.js";

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
    expect(parts.map((p) => p.type)).toEqual([
      "tool-call",
      "step-finish",
      "message",
      "tool-result",
      "message",
      "text-delta",
    ]);
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

  it("ends the first model call's stream when the turn is cancelled before the first read", async () => {
    let ended = 0;
    const output: AsyncIterable<StreamPart> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: async () => {
          ended += 1;
          return { done: true, value: undefined };
        },
      }),
    };
    const agent = await createAgentStream(
      { metadata: { name: "stream" }, model: { invoke: async () => ({ output }) } },
      ctx,
    );
    const source = createCancellationSource();
    const run = await agent.invoke({ prompt: "go" }, source.context);
    source.cancel("turn cancelled");
    const { parts, error } = await drain(run.output);
    expect(error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(parts).toEqual([]);
    expect(ended).toBe(1);
  });

  it("gives Ai.Agent's first model call the input provider state, and returns the last one a call produced, else the input one, else none", async () => {
    /** One model call per entry of `produced`, each returning that state (or
     *  none); every call but the last asks for the tool. */
    const run = async (produced: unknown[], input?: unknown) => {
      const seen: unknown[] = [];
      const agent = await createAgent(
        {
          metadata: { name: "agent" },
          model: {
            async invoke(request: ModelInvokeInput): Promise<CompletionResult> {
              const state = produced[seen.length];
              seen.push(request.providerState);
              const last = seen.length === produced.length;
              return {
                content: [],
                text: last ? "done" : "",
                usage: USAGE,
                finishReason: last ? "stop" : "tool-calls",
                ...(last ? {} : { toolCalls: [{ id: "", name: "work", arguments: {} }] }),
                ...(state === undefined ? {} : { providerState: state }),
              };
            },
          },
          toolProviders: [{ provider: provider(async () => "ok") }],
        },
        ctx,
      );
      const result = await agent.invoke({
        prompt: "go",
        ...(input === undefined ? {} : { providerState: input }),
      });
      return { seen, result };
    };

    // A call that returns none leaves the last one produced in place.
    const kept = await run(["s1", undefined, undefined], "in");
    expect(kept.seen).toEqual(["in", "s1", "s1"]);
    expect(kept.result.providerState).toBe("s1");

    const fromInput = await run([undefined], "in");
    expect(fromInput.result.providerState).toBe("in");

    const none = await run([undefined]);
    expect(none.seen).toEqual([undefined]);
    expect(none.result).not.toHaveProperty("providerState");
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
        buffered: [bufferedStep.toolCalls[0]!.id, replayed(bufferedSeen), buffered.result!.toolResults[0]!.toolCallId],
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
    expect(buffered.result!.toolResults[0]).toMatchObject(expected);
    expect(streamed.parts.find((p) => p.type === "tool-result")).toMatchObject({ toolResult: expected });
  });

  it("bounds a failed tool's error result by maxToolResultBytes in both agents", async () => {
    const { buffered, bufferedSeen, streamed, streamSeen } = await runBoth(
      toolThenAnswer,
      provider(async () => {
        throw new Error("disk full");
      }),
      undefined,
      9,
    );
    const content =
      "Error: di\n[truncated: 7 of 16 bytes cut; a tool result passes at most 9 bytes to the model]";
    const fed = (seen: Seen) => seen.inputs[1]!.messages.find((m: Message) => m.role === "tool")!.content;
    expect(buffered.result!.toolResults[0]).toMatchObject({ content, error: true });
    expect(streamed.parts.find((p) => p.type === "tool-result")).toMatchObject({
      toolResult: { content, error: true },
    });
    expect([fed(bufferedSeen), fed(streamSeen)]).toEqual([content, content]);
  });

  it("carries what a provider's tool returned as the stream part's output, and none on an error", async () => {
    // A provider with only `callTool` (an MCP provider is one) has one value for
    // both what the model sees and what the tool returned.
    const returned = { path: "a.yaml", checkExitCode: 0 };
    const ok = await runBoth(toolThenAnswer, provider(async () => returned));
    const failed = await runBoth(
      toolThenAnswer,
      provider(async () => {
        throw new Error("disk full");
      }),
    );
    const resultOf = (parts: AgentStreamPart[]) =>
      parts.find((p): p is Extract<AgentStreamPart, { type: "tool-result" }> => p.type === "tool-result")!
        .toolResult;
    expect(resultOf(ok.streamed.parts)).toEqual({
      toolCallId: expect.stringMatching(/^call_/),
      name: "work",
      content: JSON.stringify(returned),
      output: returned,
    });
    expect(resultOf(failed.streamed.parts)).not.toHaveProperty("output");
    // The buffered trace keeps the record the model saw.
    expect(ok.buffered.result!.toolResults[0]).not.toHaveProperty("output");
  });
});

/** Two calls in one response: `first`, asked for first, then `second`. */
const twoTools: CallPlan[] = [
  {
    tools: [
      { name: "work", id: "first", args: { role: "first" } },
      { name: "work", id: "second", args: { role: "second" } },
    ],
  },
  { answer: "done" },
];

/** `first` completes only once `second` has started, and fails if it has not
 *  within a moment — so it completes exactly when the two run side by side. */
function barrier(): AiToolProviderInstance {
  let secondStarted: (() => void) | undefined;
  return provider(async (args) => {
    if (args.role === "second") {
      secondStarted?.();
      return "second ran";
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second never started")), 40);
      secondStarted = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return "first ran";
  });
}

/** `first` finishes after a moment unless it is cancelled, counting each
 *  cancellation it observes; `second` fails at once. */
function failingBesideSlow(): AiToolProviderInstance & { cancellations: number } {
  const tool = provider(async (args, invokeCtx) => {
    if (args.role === "second") throw new Error("disk full");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("first ran"), 20);
      invokeCtx!.cancellation.onCancelled(() => {
        clearTimeout(timer);
        tool.cancellations += 1;
        reject(new InvokeError(ERR_INVOKE_CANCELLED, "tool cancelled"));
      });
    });
  }) as AiToolProviderInstance & { contexts: Array<InvokeContext | undefined>; cancellations: number };
  tool.cancellations = 0;
  return tool;
}

/** Both calls wait to be cancelled, counting each cancellation observed; the
 *  second cancels `source` once it has started, when both are running. */
function cancellingOnceBothRun(source: CancellationSource): AiToolProviderInstance & { cancellations: number } {
  const tool = provider(
    (args, invokeCtx) =>
      new Promise((resolve, reject) => {
        invokeCtx!.cancellation.onCancelled(() => {
          tool.cancellations += 1;
          reject(new InvokeError(ERR_INVOKE_CANCELLED, "tool cancelled"));
        });
        if (args.role === "second") source.cancel("turn cancelled");
      }),
  ) as AiToolProviderInstance & { contexts: Array<InvokeContext | undefined>; cancellations: number };
  tool.cancellations = 0;
  return tool;
}

const toolResultsOf = (parts: AgentStreamPart[]) =>
  parts
    .filter((p): p is Extract<AgentStreamPart, { type: "tool-result" }> => p.type === "tool-result")
    .map((p) => p.toolResult);

const toolMessageIds = (seen: Seen) =>
  seen.inputs[1]!.messages.filter((m: Message) => m.role === "tool").map((m) => m.toolCallId);

describe("the tool calls of one model response", () => {
  it("run side by side by default, and one at a time under maxParallelTools: 1", async () => {
    const parallel = await runBoth(twoTools, barrier());
    expect(parallel.buffered.result!.toolResults.find((r) => r.toolCallId === "first")).toMatchObject({
      content: "first ran",
    });
    expect(toolResultsOf(parallel.streamed.parts).find((r) => r.toolCallId === "first")).toMatchObject({
      content: "first ran",
    });

    const serial = await runBoth(twoTools, barrier(), undefined, undefined, { maxParallelTools: 1 });
    const timedOut = { toolCallId: "first", content: "Error: second never started", error: true };
    expect(serial.buffered.result!.toolResults[0]).toMatchObject(timedOut);
    expect(toolResultsOf(serial.streamed.parts)[0]).toMatchObject(timedOut);
  });

  it("report in completion order and reach the next model call in call order", async () => {
    const { buffered, bufferedSeen, streamed, streamSeen } = await runBoth(twoTools, barrier());
    expect(toolResultsOf(streamed.parts).map((r) => r.toolCallId)).toEqual(["second", "first"]);
    expect(toolMessageIds(streamSeen)).toEqual(["first", "second"]);
    expect(toolMessageIds(bufferedSeen)).toEqual(["first", "second"]);
    // Recorded as they land, like their tool messages.
    expect(buffered.result!.toolResults.map((r) => r.toolCallId)).toEqual(["second", "first"]);
    expect(buffered.result!.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual([
      "second",
      "first",
    ]);
  });

  it("cancel the running sibling and reject with the first failure under onToolError: throw", async () => {
    const tool = failingBesideSlow();
    const { buffered, streamed } = await runBoth(twoTools, tool, undefined, undefined, {
      onToolError: "throw",
    });
    expect(buffered.error).toMatchObject({ message: "disk full" });
    expect(streamed.error).toMatchObject({ message: "disk full" });
    // Once per agent.
    expect(tool.cancellations).toBe(2);
  });

  it("let the sibling finish when a failure is fed back", async () => {
    const tool = failingBesideSlow();
    const { buffered, streamed } = await runBoth(twoTools, tool);
    const expected = [
      { toolCallId: "first", content: "first ran" },
      { toolCallId: "second", content: "Error: disk full", error: true },
    ];
    expect(buffered.result!.toolResults).toMatchObject([expected[1], expected[0]]);
    expect(toolResultsOf(streamed.parts)).toMatchObject([expected[1], expected[0]]);
    expect(tool.cancellations).toBe(0);
  });

  it("are all cancelled when the turn is cancelled", async () => {
    // Each agent runs on a source of its own: one already cancelled would end
    // the run before any tool started.
    const bufferedSource = createCancellationSource();
    const bufferedTool = cancellingOnceBothRun(bufferedSource);
    const { buffered } = await runBoth(twoTools, bufferedTool, bufferedSource.context);
    expect(buffered.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(bufferedTool.cancellations).toBe(2);

    const streamSource = createCancellationSource();
    const streamTool = cancellingOnceBothRun(streamSource);
    const stream = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel(twoTools, { inputs: [] }),
        toolProviders: [{ provider: streamTool }],
      },
      ctx,
    );
    const streamed = await drain((await stream.invoke({ prompt: "go" }, streamSource.context)).output);
    expect(streamed.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(streamTool.cancellations).toBe(2);
  });

  it("fail the run as a contract violation when two share an id, before either runs", async () => {
    const tool = provider(async () => "ok");
    const { buffered, streamed } = await runBoth(
      [{ tools: [{ name: "work", id: "x" }, { name: "work", id: "x" }] }, { answer: "done" }],
      tool,
    );
    expect(buffered.error).toMatchObject({ code: "ERR_CONTRACT_VIOLATION" });
    expect(streamed.error).toMatchObject({ code: "ERR_CONTRACT_VIOLATION" });
    expect(tool.contexts).toEqual([]);
  });
});

describe("a tool call's argument deltas", () => {
  it("fail the run as a contract violation when one names no call id", async () => {
    const agent = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: {
          async invoke() {
            async function* parts(): AsyncIterable<StreamPart> {
              yield { type: "tool-call-delta", toolCallId: "", toolName: "work", delta: "{}" };
              yield { type: "tool-call", toolCall: { id: "", name: "work", arguments: {} } };
              yield { type: "finish", usage: USAGE, finishReason: "tool-calls" };
            }
            return { output: parts() };
          },
        },
        toolProviders: [{ provider: provider(async () => "ok") }],
      },
      ctx,
    );
    const { output } = await agent.invoke({ prompt: "go" });
    const { parts, error } = await drain(output);
    expect(error).toMatchObject({ code: "ERR_CONTRACT_VIOLATION" });
    expect(parts).toEqual([]);
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
