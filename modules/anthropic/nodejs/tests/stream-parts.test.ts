import { describe, expect, it, vi } from "vitest";
import type { AiModelStreamInstance, StreamPart } from "@telorun/ai";
import type { InvokeContext } from "@telorun/sdk";

import * as stream from "../src/messages-stream-controller.js";
import * as reader from "../src/messages-stream.js";

// The streaming kind: the request is built by the call and sent at the first
// pull, the endpoint's events come back as the contract's parts in order, and
// everything that goes wrong after the call returned rejects the iteration
// under one of the codes `Ai.ModelStream` declares.

const ASK = { messages: [{ role: "user", content: "weather in Paris?" }] };

const frame = (event: Record<string, unknown>) =>
  `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

/** A response body that records whether its reader let go of it early. */
function bodyOf(chunks: Array<string | Error>) {
  const state = { returned: false, returns: 0, pulled: 0 };
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          state.pulled++;
          if (index >= chunks.length) return { done: true, value: undefined };
          const chunk = chunks[index++]!;
          if (chunk instanceof Error) throw chunk;
          return { done: false, value: new TextEncoder().encode(chunk) };
        },
        async return() {
          state.returned = true;
          state.returns++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { body, state };
}

/** A streaming model over a request answering with `chunks`, or with the body
 *  given in their place. */
async function over(
  chunks: Array<string | Error>,
  answer: { status?: number; headers?: Record<string, string>; body?: unknown } = {},
  config: Record<string, unknown> = {},
) {
  const made = bodyOf(chunks);
  const { state } = made;
  const body = "body" in answer ? answer.body : made.body;
  const invoke = vi.fn(async (input: Record<string, unknown>, ctx?: InvokeContext) => ({
    status: answer.status ?? 200,
    headers: answer.headers ?? {},
    body,
  }));
  const model: AiModelStreamInstance = await stream.create(
    {
      metadata: { name: "T", module: "App" },
      model: "claude-test",
      maxTokens: 1024,
      request: { invoke },
      ...config,
    } as never,
    {} as never,
  );
  return { model, invoke, state };
}

/** Every part a call yields, then the error that ended it, if one did. */
async function drained(model: AiModelStreamInstance, input: Record<string, unknown> = ASK, ctx?: InvokeContext) {
  const parts: StreamPart[] = [];
  try {
    for await (const part of (await model.invoke(input as never, ctx)).output) parts.push(part);
  } catch (error) {
    return { parts, error: error as any };
  }
  return { parts, error: undefined as any };
}

const START = {
  type: "message_start",
  message: {
    type: "message",
    role: "assistant",
    content: [],
    usage: { input_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 },
  },
};
const text = (index: number, ...deltas: string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...deltas.map((delta) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: delta } })),
  { type: "content_block_stop", index },
];
const end = (stopReason: string, outputTokens = 9) => [
  { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
  { type: "message_stop" },
];

const THINKING_TOOL_TURN = [
  START,
  { type: "ping" },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Paris, " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "then." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index: 0 },
  ...text(1, "Let me ", "check."),
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"ci' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "an_event_added_later", anything: true },
  ...end("tool_use"),
];

describe("the parts of a streamed answer", () => {
  it("arrive in contract order, whatever the chunk boundaries", async () => {
    const wire = THINKING_TOOL_TURN.map(frame).join("");
    // Seven bytes at a time: no event arrives whole.
    const chunks = wire.match(/[\s\S]{1,7}/g)!;
    const { model, invoke } = await over(chunks, {}, { betas: ["beta-one"] });
    const { parts, error } = await drained(model);

    expect(error).toBeUndefined();
    expect(parts).toEqual([
      { type: "reasoning-delta", delta: "Paris, " },
      { type: "reasoning-delta", delta: "then." },
      { type: "text-delta", delta: "Let me " },
      { type: "text-delta", delta: "check." },
      { type: "tool-call-delta", toolCallId: "toolu_1", toolName: "get_weather", delta: '{"ci' },
      { type: "tool-call-delta", toolCallId: "toolu_1", toolName: "get_weather", delta: 'ty":"Paris"}' },
      { type: "tool-call", toolCall: { id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } } },
      {
        type: "provider-state",
        providerState: {
          api: "messages",
          model: "claude-test",
          resource: "App.T",
          content: [
            { type: "thinking", thinking: "Paris, then.", signature: "sig-1" },
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          promptTokens: 55,
          completionTokens: 9,
          totalTokens: 64,
          cachedPromptTokens: 20,
          cacheWritePromptTokens: 30,
        },
      },
    ]);

    const sent = invoke.mock.calls[0]![0] as Record<string, any>;
    expect(sent.responseType).toBe("stream");
    expect(sent.body.stream).toBe(true);
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.headers["anthropic-beta"]).toBe("beta-one");
  });

  it("carry no provider state for an answer of text and tool calls alone", async () => {
    const { model } = await over([[START, ...text(0, "pong"), ...end("end_turn")].map(frame).join("")]);
    const { parts } = await drained(model);
    expect(parts.map((part) => part.type)).toEqual(["text-delta", "finish"]);
  });

  it("name a call the endpoint gave no id, the same on its deltas and on the call", async () => {
    const { model } = await over([
      [
        START,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "get_weather", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        ...end("tool_use"),
      ]
        .map(frame)
        .join(""),
    ]);
    const { parts } = await drained(model);
    const delta = parts.find((part) => part.type === "tool-call-delta") as any;
    const call = parts.find((part) => part.type === "tool-call") as any;
    expect(delta.toolCallId).toMatch(/^call_[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(call.toolCall.id).toBe(delta.toolCallId);
  });

  it("report no call for a block the caller does not run, and carry its input whole", async () => {
    const { model } = await over([
      [
        START,
        { type: "content_block_start", index: 0, content_block: { type: "mcp_tool_use", id: "mcp_1", name: "search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"telo"}' } },
        { type: "content_block_stop", index: 0 },
        ...text(1, "found"),
        ...end("end_turn"),
      ]
        .map(frame)
        .join(""),
    ]);
    const { parts, error } = await drained(model);
    expect(error).toBeUndefined();
    expect(parts.slice(0, -1)).toEqual([
      { type: "text-delta", delta: "found" },
      {
        type: "provider-state",
        providerState: {
          api: "messages",
          model: "claude-test",
          resource: "App.T",
          content: [
            { type: "mcp_tool_use", id: "mcp_1", name: "search", input: { q: "telo" } },
            { type: "text", text: "found" },
          ],
        },
      },
    ]);
  });
});

describe("a call the request alone refuses", () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      "a part the API cannot carry",
      { messages: [{ role: "user", content: [{ type: "audio", mediaType: "audio/wav", data: "aGk=" }] }] },
      "ERR_MODEL_CONTENT_UNSUPPORTED",
    ],
    ["a response format", { ...ASK, responseFormat: { type: "json_object" } }, "ERR_MODEL_REQUEST_REJECTED"],
    ["a structural option", { ...ASK, options: { stream: false } }, "ERR_MODEL_REQUEST_REJECTED"],
  ])("rejects %s from the call, with nothing sent", async (what, input, code) => {
    const { model, invoke } = await over([]);
    await expect(model.invoke(input as never)).rejects.toMatchObject({ code });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects messages that are not a list as a request that could not be built", async () => {
    const { model, invoke } = await over([]);
    const error: any = await model.invoke({ messages: 5 } as never).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("what a stream holds open", () => {
  it("contacts the endpoint at the first pull, so a stream nobody reads opens nothing", async () => {
    const { model, invoke } = await over([frame(START)]);
    const { output } = await model.invoke(ASK as never);
    expect(invoke).not.toHaveBeenCalled();
    await output[Symbol.asyncIterator]().return?.();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets go of the body when the consumer stops reading", async () => {
    const { model, state } = await over([
      [START, ...text(0, "one")].map(frame).join(""),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "never read" } }),
    ]);
    for await (const part of (await model.invoke(ASK as never)).output) {
      expect(part).toEqual({ type: "text-delta", delta: "one" });
      break;
    }
    expect(state.returns).toBe(1);
    expect(state.pulled).toBe(1);
  });

  it("reads a refused response's explanation under a bound and lets go of the rest", async () => {
    const refusal = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    const { model, state } = await over(
      [refusal, "x".repeat(4096), "never read"],
      { status: 429, headers: { "retry-after": "7" } },
    );
    const { parts, error } = await drained(model);
    expect(parts).toEqual([]);
    expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED" });
    expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    expect(error.message).toContain("slow down");
    expect(state.returned).toBe(true);
    expect(state.pulled).toBe(2);
  });

  it("keeps the status failure when a refused response's body breaks, with the break as its cause", async () => {
    const refusal = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    const reset = new Error("socket hang up");
    const { model } = await over([refusal, reset], { status: 429, headers: { "retry-after": "7" } });
    const { parts, error } = await drained(model);
    expect(parts).toEqual([]);
    expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED", cause: reset });
    expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    expect(error.message).toContain("slow down");

    const abort = new Error("This operation was aborted");
    const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;
    const cancelled = await drained((await over(["half an expl", abort], { status: 429 })).model, ASK, aborted);
    expect(cancelled.error).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });
});

describe("a stream that fails after it began", () => {
  const begun = [START, ...text(0, "half an ans")].map(frame).join("");

  it.each([
    ["overloaded_error", "ERR_MODEL_UNAVAILABLE"],
    ["rate_limit_error", "ERR_MODEL_RATE_LIMITED"],
    ["authentication_error", "ERR_MODEL_ACCESS_DENIED"],
    ["invalid_request_error", "ERR_MODEL_REQUEST_REJECTED"],
    ["never_heard_of_it", "ERR_MODEL_UNAVAILABLE"],
  ])("classifies the error event %s as %s and lets go of the body", async (type, code) => {
    const { model, state } = await over([
      begun,
      frame({ type: "error", error: { type, message: "the vendor's words" } }),
      frame({ type: "message_stop" }),
    ]);
    const { parts, error } = await drained(model);
    expect(parts).toEqual([{ type: "text-delta", delta: "half an ans" }]);
    expect(error.code).toBe(code);
    expect(error.data).toEqual({});
    expect(error.message).toContain("the vendor's words");
    expect(state.returned).toBe(true);
  });

  it.each<[string, string[]]>([
    ["a frame that is not JSON", [begun, 'data: {"type": "content_block_de\n\n']],
    ["a frame that is not an object", [begun, "data: [1]\n\n"]],
    ["an event with no type", [begun, 'data: {"index": 0}\n\n']],
    ["a delta for a block never opened", [begun, frame({ type: "content_block_delta", index: 4, delta: {} })]],
    ["a frame over the bound", [begun, ...Array.from({ length: 5 }, () => `data: ${"x".repeat(250_000)}\n`)]],
    ["a line over the bound", [begun, "x".repeat((1 << 20) + 1)]],
    ["an end with neither a stop reason nor the closing event", [begun]],
    ["no events at all", []],
  ])("raises %s as a response that cannot be read", async (what, chunks) => {
    const { model } = await over(chunks);
    const { parts, error } = await drained(model);
    expect(parts.every((part) => part.type === "text-delta")).toBe(true);
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    expect(error.data).toBeUndefined();
  });

  it("raises a body that breaks as a response that cannot be read, keeping the cause", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { model } = await over([begun, reset]);
    const { parts, error } = await drained(model);
    expect(parts).toEqual([{ type: "text-delta", delta: "half an ans" }]);
    expect(error).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: reset });
  });

  it("raises an error of its own reading of the stream as a response that cannot be read", async () => {
    const fault = new Error("the reader broke");
    const reading = vi.spyOn(reader, "streamParts").mockImplementationOnce(async function* () {
      yield { type: "text-delta", delta: "half" };
      throw fault;
    });
    try {
      const { parts, error } = await drained((await over([begun])).model);
      expect(parts).toEqual([{ type: "text-delta", delta: "half" }]);
      expect(error).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: fault });
    } finally {
      reading.mockRestore();
    }
  });

  it("raises a refused response that cannot be read as a request not served", async () => {
    const broke = new Error("the body is gone");
    const invoke = async () => ({
      status: 500,
      headers: {},
      get body(): unknown {
        throw broke;
      },
    });
    const model = await stream.create(
      { metadata: { name: "T", module: "App" }, model: "claude-test", maxTokens: 1024, request: { invoke } } as never,
      {} as never,
    );
    const { error } = await drained(model);
    expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", cause: broke });
  });

  it("classifies a refused stream by status when the error's type is a member of every object", async () => {
    const refusal = JSON.stringify({ type: "error", error: { type: "constructor", message: "slow down" } });
    const { model } = await over([refusal], { status: 429, headers: { "retry-after": "7" } });
    const { error } = await drained(model);
    expect(error.code).toBe("ERR_MODEL_RATE_LIMITED");
    expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
  });

  it("passes a suspension that ends the body as it was raised", async () => {
    const parked = Object.assign(new Error("parked"), { code: "ERR_DURABLE_SUSPENDED" });
    const { parts, error } = await drained((await over([begun, parked])).model);
    expect(parts).toEqual([{ type: "text-delta", delta: "half an ans" }]);
    expect(error).toBe(parked);
  });

  it("keeps the caller's cancellation a cancellation", async () => {
    const source = new AbortController();
    const ctx = { cancellation: { signal: source.signal } } as unknown as InvokeContext;
    const abort = new Error("This operation was aborted");
    const { model } = await over([begun, abort]);
    const parts: StreamPart[] = [];
    let error: any;
    try {
      for await (const part of (await model.invoke(ASK as never, ctx)).output) {
        parts.push(part);
        source.abort();
      }
    } catch (err) {
      error = err;
    }
    expect(parts).toHaveLength(1);
    expect(error).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });

  it("raises a tool call whose streamed arguments are not JSON, naming the tool", async () => {
    const { model } = await over([
      [
        START,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "Par' } },
        { type: "content_block_stop", index: 0 },
        ...end("tool_use"),
      ]
        .map(frame)
        .join(""),
    ]);
    const { error } = await drained(model);
    expect(error).toMatchObject({ code: "ERR_MODEL_TOOL_ARGUMENTS_INVALID", data: { tool: "get_weather" } });
  });

  it("raises a refused status the endpoint answered without a readable body", async () => {
    const { model } = await over([], { status: 529 });
    const { error } = await drained(model);
    expect(error).toMatchObject({ code: "ERR_MODEL_UNAVAILABLE", data: { status: 529 } });
  });
});

describe("what completes a stream", () => {
  const [stopped, trailer] = end("end_turn", 9).map(frame) as [string, string];
  const answered = [START, ...text(0, "pong")].map(frame).join("");
  const openCall = (json: string) =>
    [
      START,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } },
    ]
      .map(frame)
      .join("");
  const toolStop = frame(end("tool_use")[0]!);

  it("finishes on the stop reason when the body ends cleanly without the trailer", async () => {
    const { model } = await over([answered, stopped]);
    const { parts, error } = await drained(model);
    expect(error).toBeUndefined();
    expect(parts).toEqual([
      { type: "text-delta", delta: "pong" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: 55,
          completionTokens: 9,
          totalTokens: 64,
          cachedPromptTokens: 20,
          cacheWritePromptTokens: 30,
        },
      },
    ]);
  });

  it("finishes 'other' on the trailer alone, never 'stop'", async () => {
    const { model } = await over([answered, trailer]);
    const { parts, error } = await drained(model);
    expect(error).toBeUndefined();
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "other" });
  });

  it("raises a body that breaks after the stop reason, and keeps a cancellation one", async () => {
    const broke = new Error("socket hang up");
    const first = await drained((await over([answered, stopped, broke])).model);
    expect(first.error).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: broke });
    expect(first.parts.map((part) => part.type)).toEqual(["text-delta"]);

    const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;
    const second = await drained((await over([answered, stopped, broke])).model, ASK, aborted);
    expect(second.error).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: broke });
  });

  it("lets an error event after the stop reason win over the answer", async () => {
    const { model } = await over([
      answered,
      stopped,
      frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ]);
    const { parts, error } = await drained(model);
    expect(error.code).toBe("ERR_MODEL_UNAVAILABLE");
    expect(parts.map((part) => part.type)).toEqual(["text-delta"]);
  });

  it.each([
    ["the stop reason and a clean end", [toolStop]],
    ["the trailer", [toolStop, trailer]],
  ])("closes a tool call still open at %s, when its arguments are whole", async (what, tail) => {
    const { model } = await over([openCall('{"city":"Paris"}'), ...tail]);
    const { parts, error } = await drained(model);
    expect(error).toBeUndefined();
    expect(parts.slice(1)).toEqual([
      { type: "tool-call", toolCall: { id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } } },
      expect.objectContaining({ type: "finish", finishReason: "tool-calls" }),
    ]);
  });

  it("raises a tool call still open with cut arguments, and emits no call", async () => {
    const { model } = await over([openCall('{"city": "Par'), toolStop]);
    const { parts, error } = await drained(model);
    expect(error).toMatchObject({ code: "ERR_MODEL_TOOL_ARGUMENTS_INVALID", data: { tool: "get_weather" } });
    expect(parts.map((part) => part.type)).toEqual(["tool-call-delta"]);
  });
});
