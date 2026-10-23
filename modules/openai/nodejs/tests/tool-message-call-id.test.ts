import { describe, expect, it, vi } from "vitest";
import type { Message } from "@telorun/ai";

import * as chat from "../src/openai-chat-controller.js";
import * as responses from "../src/openai-responses-controller.js";

// A tool message keys its result on the call it answers. One naming no call is
// refused while the request is built — never sent with an empty id.

const conversation: Message[] = [
  { role: "user", content: "fetch it" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: {} }] },
  { role: "tool", content: "42" },
];

describe.each([
  ["chat", chat.create],
  ["responses", responses.create],
] as const)("a tool message with no toolCallId on the %s dialect", (dialect, create) => {
  it("is refused before anything is sent, naming the message", async () => {
    const request = vi.fn();
    const model = await create(
      { metadata: { name: "T" }, model: "gpt-test", request: { invoke: request } } as never,
      {} as never,
    );

    await expect(model.invoke({ messages: conversation })).rejects.toMatchObject({
      code: "ERR_MODEL_REQUEST_REJECTED",
      message: expect.stringContaining(
        "messages[2] is a tool message with no 'toolCallId', so it answers no call.",
      ),
    });
    expect(request).not.toHaveBeenCalled();
  });
});
