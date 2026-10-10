import { describe, expect, it, vi } from "vitest";
import type { StreamPart } from "@telorun/ai";
import { InvokeError, type InvokeContext } from "@telorun/sdk";

import * as shape from "../src/openai-answer-shape.js";
import * as chat from "../src/openai-chat-controller.js";
import * as responses from "../src/openai-responses-controller.js";

// Everything a language kind raises is one of the codes `Ai.Model` declares:
// a refused status, the vendor's own error wherever it is readable, a rejection
// of the injected request, an answer that cannot be read, and a stream that
// fails or stops short. The stub is the injected `Http.Request`.

const MESSAGES = [{ role: "user" as const, content: "hi" }];

type Invoke = (input: Record<string, unknown>, ctx?: InvokeContext) => Promise<unknown>;

const KINDS = ["chat", "chatStream", "responses", "responsesStream"] as const;
type Kind = (typeof KINDS)[number];
const STREAMS: Kind[] = ["chatStream", "responsesStream"];
const BUFFERED: Kind[] = ["chat", "responses"];

const create: Record<Kind, (resource: never, ctx: never) => Promise<{ invoke: Function }>> = {
  chat: chat.create,
  chatStream: chat.createStream,
  responses: responses.create,
  responsesStream: responses.createStream,
};

const isStream = (kind: Kind) => STREAMS.includes(kind);

/** What a call ends in: its answer (a stream's parts, drained) or the error it
 *  raised, from the call or from the iteration. */
