import { beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/openai-model-controller.js";

// Verifies how the controller shapes multimodal message content onto the OpenAI
// wire — content parts, image data URLs, and the tool-message-can't-carry-images
// workaround — by stubbing `fetch` and inspecting the request body. No live key.

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

function makeModel() {
  return create(
    {
      metadata: { name: "T" },
      model: "gpt-4o-mini",
      request: { invoke: requestMock },
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
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error("the request was not invoked");
  return (call[0] as { body: { messages: WireMessage[] } }).body.messages;
}

beforeEach(() => {
  requestMock = vi.fn(async () => ok(COMPLETION));
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
