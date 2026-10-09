import { describe, expect, it } from "vitest";
import type { AiModelStreamInstance, StreamPart } from "@telorun/ai";

import * as chat from "../src/openai-chat-controller.js";
import * as responses from "../src/openai-responses-controller.js";

// Both stream kinds report a tool call's arguments as they are written, under
// the id the whole call then carries: the endpoint's own when it gives one —
// however late — and a unique minted one when it gives none.

const MESSAGES = [{ role: "user" as const, content: "weather in Paris?" }];
const ARGUMENTS = '{"city":"Paris"}';
const [HEAD, TAIL] = ['{"ci', 'ty":"Paris"}'];
const MINTED = /^call_[0-9a-f]{8}-[0-9a-f-]{27}$/;

type CreateStream = (resource: never, ctx: never) => Promise<AiModelStreamInstance>;

/** A model whose endpoint answers every call with `frames`. */
const model = (create: CreateStream, frames: unknown[]) =>
  create(
    {
      metadata: { name: "T" },
      model: "gpt-test",
      request: {
        invoke: async () => ({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: (async function* () {
            yield new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
          })(),
        }),
      },
    } as never,
    {} as never,
  );

/** The tool-call parts of one call, in order. */
async function toolParts(streaming: AiModelStreamInstance): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of (await streaming.invoke({ messages: MESSAGES })).output) {
    if (part.type === "tool-call-delta" || part.type === "tool-call") parts.push(part);
  }
  return parts;
}

const delta = (toolCallId: string, text: string) => ({
  type: "tool-call-delta",
  toolCallId,
  toolName: "get_weather",
  delta: text,
});
const call = (id: string) => ({
  type: "tool-call",
  toolCall: { id, name: "get_weather", arguments: { city: "Paris" } },
});

/** One call's frames on the chat dialect: `id` on the given chunk, or on none. */
const chatFrames = (idOn: "first" | "second" | "none") => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(idOn === "first" ? { id: "call_up" } : {}),
              function: { name: "get_weather", arguments: HEAD },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, ...(idOn === "second" ? { id: "call_up" } : {}), function: { arguments: TAIL } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
];

/** The same call on the responses dialect: `call_id` on the item's `added`
 *  event, only on its `done` event, or on neither. */
const responsesFrames = (idOn: "first" | "second" | "none") => {
  // With no call id anywhere the item carries no id either, so nothing upstream
  // can name the call and its events are joined by position.
  const named = idOn === "none" ? {} : { id: "fc_1" };
  const item = { ...named, type: "function_call", name: "get_weather" };
  const of = idOn === "none" ? { output_index: 0 } : { output_index: 0, item_id: "fc_1" };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", ...(idOn === "first" ? { call_id: "call_up" } : {}) },
    },
    { type: "response.function_call_arguments.delta", ...of, delta: HEAD },
    { type: "response.function_call_arguments.delta", ...of, delta: TAIL },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, arguments: ARGUMENTS, ...(idOn === "none" ? {} : { call_id: "call_up" }) },
    },
    { type: "response.completed", response: { status: "completed" } },
  ];
};

describe.each([
  ["chat", chat.createStream as CreateStream, chatFrames],
  ["responses", responses.createStream as CreateStream, responsesFrames],
])("%s stream: a tool call's argument deltas", (name, create, frames) => {
  it("precede the call under its id and join to its argument JSON", async () => {
    const parts = await toolParts(await model(create, frames("first")));
    expect(parts).toEqual([delta("call_up", HEAD), delta("call_up", TAIL), call("call_up")]);
  });

  it("are held until the id arrives when it follows the first fragment", async () => {
    const parts = await toolParts(await model(create, frames("second")));
    expect(parts).toEqual([delta("call_up", ARGUMENTS), call("call_up")]);
  });

  it("carry a minted id shared with the call when the endpoint names none, unique per model call", async () => {
    const streaming = await model(create, frames("none"));
    const first = await toolParts(streaming);
    const second = await toolParts(streaming);
    const id = (parts: StreamPart[]) => (parts[1] as Extract<StreamPart, { type: "tool-call" }>).toolCall.id;
    expect(id(first)).toMatch(MINTED);
    expect(first).toEqual([delta(id(first), ARGUMENTS), call(id(first))]);
    expect(id(second)).not.toBe(id(first));
  });
});