async function outcome(kind: Kind, invoke: Invoke, ctx?: InvokeContext): Promise<any> {
  const model = await create[kind](
    { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
    {} as never,
  );
  try {
    const result = await model.invoke({ messages: MESSAGES }, ctx);
    if (!isStream(kind)) return result;
    const parts: StreamPart[] = [];
    for await (const part of result.output as AsyncIterable<StreamPart>) parts.push(part);
    return parts;
  } catch (err) {
    return err;
  }
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** A chunk handed over exactly as given, where text is handed over as bytes. */
type Raw = { raw: unknown };

/** A body the request controller hands over under `responseType: stream`, with
 *  what became of it recorded. */
function streamBody(chunks: Array<string | Error | Raw>, endless?: string) {
  const state = { pulled: 0, returned: false, returns: 0, destroyed: false, destroys: 0 };
  const body = {
    destroy: () => {
      state.destroyed = true;
      state.destroys++;
    },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          state.pulled++;
          if (index < chunks.length) {
            const chunk = chunks[index++]!;
            if (chunk instanceof Error) throw chunk;
            return { done: false as const, value: typeof chunk === "string" ? bytes(chunk) : chunk.raw };
          }
          if (endless !== undefined) return { done: false as const, value: bytes(endless) };
          return { done: true as const, value: undefined };
        },
        async return() {
          state.returned = true;
          state.returns++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  return { body, state };
}

/** A stream kind's parts, then the error that ended the iteration, if one did. */
async function drained(kind: Kind, invoke: Invoke, ctx?: InvokeContext) {
  const model = await create[kind](
    { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
    {} as never,
  );
  const parts: StreamPart[] = [];
  try {
    const { output } = await model.invoke({ messages: MESSAGES }, ctx);
    for await (const part of output as AsyncIterable<StreamPart>) parts.push(part);
  } catch (error) {
    return { parts, error: error as any };
  }
  return { parts, error: undefined as any };
}

const frames = (...payloads: unknown[]) =>
  payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("");

/** A refused response as each kind receives one: text when buffered, an unread
 *  stream when streamed. */
function refused(kind: Kind, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const streamed = streamBody([text]);
  return {
    response: { status, headers, body: isStream(kind) ? streamed.body : text },
    state: streamed.state,
  };
}

const vendor = (code?: string, type?: string, message = "the vendor's words") => ({
  error: { message, ...(code ? { code } : {}), ...(type ? { type } : {}) },
});

const CHAT_STREAM_OK = frames(
  { choices: [{ delta: { content: "hel" } }] },
  { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
  "[DONE]",
);
const RESPONSES_STREAM_OK = frames(
  { type: "response.output_text.delta", delta: "hello" },
  { type: "response.completed", response: { status: "completed", usage: {} } },
);
const firstDelta: Record<string, string> = {
  chatStream: frames({ choices: [{ delta: { content: "hel" } }] }),
  responsesStream: frames({ type: "response.output_text.delta", delta: "hel" }),
};

describe("a refused status", () => {
  it.each(KINDS)("%s reports a rate limit with the wait the endpoint asked for", async (kind) => {
    const { response } = refused(kind, 429, vendor(undefined, undefined, "slow down"), {
      "retry-after": "7",
    });
    const error = await outcome(kind, async () => response);
    expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED" });
    expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    expect(error.message).toContain("slow down");
  });

  it.each([
    [429, vendor("insufficient_quota"), "ERR_MODEL_QUOTA_EXCEEDED"],
    [400, vendor("context_length_exceeded"), "ERR_MODEL_CONTEXT_TOO_LONG"],
    [400, vendor(undefined, "content_policy_violation"), "ERR_MODEL_CONTENT_REFUSED"],
    [400, vendor("moderation_blocked"), "ERR_MODEL_CONTENT_REFUSED"],
    [403, vendor("rate_limit_exceeded"), "ERR_MODEL_RATE_LIMITED"],
    [400, vendor("model_not_found"), "ERR_MODEL_REQUEST_REJECTED"],
    // A family never overrides the status: this 401 is an access failure.
    [401, vendor("something_unlisted", "invalid_request_error"), "ERR_MODEL_ACCESS_DENIED"],
    [404, vendor(undefined, "api_error"), "ERR_MODEL_REQUEST_REJECTED"],
    [503, "upstream connect error", "ERR_MODEL_UNAVAILABLE"],
    [302, "", "ERR_MODEL_REQUEST_REJECTED"],
  ])("%i with %j is %s, on either dialect", async (status, body, code) => {
    for (const kind of BUFFERED) {
      const error = await outcome(kind, async () => refused(kind, status, body).response);
      expect(error).toMatchObject({ code, data: { status } });
    }
  });

  it.each(KINDS)("%s classifies by status when the error's name is a member of every object", async (kind) => {
    for (const error of [vendor("constructor"), vendor(undefined, "toString"), vendor("__proto__")]) {
      const { response } = refused(kind, 429, error, { "retry-after": "7" });
      const raised = await outcome(kind, async () => response);
      expect(raised.code).toBe("ERR_MODEL_RATE_LIMITED");
      expect(raised.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    }
  });

  it.each(KINDS)("%s raises a refused response that cannot be read as a request not served", async (kind) => {
    const broke = new Error("the body is gone");
    const response = {
      status: 500,
      headers: {},
      get body(): unknown {
        throw broke;
      },
    };
    expect(await outcome(kind, async () => response)).toMatchObject({
      code: "ERR_MODEL_REQUEST_REJECTED",
      cause: broke,
    });
  });

  it.each(STREAMS)(
    "%s reads a refused stream's explanation under a bound and releases the body",
    async (kind) => {
      const endless = streamBody([JSON.stringify(vendor("invalid_api_key")).slice(0, 20)], "x".repeat(1024));
      const error = await outcome(kind, async () => ({ status: 401, headers: {}, body: endless.body }));
      expect(error).toMatchObject({ code: "ERR_MODEL_ACCESS_DENIED", data: { status: 401 } });
      expect(endless.state.pulled).toBeLessThan(6);
      expect(endless.state.destroyed).toBe(true);
    },
  );

  it.each(STREAMS)(
    "%s keeps the status failure when a refused stream's body breaks, with the break as its cause",
    async (kind) => {
      const reset = new Error("socket hang up");
      const broken = streamBody([JSON.stringify(vendor(undefined, undefined, "slow down")), reset]);
      const refusal = async () => ({ status: 429, headers: { "retry-after": "7" }, body: broken.body });
      const error = await outcome(kind, refusal);
      expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED", cause: reset });
      expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
      expect(error.message).toContain("slow down");
      expect(broken.state.destroys).toBe(1);

      const abort = new Error("This operation was aborted");
      const cancelled = streamBody(["half an expl", abort]);
      const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;
      expect(
        await outcome(kind, async () => ({ status: 429, headers: {}, body: cancelled.body }), aborted),
      ).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
      expect(cancelled.state.destroys).toBe(1);
    },
  );
});

describe("a rejection of the injected request", () => {
  const network = (code: string) =>
    Object.assign(new Error("fetch failed"), { error: "NetworkError", code });
  const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;

  it.each(KINDS)("%s classifies each rejection, keeping the original as its cause", async (kind) => {
    const rejects = (err: unknown, ctx?: InvokeContext) =>
      outcome(
        kind,
        async () => {
          throw err;
        },
        ctx,
      );

    const classifier = new InvokeError("ERR_HTTP_CLASSIFIER_INVALID", "'success' must resolve");
    const unserved = await rejects(classifier);
    expect(unserved).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(unserved.cause).toBe(classifier);
    expect(unserved.message).toContain("[ERR_HTTP_CLASSIFIER_INVALID] 'success' must resolve");

    expect(await rejects(new Error("boom"))).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED" });
    expect(await rejects(new InvokeError("ERR_INVALID_CREDENTIAL", "empty key"))).toMatchObject({
      code: "ERR_MODEL_ACCESS_DENIED",
      data: {},
    });

    const timeout = network("TIMEOUT");
    expect(await rejects(timeout)).toMatchObject({ code: "ERR_MODEL_TIMEOUT", cause: timeout });
    for (const code of ["CONNECTION_REFUSED", "DNS_RESOLUTION_FAILED", "SSL_ERROR"]) {
      const unreachable = await rejects(network(code));
      expect(unreachable.code).toBe("ERR_MODEL_UNREACHABLE");
      expect(unreachable.data).toBeUndefined();
    }

    // The request's own `throwOnHttpError`: the same codes from its status and
    // body, without the wait a header would have named.
    const quota = await rejects(
      new InvokeError("ERR_HTTP_STATUS", "HTTP 429", {
        status: 429,
        body: JSON.stringify(vendor("insufficient_quota")),
      }),
    );
    expect(quota).toMatchObject({ code: "ERR_MODEL_QUOTA_EXCEEDED", data: { status: 429 } });
    const limited = await rejects(new InvokeError("ERR_HTTP_STATUS", "HTTP 429", { status: 429 }));
    expect(limited.code).toBe("ERR_MODEL_RATE_LIMITED");
    expect(limited.data).toEqual({ status: 429 });
    expect(await rejects(new InvokeError("ERR_HTTP_STATUS", "HTTP ?", {}))).toMatchObject({
      code: "ERR_MODEL_REQUEST_REJECTED",
      data: {},
    });

    // What is not a model failure is never re-coded.
    for (const passes of [
      new InvokeError("ERR_INPUT_INVALID", "inputs"),
      new InvokeError("ERR_INVOKE_CANCELLED", "cancelled"),
      Object.assign(new Error("parked"), { code: "ERR_DURABLE_SUSPENDED" }),
      new InvokeError("ERR_MODEL_TIMEOUT", "already classified"),
    ]) {
      expect(await rejects(passes)).toBe(passes);
    }

    const abort = new Error("This operation was aborted");
    const cancelled = await rejects(abort, aborted);
    expect(cancelled).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });

  it.each(KINDS)("%s asks for the body undecoded", async (kind) => {
    const invoke = vi.fn(async (input: Record<string, unknown>) => refused(kind, 500, "").response);
    await outcome(kind, invoke);
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      responseType: isStream(kind) ? "stream" : "text",
    });
  });
});

describe("a success the endpoint did not make good on", () => {
  const ok = (body: string) => async () => ({ status: 200, headers: {}, body });

  it.each(BUFFERED)("%s refuses a body that is not the answer", async (kind) => {
    const bodies = ['{"choices": [{"mess', "<html>bad gateway</html>", "[]", "", "{}"];
    for (const body of bodies) {
      const error = await outcome(kind, ok(body));
      expect(error.code, body).toBe("ERR_MODEL_RESPONSE_INVALID");
      expect(error.data).toBeUndefined();
    }
  });

  it("refuses a responses answer with no output list", async () => {
    const error = await outcome("responses", ok(JSON.stringify({ status: "completed" })));
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
  });

  it.each(BUFFERED)("%s classifies an error object in a success body by what it names", async (kind) => {
    const answer = { choices: [{ message: { content: "ignored" } }], output: [] };
    const limited = await outcome(kind, ok(JSON.stringify({ ...answer, ...vendor("rate_limit_exceeded") })));
    expect(limited.code).toBe("ERR_MODEL_RATE_LIMITED");
    expect(limited.data).toEqual({});
    const family = await outcome(kind, ok(JSON.stringify(vendor(undefined, "authentication_error"))));
    expect(family.code).toBe("ERR_MODEL_ACCESS_DENIED");
    const unknown = await outcome(kind, ok(JSON.stringify(vendor("never_heard_of_it"))));
    expect(unknown.code).toBe("ERR_MODEL_UNAVAILABLE");
  });

  it("classifies a failed run by its error, and as unavailable when it gives none", async () => {
    const run = (error: unknown) => ok(JSON.stringify({ status: "failed", error, output: [] }));
    expect(await outcome("responses", run({ code: "invalid_api_key", message: "bad key" }))).toMatchObject({
      code: "ERR_MODEL_ACCESS_DENIED",
      data: {},
    });
    expect((await outcome("responses", run(null))).code).toBe("ERR_MODEL_UNAVAILABLE");
  });

  it("raises a tool call whose arguments are not a JSON object under its own code", async () => {
    const answer = {
      choices: [
        {
          message: { tool_calls: [{ id: "c1", function: { name: "lookup", arguments: "[1" } }] },
          finish_reason: "tool_calls",
        },
      ],
    };
    expect(await outcome("chat", ok(JSON.stringify(answer)))).toMatchObject({
      code: "ERR_MODEL_TOOL_ARGUMENTS_INVALID",
      data: { tool: "lookup" },
    });
  });
});

describe("a stream that fails or stops short", () => {
  const streaming = (text: string | Array<string | Error>) => {
    const made = streamBody(Array.isArray(text) ? text : [text]);
    return { ...made, invoke: async () => ({ status: 200, headers: {}, body: made.body }) };
  };

  it.each(STREAMS)("%s sends nothing until the stream is first read", async (kind) => {
    const invoke = vi.fn(async () => ({ status: 200, headers: {}, body: streamBody([]).body }));
    const model = await create[kind](
      { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
      {} as never,
    );
    await model.invoke({ messages: MESSAGES });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(STREAMS)("%s releases the transport when its consumer stops early", async (kind) => {
    const { invoke, state } = streaming([
      firstDelta[kind]!,
      kind === "chatStream" ? CHAT_STREAM_OK : RESPONSES_STREAM_OK,
    ]);
    const model = await create[kind](
      { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
      {} as never,
    );
    const { output } = await model.invoke({ messages: MESSAGES });
    for await (const part of output as AsyncIterable<StreamPart>) {
      expect(part.type).toBe("text-delta");
      break;
    }
    expect(state.returns).toBe(1);
    expect(state.pulled).toBe(1);
  });

  it.each(STREAMS)("%s refuses an answer cut before its terminal event", async (kind) => {
    const error = await outcome(kind, streaming(firstDelta[kind]!).invoke);
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
  });

  it.each(STREAMS)("%s refuses a malformed frame and an oversized one", async (kind) => {
    const malformed = await outcome(kind, streaming(firstDelta[kind]! + "data: {not json\n\n").invoke);
    expect(malformed.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    const oversized = streaming(["data: ", "x".repeat(1 << 19), "x".repeat(1 << 19), "x".repeat(8)]);
    const error = await outcome(kind, oversized.invoke);
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    expect(oversized.state.returned).toBe(true);
  });

  it.each(STREAMS)("%s reports a body that breaks mid-stream, and a cancellation as one", async (kind) => {
    const reset = new Error("socket hang up");
    const broken = await outcome(kind, streaming([firstDelta[kind]!, reset]).invoke);
    expect(broken).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: reset });

    const source = new AbortController();
    const ctx = { cancellation: { signal: source.signal } } as unknown as InvokeContext;
    const abort = new Error("This operation was aborted");
    const made = streamBody([firstDelta[kind]!, abort]);
    const cancelled = await outcome(
      kind,
      async () => {
        source.abort();
        return { status: 200, headers: {}, body: made.body };
      },
      ctx,
    );
    expect(cancelled).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });

  it("classifies an error frame of a chat stream, after the parts before it", async () => {
    const { invoke } = streaming(
      frames({ choices: [{ delta: { content: "hel" } }] }, vendor("rate_limit_exceeded"), "[DONE]"),
    );
    const model = await chat.createStream(
      { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
      {} as never,
    );
    const seen: StreamPart[] = [];
    const error = await (async () => {
      for await (const part of (await model.invoke({ messages: MESSAGES })).output) seen.push(part);
    })().catch((err: unknown) => err);
    expect(seen).toEqual([{ type: "text-delta", delta: "hel" }]);
    expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED", data: {} });
  });

  it.each([
    [{ type: "error", code: "rate_limit_exceeded", message: "slow" }, "ERR_MODEL_RATE_LIMITED"],
    [{ type: "error", error: { type: "invalid_request_error" } }, "ERR_MODEL_REQUEST_REJECTED"],
    [
      { type: "response.failed", response: { status: "failed", error: { code: "server_error" } } },
      "ERR_MODEL_UNAVAILABLE",
    ],
    [{ type: "response.failed", response: { status: "failed" } }, "ERR_MODEL_UNAVAILABLE"],
  ])("classifies the responses stream event %j as %s", async (event, code) => {
    const error = await outcome("responsesStream", streaming(firstDelta.responsesStream! + frames(event)).invoke);
    expect(error.code).toBe(code);
  });

  it("finishes `other` when a chat stream reaches [DONE] with no finish reason", async () => {
    const parts = await outcome(
      "chatStream",
      streaming(frames({ choices: [{ delta: { content: "hi" } }] }, "[DONE]")).invoke,
    );
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "other" });
  });

  it("finishes on a finish reason alone, with no [DONE] after it", async () => {
    const parts = await outcome(
      "chatStream",
      streaming(frames({ choices: [{ delta: { content: "hi" }, finish_reason: "length" }] })).invoke,
    );
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
  });
});

// A decoded answer is read as untrusted. What the reader walks must have its
// shape, and the guard that finds it wrong names the member; a leaf of the
// wrong type is read as absent. A guard raises with no cause, which is how these
// rows are told from the boundary's.
describe("an answer whose members have the wrong shape", () => {
  const ok = (body: unknown) => async () => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const chatAnswer = (message: unknown) => ({ choices: [{ message, finish_reason: "stop" }] });
  const chatDelta = (delta: unknown) => frames({ choices: [{ delta }] });
  const itemDone = (item: unknown) => frames({ type: "response.output_item.done", item });

  it.each<[Kind, unknown, string]>([
    ["chat", chatAnswer({ tool_calls: [{ id: "a" }] }), "choices[0].message.tool_calls[].function"],
    ["chat", chatAnswer({ tool_calls: { a: 1 } }), "choices[0].message.tool_calls"],
    ["responses", { status: "completed", output: [null] }, "'output'"],
    ["responses", { status: "completed", output: [{ type: "message", content: 5 }] }, "output[].content"],
  ])("%s refuses %j, naming %s", async (kind, body, member) => {
    const error = await outcome(kind, ok(body));
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    expect(error.data).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain(member);
  });

  it.each<[Kind, string, string]>([
    ["chatStream", chatDelta({ tool_calls: [null] }), "choices[0].delta.tool_calls"],
    ["chatStream", chatDelta({ tool_calls: { a: 1 } }), "choices[0].delta.tool_calls"],
    ["chatStream", chatDelta({ tool_calls: [{ index: 0, function: 5 }] }), "choices[0].delta.tool_calls[].function"],
    ["responsesStream", itemDone(5), "'item'"],
    ["responsesStream", itemDone([null]), "'item'"],
  ])("%s refuses the frame %s after the parts before it, and releases the body once", async (kind, frame, member) => {
    const made = streamBody([firstDelta[kind]!, frame, "never read"]);
    const { parts, error } = await drained(kind, async () => ({ status: 200, headers: {}, body: made.body }));
    expect(parts).toEqual([{ type: "text-delta", delta: "hel" }]);
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    expect(error.data).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain(member);
    expect(made.state.returns).toBe(1);
    expect(made.state.pulled).toBe(2);
  });

  it("reads text that is not text as no text", async () => {
    expect(await outcome("chat", ok({ ...chatAnswer({ content: 5 }), usage: { prompt_tokens: "9" } }))).toEqual({
      content: [],
      text: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });
  });

  it("never copies a call id that is not text: the stream kind mints one", async () => {
    const call = { id: 7, function: { name: "lookup", arguments: "{}" } };
    const buffered = await outcome("chat", ok(chatAnswer({ tool_calls: [call] })));
    expect(buffered.toolCalls).toEqual([{ id: undefined, name: "lookup", arguments: {} }]);

    const made = streamBody([
      chatDelta({ tool_calls: [{ index: 0, ...call }] }) + frames({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const { parts } = await drained("chatStream", async () => ({ status: 200, headers: {}, body: made.body }));
    const streamed = parts.find((part) => part.type === "tool-call") as any;
    expect(streamed.toolCall.id).toMatch(/^call_[0-9a-f-]{36}$/);
  });

  it.each<[Kind, unknown]>([
    ["chat", chatAnswer({ tool_calls: [{ id: "c1", function: { name: "lookup", arguments: 5 } }] })],
    ["responses", { status: "completed", output: [{ type: "function_call", call_id: "c1", name: "lookup", arguments: 5 }] }],
  ])("%s raises tool arguments that are not text under their own code", async (kind, body) => {
    expect(await outcome(kind, ok(body))).toMatchObject({
      code: "ERR_MODEL_TOOL_ARGUMENTS_INVALID",
      data: { tool: "lookup" },
    });
  });
});

// Whatever else goes wrong in a call still leaves as a model failure: a request
// that could not be built before a success response is in hand, an answer that
// could not be read after. The original error is its cause.
describe("an error nothing else classifies", () => {
  it.each(BUFFERED)("%s raises a success body that cannot be read as an unreadable answer", async (kind) => {
    const broke = new Error("the body is gone");
    const response = {
      status: 200,
      headers: {},
      get body(): unknown {
        throw broke;
      },
    };
    expect(await outcome(kind, async () => response)).toMatchObject({
      code: "ERR_MODEL_RESPONSE_INVALID",
      cause: broke,
    });
  });

  it.each<[Kind, unknown]>([
    ["chat", { choices: [{ message: { content: "hi" } }] }],
    ["responses", { status: "completed", output: [] }],
  ])("%s raises an error of its own reading of the answer as an unreadable answer", async (kind, answer) => {
    const fault = new Error("the reader broke");
    const reader = vi.spyOn(shape, "objectList").mockImplementationOnce(() => {
      throw fault;
    });
    try {
      const raised = await outcome(kind, async () => ({ status: 200, headers: {}, body: JSON.stringify(answer) }));
      expect(raised).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: fault });
    } finally {
      reader.mockRestore();
    }
  });

  it.each(STREAMS)("%s raises a success body that cannot be opened as an unreadable answer", async (kind) => {
    const closed = new Error("the body was already consumed");
    const body = {
      [Symbol.asyncIterator]() {
        throw closed;
      },
    };
    const { parts, error } = await drained(kind, async () => ({ status: 200, headers: {}, body }));
    expect(parts).toEqual([]);
    expect(error).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: closed });
  });

  it.each(STREAMS)("%s raises a chunk that is not bytes as an unreadable answer, and releases the body once", async (kind) => {
    const made = streamBody([firstDelta[kind]!, { raw: 5 }, "never read"]);
    const { parts, error } = await drained(kind, async () => ({ status: 200, headers: {}, body: made.body }));
    expect(parts).toEqual([{ type: "text-delta", delta: "hel" }]);
    expect(error.code).toBe("ERR_MODEL_RESPONSE_INVALID");
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(made.state.returns).toBe(1);
    expect(made.state.pulled).toBe(2);
  });

  it.each(KINDS)("%s raises messages that are not a list as a request that could not be built", async (kind) => {
    const invoke = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const model = await create[kind](
      { metadata: { name: "T" }, model: "gpt-test", request: { invoke } } as never,
      {} as never,
    );
    const error = await model.invoke({ messages: 5 }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).toContain("could not be built");
    expect(invoke).not.toHaveBeenCalled();
  });
});
