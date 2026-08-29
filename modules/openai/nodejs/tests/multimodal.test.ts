import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/openai-model-controller.js";

// Verifies how the controller shapes multimodal message content onto the OpenAI
// wire — content parts, image data URLs, and the tool-message-can't-carry-images
// workaround — by stubbing `fetch` and inspecting the request body. No live key.

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

function makeModel() {
  return create(
    {
      metadata: { name: "T" },
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
    } as never,
    {} as never,
  );
}

interface WireMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
}

function sentMessages(): WireMessage[] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return JSON.parse((call[1] as RequestInit).body as string).messages;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(COMPLETION));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("multimodal message translation", () => {
  it("turns a user message's content parts into an OpenAI content array with an image data URL", async () => {
    const model = await makeModel();
    await model.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", data: "aGVsbG8=", mediaType: "image/png" },
          ],
        },
      ],
    });

    expect(sentMessages()).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ]);
  });

  it("base64-encodes raw image bytes (the tool-result path) into the data URL", async () => {
    const model = await makeModel();
    await model.invoke({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: new Uint8Array([104, 105]), mediaType: "image/png" }],
        },
      ],
    });

    const [msg] = sentMessages();
    expect(msg.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }, // "hi"
    ]);
  });

  it("flattens a system message's parts to plain text (system can't carry images)", async () => {
    const model = await makeModel();
    await model.invoke({
      messages: [
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: "hi" },
      ],
    });

    expect(sentMessages()[0]).toEqual({ role: "system", content: "be brief" });
  });

  it("splits an image-bearing tool result into a tool placeholder plus a synthetic user message", async () => {
    const model = await makeModel();
    await model.invoke({
      messages: [
        { role: "user", content: "draw it" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "draw", arguments: {} }] },
        {
          role: "tool",
          toolCallId: "c1",
          content: [{ type: "image", data: "aGVsbG8=", mediaType: "image/png" }],
        },
      ],
    });

    const msgs = sentMessages();
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(typeof msgs[2].content).toBe("string"); // placeholder text, not the image
    expect(msgs[3]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
    });
  });

  it("keeps tool messages contiguous when a turn returns multiple images (no interleaving)", async () => {
    const model = await makeModel();
    await model.invoke({
      messages: [
        { role: "user", content: "draw two" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "draw", arguments: {} },
            { id: "c2", name: "draw", arguments: {} },
          ],
        },
        {
          role: "tool",
          toolCallId: "c1",
          content: [{ type: "image", data: "b25l", mediaType: "image/png" }],
        },
        {
          role: "tool",
          toolCallId: "c2",
          content: [{ type: "image", data: "dHdv", mediaType: "image/png" }],
        },
      ],
    });

    const roles = sentMessages().map((m) => m.role);
    // Both tool messages must precede any user message — OpenAI rejects an
    // interleaved tool/user/tool/user sequence with a 400.
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user", "user"]);
  });

  it("leaves plain string content untouched", async () => {
    const model = await makeModel();
    await model.invoke({ messages: [{ role: "user", content: "hi" }] });
    expect(sentMessages()).toEqual([{ role: "user", content: "hi" }]);
  });
});
