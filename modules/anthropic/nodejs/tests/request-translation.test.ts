import { describe, expect, it } from "vitest";
import type { ContentPart, Message } from "@telorun/ai";

import { outcome, stubbed } from "./messages-stub.js";

// What the Messages API is sent for a call of the model contract, and what is
// refused before anything is sent.

const user = (...content: ContentPart[]): Message[] => [{ role: "user", content }];
const text = (value: string) => ({ type: "text", text: value });

describe("the request", () => {
  it("goes to the messages path under the dialect's version and the listed betas, asking for text", async () => {
    const { model, invoke } = await stubbed(undefined, { betas: ["one-2025-01-01", "two-2025-02-02"] });
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(invoke.mock.calls[0]![0]).toMatchObject({
      url: "/messages",
      method: "POST",
      responseType: "text",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "one-2025-01-01,two-2025-02-02",
      },
    });
  });

  it("sends no beta header when the kind lists none", async () => {
    const { model, invoke } = await stubbed();
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });
    expect((invoke.mock.calls[0]![0] as any).headers).not.toHaveProperty("anthropic-beta");
  });

  it("hoists every system message, in order and with its markers, wherever it sits", async () => {
    const { model, body } = await stubbed();
    await model.invoke({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "Answer in French.", cacheBreakpoint: true }] },
        { role: "user", content: "more" },
      ],
    });

    expect(body()).toEqual({
      model: "claude-test",
      max_tokens: 1024,
      system: [text("Be terse."), { ...text("Answer in French."), cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [text("hi")] },
        { role: "user", content: [text("more")] },
      ],
    });
  });

  it("carries images and documents by bytes and by an http(s) URL as written", async () => {
    const url = "https://example.com/a%20b.png?sig=A%2Fb#frag";
    const { model, body } = await stubbed();
    await model.invoke({
      messages: user(
        { type: "image", mediaType: "image/jpeg", data: new Uint8Array([104, 105]) },
        { type: "image", mediaType: "image/png", uri: url },
        { type: "file", mediaType: "application/pdf", name: "report.pdf", data: "aGk=" },
        { type: "file", mediaType: "application/pdf", uri: "http://example.com/report.pdf" },
        { type: "file", mediaType: "text/plain; charset=utf-8", name: "notes.txt", data: "aGk=" },
      ),
    });

    expect(body().messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } },
      { type: "image", source: { type: "url", url } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "aGk=" },
        title: "report.pdf",
      },
      { type: "document", source: { type: "url", url: "http://example.com/report.pdf" } },
      {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "hi" },
        title: "notes.txt",
      },
    ]);
  });

  it.each<[string, Message[], Record<string, unknown>]>([
    ["audio", user({ type: "audio", mediaType: "audio/wav", data: "aGk=" }), { partType: "audio", mediaType: "audio/wav" }],
    ["video", user({ type: "video", mediaType: "video/mp4", data: "aGk=" }), { partType: "video", mediaType: "video/mp4" }],
    [
      "an image of another type",
      user({ type: "image", mediaType: "image/tiff", data: "aGk=" }),
      { partType: "image", mediaType: "image/tiff" },
    ],
    [
      "an image by a URI the endpoint cannot reach",
      user({ type: "image", mediaType: "image/png", uri: "file:///tmp/a.png" }),
      { partType: "image", mediaType: "image/png", scheme: "file" },
    ],
    [
      "a file of another type",
      user({ type: "file", mediaType: "application/zip", data: "aGk=" }),
      { partType: "file", mediaType: "application/zip" },
    ],
    [
      "a plain-text file by reference",
      user({ type: "file", mediaType: "text/plain", uri: "https://example.com/notes.txt" }),
      { partType: "file", mediaType: "text/plain" },
    ],
    ["a part a model produces", user({ type: "reasoning", text: "hmm" }), { partType: "reasoning" }],
    [
      "media in a system message",
      [
        { role: "system", content: [{ type: "image", mediaType: "image/png", data: "aGk=" }] },
        { role: "user", content: "hi" },
      ],
      { partType: "image", mediaType: "image/png" },
    ],
    [
      "audio a tool returned",
      [
        { role: "user", content: "fetch" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: {} }] },
        { role: "tool", toolCallId: "c1", content: [{ type: "audio", mediaType: "audio/wav", data: "aGk=" }] },
      ],
      { partType: "audio", mediaType: "audio/wav" },
    ],
  ])("refuses %s before anything is sent", async (what, messages, data) => {
    const { model, invoke } = await stubbed();
    const error = await outcome(model, { messages });
    expect(error).toMatchObject({ code: "ERR_MODEL_CONTENT_UNSUPPORTED" });
    expect(error.data).toEqual(data);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends a run of tool messages as one user turn, files after the results", async () => {
    const { model, body } = await stubbed();
    await model.invoke({
      messages: [
        { role: "user", content: "look both up" },
        {
          role: "assistant",
          content: "On it.",
          toolCalls: [
            { id: "toolu_1", name: "lookup", arguments: { q: "a" } },
            { id: "toolu_2", name: "render", arguments: {} },
          ],
        },
        { role: "tool", toolCallId: "toolu_1", content: "plain result" },
        {
          role: "tool",
          toolCallId: "toolu_2",
          content: [
            { type: "text", text: "see the picture" },
            { type: "image", mediaType: "image/png", data: "aGk=" },
            { type: "file", mediaType: "application/pdf", name: "out.pdf", data: "aGk=" },
            { type: "reasoning", text: "left out" },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    });

    expect(body().messages).toEqual([
      { role: "user", content: [text("look both up")] },
      {
        role: "assistant",
        content: [
          text("On it."),
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "a" } },
          { type: "tool_use", id: "toolu_2", name: "render", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "plain result" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [
              text("see the picture"),
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
            ],
          },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "aGk=" },
            title: "out.pdf",
          },
        ],
      },
      { role: "user", content: [text("thanks")] },
    ]);
  });

  it("declares the tools and sends `none` as a real no-tool choice beside them", async () => {
    const { model, body } = await stubbed();
    const parameters = { type: "object", properties: { q: { type: "string" } } };
    await model.invoke({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", description: "Look it up.", parameters }, { name: "bare", parameters }],
      toolChoice: "none",
    });

    expect(body().tools).toEqual([
      { name: "lookup", description: "Look it up.", input_schema: parameters },
      { name: "bare", input_schema: parameters },
    ]);
    expect(body().tool_choice).toEqual({ type: "none" });
  });
});

