import type { InvokeContext, OpenSpanOptions, ResourceContext, SpanOutcome } from "@telorun/sdk";
import { UNCANCELLABLE_CONTEXT } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create as createAgent } from "../src/ai-agent-controller.js";
import { create as createAgentStream } from "../src/ai-agent-stream-controller.js";
import { create as createTools } from "../src/ai-tools-controller.js";
import type { AgentStreamPart, StreamPart } from "../src/types.js";

/**
 * The spans an agent run opens, and the tool dispatch nested under them. The
 * kernel's own half — parenting a span under its base context's span, exporting
 * it — is the kernel's test; this pins which spans `ai` opens, on which context,
 * with which attributes, and that a tool is dispatched on its `execute_tool`
 * span's context.
 */

interface RecordedSpan {
  id: number;
  label: string;
  parent: number | undefined;
  opened: Record<string, unknown>;
  outcome?: SpanOutcome;
  settled?: Record<string, unknown>;
}

function tracingContext() {
  const spans: RecordedSpan[] = [];
  const dispatched: Array<{ kind: string; name: string; parent: number | undefined }> = [];
  const records: Array<{ message: string; attributes: Record<string, unknown> }> = [];
  let next = 0;
  const ctx = {
    log: {
      info: (message: string, attributes: Record<string, unknown>) => void records.push({ message, attributes }),
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    expandValue: (value: unknown, scope: { arguments?: unknown; result?: unknown }) =>
      value === "RESULT" ? JSON.stringify(scope.result) : value,
    openSpan: async (base: InvokeContext | undefined, opts: OpenSpanOptions) => {
      const span: RecordedSpan = {
        id: ++next,
        label: opts.label ?? opts.ref.name,
        parent: base?.invocationId,
        opened: opts.attributes ?? {},
      };
      spans.push(span);
      return {
        context: { ...(base ?? UNCANCELLABLE_CONTEXT), invocationId: span.id },
        settle: async (outcome: SpanOutcome, detail?: { attributes?: Record<string, unknown> }) => {
          if (span.outcome) return;
          span.outcome = outcome;
          span.settled = detail?.attributes ?? {};
        },
      };
    },
    invokeResolved: (
      kind: string,
      name: string,
      instance: { invoke(input: unknown, c?: InvokeContext): Promise<unknown> },
      inputs: unknown,
      invokeCtx?: InvokeContext,
    ) => {
      dispatched.push({ kind, name, parent: invokeCtx?.invocationId });
      return instance.invoke(inputs, invokeCtx);
    },
  } as unknown as ResourceContext;
  return { ctx, spans, dispatched, records };
}

const USAGE = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
const RUN: InvokeContext = { ...UNCANCELLABLE_CONTEXT, invocationId: 100 };

/** One tool call, then an answer — as a buffered model and as a streaming one. */
function models() {
  let buffered = 0;
  let streamed = 0;
  const snapshot = () => ({ model: "echo-1" });
  return {
    buffered: {
      snapshot,
      async invoke() {
        const first = buffered++ === 0;
        return {
          content: [],
          text: first ? "" : "done",
          usage: USAGE,
          finishReason: first ? ("tool-calls" as const) : ("stop" as const),
          ...(first ? { toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] } : {}),
        };
      },
    },
    streaming: {
      snapshot,
      async invoke() {
        const first = streamed++ === 0;
        async function* parts(): AsyncIterable<StreamPart> {
          if (first) yield { type: "tool-call", toolCall: { id: "call-1", name: "lookup", arguments: {} } };
          else yield { type: "text-delta", delta: "done" };
          yield { type: "finish", usage: USAGE, finishReason: first ? "tool-calls" : "stop" };
        }
        return { output: parts() };
      },
    },
  };
}

async function toolsWith(ctx: ResourceContext, run: () => Promise<unknown>) {
  // No identity stamped by injection here, so the reference's own kind and name
  // (what the slot holds before injection) name the dispatch.
  const tool = { kind: "Run.Value", name: "lookupValue", invoke: run };
  return createTools(
    {
      metadata: { name: "tools" },
      tools: [{ tool, name: "lookup", parameters: { type: "object" }, result: "RESULT" }],
    },
    ctx,
  );
}

