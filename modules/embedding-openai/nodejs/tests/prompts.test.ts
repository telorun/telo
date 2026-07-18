import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/model-controller.js";

// The controller calls global `fetch`; we stub it and inspect the request body
// so prompt templating is verified on the wire — the only place that proves the
// wrapper actually reached the model rather than being dropped en route.

let fetchMock: ReturnType<typeof vi.fn>;

function embeddingsResponse(count: number) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, () => ({ embedding: [0.1, 0.2] })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeModel(prompts?: { queryPrompt?: string; passagePrompt?: string }) {
  return create(
    {
      metadata: { name: "T" },
      model: "embeddinggemma-300m",
      apiKey: "unused",
      baseUrl: "https://api.example.com/v1",
      ...prompts,
    } as never,
    {} as never,
  );
}

/** The `input` array of the most recent fetch call. */
function sentInput(): string[] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return JSON.parse((call[1] as RequestInit).body as string).input;
}

beforeEach(() => {
  fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    return embeddingsResponse(body.input.length);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt templates", () => {
  it("wraps query texts with queryPrompt", async () => {
    const model = await makeModel({ queryPrompt: "task: search result | query: {text}" });
    await model.embed({ texts: ["schedule"], intent: "query" });
    expect(sentInput()).toEqual(["task: search result | query: schedule"]);
  });

  it("wraps passage texts with passagePrompt", async () => {
    const model = await makeModel({ passagePrompt: "title: none | text: {text}" });
    await model.embed({ texts: ["Timer.Delay waits"], intent: "passage" });
    expect(sentInput()).toEqual(["title: none | text: Timer.Delay waits"]);
  });

  // The whole point of binding both templates to the model: the two sides use
  // their own wrapper and cannot silently swap.
  it("applies only the template matching the intent", async () => {
    const model = await makeModel({
      queryPrompt: "q: {text}",
      passagePrompt: "p: {text}",
    });
    await model.embed({ texts: ["telo"], intent: "query" });
    expect(sentInput()).toEqual(["q: telo"]);
    await model.embed({ texts: ["telo"], intent: "passage" });
    expect(sentInput()).toEqual(["p: telo"]);
  });

  it("leaves texts untouched when the side has no template", async () => {
    const model = await makeModel({ queryPrompt: "q: {text}" });
    await model.embed({ texts: ["telo"], intent: "passage" });
    expect(sentInput()).toEqual(["telo"]);
  });

  it("passes raw text through for a symmetric model", async () => {
    const model = await makeModel();
    await model.embed({ texts: ["a", "b"], intent: "query" });
    expect(sentInput()).toEqual(["a", "b"]);
  });

  it("wraps every text in a batch, preserving order", async () => {
    const model = await makeModel({ queryPrompt: "q: {text}" });
    await model.embed({ texts: ["one", "two", "three"], intent: "query" });
    expect(sentInput()).toEqual(["q: one", "q: two", "q: three"]);
  });

  // A `$&` / `$1` in the text is a replacement pattern to String.replace; the
  // helper uses split/join so the input survives verbatim.
  it("does not interpret replacement patterns in the input text", async () => {
    const model = await makeModel({ queryPrompt: "q: {text}" });
    await model.embed({ texts: ["cost $& and $1"], intent: "query" });
    expect(sentInput()).toEqual(["q: cost $& and $1"]);
  });

  it("substitutes every occurrence of the placeholder", async () => {
    const model = await makeModel({ queryPrompt: "{text} || {text}" });
    await model.embed({ texts: ["telo"], intent: "query" });
    expect(sentInput()).toEqual(["telo || telo"]);
  });
});

describe("template validation", () => {
  // Fails at create(), not on first embed: a template that silently embeds a
  // constant would otherwise poison an entire index before anyone noticed.
  it("rejects a template missing the {text} placeholder", async () => {
    await expect(makeModel({ queryPrompt: "task: search result | query:" })).rejects.toThrow(
      /\{text\} placeholder/,
    );
  });

  it("names the offending field and shows the received value", async () => {
    await expect(makeModel({ passagePrompt: "title: none" })).rejects.toThrow(
      /'passagePrompt'.*"title: none"/s,
    );
  });

  it("accepts a model that declares no templates", async () => {
    await expect(makeModel()).resolves.toBeDefined();
  });
});
