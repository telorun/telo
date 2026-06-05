import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/openai-model-controller.js";

// The controller calls global `fetch`; we stub it and inspect the request body
// it builds so option normalization and request shaping are verified on the
// wire without a live API key.

let fetchMock: ReturnType<typeof vi.fn>;

const COMPLETION = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: unknown[]) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeModel(options?: Record<string, unknown>) {
  return create(
    {
      metadata: { name: "T" },
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      options,
    } as never,
    {} as never,
  );
}

/** The JSON body of the most recent fetch call. */
function sentBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(COMPLETION));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    fetchMock.mockImplementationOnce(async () =>
      sseResponse([
        { choices: [{ delta: { content: "he" } }] },
        { choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]),
    );

    const model = await makeModel({ maxTokens: 4 });
    const parts = [];
    for await (const part of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
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