describe("cache breakpoints", () => {
  it("honours the last four in request order at the configured lifetime, and drops earlier ones", async () => {
    const marked = (value: string) => ({ type: "text" as const, text: value, cacheBreakpoint: true });
    const { model, body } = await stubbed(undefined, { cacheLifetime: "1h" });
    await model.invoke({
      messages: [
        { role: "system", content: [marked("s1")] },
        { role: "user", content: [marked("u1"), marked("u2")] },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "lookup", arguments: {} }] },
        // A marker inside a result marks the result, the block the API caches at.
        { role: "tool", toolCallId: "toolu_1", content: [marked("r1")] },
        { role: "user", content: [marked("u3"), { type: "text", text: "plain" }, marked("u4")] },
      ],
    });

    const hour = { type: "ephemeral", ttl: "1h" };
    const sent = body();
    expect(sent.system).toEqual([text("s1")]);
    expect(sent.messages[0].content).toEqual([text("u1"), { ...text("u2"), cache_control: hour }]);
    expect(sent.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "r1", cache_control: hour },
    ]);
    expect(sent.messages[3].content).toEqual([
      { ...text("u3"), cache_control: hour },
      text("plain"),
      { ...text("u4"), cache_control: hour },
    ]);
  });
});

describe("options", () => {
  it("sends the kind's token cap, and a call's own in its place", async () => {
    const { model, body } = await stubbed();
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });
    expect(body().max_tokens).toBe(1024);
    await model.invoke({ messages: [{ role: "user", content: "hi" }], options: { maxTokens: 50 } });
    expect(body().max_tokens).toBe(50);
  });

  it("merges the kind's beneath the call's, as snake_case params with values untouched", async () => {
    const { model, body } = await stubbed(undefined, { options: { temperature: 0.2, topP: 0.9 } });
    const thinking = { type: "enabled", budget_tokens: 2048 };
    await model.invoke({
      messages: [{ role: "user", content: "hi" }],
      options: { topP: 0.5, stopSequences: ["END"], thinking },
    });

    expect(body()).toMatchObject({
      temperature: 0.2,
      top_p: 0.5,
      stop_sequences: ["END"],
      thinking,
    });
  });

  it.each(["model", "messages", "system", "tools", "toolChoice", "tool_choice", "stream"])(
    "refuses a call whose options name %s, before anything is sent",
    async (key) => {
      const { model, invoke } = await stubbed();
      const error = await outcome(model, {
        messages: [{ role: "user", content: "hi" }],
        options: { [key]: "x" },
      });
      expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
      expect(error.message).toContain(`options.${key}`);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses a call carrying a response format, before anything is sent", async () => {
    const { model, invoke } = await stubbed();
    const error = await outcome(model, {
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" } },
    });
    expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(invoke).not.toHaveBeenCalled();
  });
});
