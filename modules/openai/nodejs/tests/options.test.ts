import { beforeEach, describe, expect, it, vi } from "vitest";

import { create, createStream } from "../src/openai-model-controller.js";

// The controller drives an INJECTED `Http.Request` rather than global `fetch`,
// so the stub is that resource: it records the inputs the controller built and
// answers with a canned response. Closer to what the kernel actually hands the
// controller than a fetch mock, and it needs no global stubbing.

let requestMock: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { status: 200, headers: { "content-type": "application/json" }, body };
}

/** An SSE response as the request controller delivers one: a byte stream. */
function sseStream(frames: unknown[]) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: (async function* () {
      yield bytes;
    })(),
  };
}

const COMPLETION = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function makeStreamModel(options?: Record<string, unknown>) {
  return createStream(
    {
      metadata: { name: "T" },
      model: "gpt-4o-mini",
      request: { invoke: requestMock },
      options,
    } as never,
    {} as never,
  );
}

function makeModel(options?: Record<string, unknown>) {
  return create(
    {
      metadata: { name: "T" },
      model: "gpt-4o-mini",
      request: { invoke: requestMock },
      options,
    } as never,
    {} as never,
  );
}

/** The body of the most recent call — already an object, since `Http.Request`
 *  serializes it rather than the controller. */
function sentBody(): Record<string, unknown> {
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error("the request was not invoked");
  return (call[0] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  requestMock = vi.fn(async () => ok(COMPLETION));
});

describe("option normalization (camelCase → OpenAI snake_case)", () => {
  it("converts top-level camelCase option keys to snake_case wire params", async () => {
    const model = await makeModel({
      maxTokens: 7,
      topP: 0.5,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody();
    expect(body.max_tokens).toBe(7);
    expect(body.top_p).toBe(0.5);
    expect(body.frequency_penalty).toBe(0.1);
    expect(body.presence_penalty).toBe(0.2);
    // camelCase forms must not leak onto the wire
    expect(body).not.toHaveProperty("maxTokens");
    expect(body).not.toHaveProperty("topP");
  });

  it("merges caller options over manifest options (downstream wins), then normalizes", async () => {
    const model = await makeModel({ temperature: 0, maxTokens: 10 });
    await model.invoke({
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.9 },
    });

    const body = sentBody();
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(10);
  });

  it("passes already-snake_case keys through unchanged", async () => {
    const model = await makeModel({ max_tokens: 5, top_p: 0.3 });
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody();
    expect(body.max_tokens).toBe(5);
    expect(body.top_p).toBe(0.3);
  });

  it("only converts top-level keys — nested object values keep their casing", async () => {
    const model = await makeModel({
      responseFormat: { type: "json_schema", jsonSchema: { name: "x" } },
    });
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody();
    expect(body.response_format).toEqual({ type: "json_schema", jsonSchema: { name: "x" } });
    expect(body).not.toHaveProperty("responseFormat");
  });

  it("normalizes options on the streaming path too, and requests usage", async () => {
    requestMock.mockImplementationOnce(async () =>
      sseStream([
        { choices: [{ delta: { content: "he" } }] },
        { choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]),
    );

    // `Ai.ModelStream` is its own kind with one bound entry point: `invoke`
    // returns a handle, and the parts arrive while the consumer drains it.
    const model = await makeStreamModel({ maxTokens: 4 });
    const { output } = await model.invoke({ messages: [{ role: "user", content: "hi" }] });
    const parts = [];
    for await (const part of output) {
      parts.push(part);
    }

    const body = sentBody();
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(4);

    const text = parts
      .filter((p): p is { type: "text-delta"; delta: string } => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).toBe("hello");
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toMatchObject({
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
  });
});

describe("request shaping", () => {
  it("sets stream:false for invoke and carries model + mapped messages", async () => {
    const model = await makeModel();
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody();
    expect(body.stream).toBe(false);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body).not.toHaveProperty("stream_options");
  });
});
