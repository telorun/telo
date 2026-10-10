import { describe, expect, it, vi } from "vitest";
import type { StreamPart } from "@telorun/ai";

import * as chat from "../src/openai-chat-controller.js";
import * as responses from "../src/openai-responses-controller.js";

// The cached share of the prompt and the reasoning share of the completion are
// reported when the endpoint reports them and are ABSENT otherwise — on both
// dialects, buffered and streamed. `toEqual` on the whole usage is what pins
// absence: a zero would be a key.

const MESSAGES = [{ role: "user" as const, content: "hi" }];

const json = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sse = (frames: unknown[]) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: (async function* () {
    yield new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
  })(),
});

const resource = (answer: unknown) =>
  ({ metadata: { name: "T" }, model: "gpt-test", request: { invoke: vi.fn(async () => answer) } }) as never;

async function finishUsage(output: AsyncIterable<StreamPart>) {
  for await (const part of output) if (part.type === "finish") return part.usage;
  throw new Error("the stream ended without a finish part");
}

const CHAT_PLAIN = { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 };
const CHAT_DETAILED = {
  ...CHAT_PLAIN,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
const RESPONSES_PLAIN = { input_tokens: 9, output_tokens: 6, total_tokens: 15 };
const RESPONSES_DETAILED = {
  ...RESPONSES_PLAIN,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 0 },
};

const chatBuffered = async (usage: unknown) => {
  const answer = json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
  const model = await chat.create(resource(answer), {} as never);
  return (await model.invoke({ messages: MESSAGES })).usage;
};
const chatStreamed = async (usage: unknown) => {
  const answer = sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, { usage }]);
  const model = await chat.createStream(resource(answer), {} as never);
  return finishUsage((await model.invoke({ messages: MESSAGES })).output);
};
const responsesBuffered = async (usage: unknown) => {
  const model = await responses.create(resource(json({ status: "completed", output: [], usage })), {} as never);
  return (await model.invoke({ messages: MESSAGES })).usage;
};
const responsesStreamed = async (usage: unknown) => {
  const answer = sse([{ type: "response.completed", response: { status: "completed", usage } }]);
  const model = await responses.createStream(resource(answer), {} as never);
  return finishUsage((await model.invoke({ messages: MESSAGES })).output);
};

const TRIPLE = { promptTokens: 9, completionTokens: 6, totalTokens: 15 };

describe("usage detail", () => {
  it.each([
    ["chat, buffered", chatBuffered, CHAT_DETAILED, CHAT_PLAIN],
    ["chat, streamed", chatStreamed, CHAT_DETAILED, CHAT_PLAIN],
    ["responses, buffered", responsesBuffered, RESPONSES_DETAILED, RESPONSES_PLAIN],
    ["responses, streamed", responsesStreamed, RESPONSES_DETAILED, RESPONSES_PLAIN],
  ])("%s: reported when the endpoint reports it, absent otherwise", async (name, call, detailed, plain) => {
    // A reported zero is a report: it stays, as zero.
    expect(await call(detailed)).toEqual({ ...TRIPLE, cachedPromptTokens: 4, reasoningTokens: 0 });
    expect(await call(plain)).toEqual(TRIPLE);
  });
});