async function runStream(ctx: ResourceContext, tools: Awaited<ReturnType<typeof toolsWith>>) {
  const agent = await createAgentStream(
    { metadata: { name: "author" }, model: models().streaming, toolProviders: [{ provider: tools }] },
    ctx,
  );
  const { output } = await agent.invoke({ prompt: "go" }, RUN);
  const parts: AgentStreamPart[] = [];
  for await (const part of output) parts.push(part);
  return parts;
}

describe("agent spans", () => {
  for (const mode of ["buffered", "streaming"] as const) {
    it(`opens invoke_agent, chat and execute_tool spans and dispatches the tool under its span (${mode})`, async () => {
      const { ctx, spans, dispatched, records } = tracingContext();
      const tools = await toolsWith(ctx, async () => ({ found: true }));
      if (mode === "streaming") {
        await runStream(ctx, tools);
      } else {
        const agent = await createAgent(
          { metadata: { name: "author" }, model: models().buffered, toolProviders: [{ provider: tools }] },
          ctx,
        );
        // One `steps` entry per model call, which is what the span counts.
        expect((await agent.invoke({ prompt: "go" }, RUN)).steps).toHaveLength(2);
      }

      const [run, firstChat, tool, secondChat] = spans;
      expect(spans.map((s) => s.label)).toEqual([
        "invoke_agent author",
        "chat echo-1",
        "execute_tool lookup",
        "chat echo-1",
      ]);
      expect(run).toMatchObject({
        parent: 100,
        outcome: "ok",
        settled: {
          "ai.agent.steps": 2,
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 4,
        },
      });
      for (const chat of [firstChat, secondChat]) {
        expect(chat).toMatchObject({
          parent: run!.id,
          opened: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "echo-1" },
          outcome: "ok",
          settled: { "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 2 },
        });
      }
      expect(firstChat!.settled!["gen_ai.response.finish_reasons"]).toEqual(["tool-calls"]);
      expect(tool).toMatchObject({
        parent: run!.id,
        opened: { "gen_ai.tool.name": "lookup", "gen_ai.tool.call.id": "call-1" },
        outcome: "ok",
      });
      expect(dispatched).toEqual([{ kind: "Run.Value", name: "lookupValue", parent: tool!.id }]);
      // A step is one model call, on the finished record as on the span.
      expect(records.find((r) => / finished$/.test(r.message))?.attributes["ai.agent.steps"]).toBe(2);
    });
  }

  it("ends the run and its first model call as cancelled when the stream is cancelled before any read", async () => {
    const { ctx, spans } = tracingContext();
    let modelStreamCancelled = false;
    const model = {
      snapshot: () => ({ model: "echo-1" }),
      async invoke() {
        const output: AsyncIterableIterator<StreamPart> = {
          [Symbol.asyncIterator]: () => output,
          next: async () => ({ done: false, value: { type: "text-delta", delta: "unread" } }),
          return: async () => {
            modelStreamCancelled = true;
            return { done: true, value: undefined };
          },
        };
        return { output };
      },
    };
    const agent = await createAgentStream({ metadata: { name: "author" }, model }, ctx);
    const { output } = await agent.invoke({ prompt: "go" }, RUN);

    await output[Symbol.asyncIterator]().return?.();

    const reason = { "telo.cancellation.reason": "the stream's consumer stopped reading" };
    expect(spans.map((s) => [s.label, s.outcome])).toEqual([
      ["invoke_agent author", "cancelled"],
      ["chat echo-1", "cancelled"],
    ]);
    for (const span of spans) expect(span.settled).toMatchObject(reason);
    expect(modelStreamCancelled).toBe(true);
  });

  it("ends a failed tool call's span with its error type", async () => {
    const { ctx, spans } = tracingContext();
    const tools = await toolsWith(ctx, async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    await runStream(ctx, tools);
    expect(spans.find((s) => s.label === "execute_tool lookup")).toMatchObject({
      outcome: "failed",
      settled: { "error.type": "ENOENT" },
    });
  });
});
