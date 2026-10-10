import { describe, expect, it } from "vitest";
import type { Message } from "@telorun/ai";

import { ANSWER, outcome, stubbed } from "./messages-stub.js";

// What a Messages API answer is returned as, and how a turn that must survive
// verbatim — its thinking — is carried to the next request.

const ASK: Message[] = [{ role: "user", content: "hi" }];

const THINKING = [
  { type: "thinking", thinking: "Let me look it up.", signature: "sig-1" },
  { type: "redacted_thinking", data: "opaque" },
  { type: "text", text: "Looking.", citations: null },
  { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "a" } },
];

const STATE = { api: "messages", model: "claude-test", resource: "App.T", content: THINKING };

describe("the answer", () => {
  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "tool-calls"],
    ["refusal", "content-filter"],
    ["pause_turn", "other"],
    ["something_new", "other"],
  ])("reports the stop reason %s as %s", async (stopReason, finishReason) => {
    const { model } = await stubbed({ ...ANSWER, stop_reason: stopReason });
    expect((await model.invoke({ messages: ASK })).finishReason).toBe(finishReason);
  });

  it("sums the three input figures into the prompt and carries the two cache shares", async () => {
    const { model } = await stubbed({
      ...ANSWER,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
        output_tokens: 7,
      },
    });
    expect((await model.invoke({ messages: ASK })).usage).toEqual({
      promptTokens: 360,
      completionTokens: 7,
      totalTokens: 367,
      cachedPromptTokens: 300,
      cacheWritePromptTokens: 50,
    });
  });

  it("leaves a cache share absent when the endpoint reports none", async () => {
    const { model } = await stubbed({ ...ANSWER, usage: { input_tokens: 10, output_tokens: 7 } });
    expect((await model.invoke({ messages: ASK })).usage).toEqual({
      promptTokens: 10,
      completionTokens: 7,
      totalTokens: 17,
    });
  });

  it("returns thinking as a reasoning part, the calls under the vendor's ids, and the turn as tagged state", async () => {
    const { model } = await stubbed({ ...ANSWER, content: THINKING, stop_reason: "tool_use" });
    expect(await model.invoke({ messages: ASK })).toMatchObject({
      content: [
        { type: "reasoning", text: "Let me look it up." },
        { type: "text", text: "Looking." },
      ],
      text: "Looking.",
      finishReason: "tool-calls",
      toolCalls: [{ id: "toolu_1", name: "lookup", arguments: { q: "a" } }],
      providerState: STATE,
    });
  });

  it("carries no state for an answer of text and tool calls alone", async () => {
    const { model } = await stubbed();
    expect(await model.invoke({ messages: ASK })).not.toHaveProperty("providerState");
  });

  it("raises tool arguments that are not an object under their own code", async () => {
    const { model } = await stubbed({
      ...ANSWER,
      content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: "[1" }],
    });
    expect(await outcome(model, { messages: ASK })).toMatchObject({
      code: "ERR_MODEL_TOOL_ARGUMENTS_INVALID",
      data: { tool: "lookup" },
    });
  });
});

describe("the carried turn", () => {
  const loop = (ids: string[]): Message[] => [
    { role: "user", content: "look it up" },
    {
      role: "assistant",
      content: "Looking.",
      toolCalls: ids.map((id) => ({ id, name: "lookup", arguments: { q: "a" } })),
    },
    ...ids.map((id): Message => ({ role: "tool", toolCallId: id, content: "found" })),
  ];
  const rebuilt = (ids: string[]) => [
    { type: "text", text: "Looking." },
    ...ids.map((id) => ({ type: "tool_use", id, name: "lookup", input: { q: "a" } })),
  ];

  it("is replayed verbatim in place of the newest assistant message it is the turn of", async () => {
    const { model, body } = await stubbed();
    await model.invoke({ messages: loop(["toolu_1"]), providerState: STATE });
    expect(body().messages[1]).toEqual({ role: "assistant", content: THINKING });
  });

  it("is still that turn when a user message follows the tool results", async () => {
    const { model, body } = await stubbed();
    await model.invoke({
      messages: [...loop(["toolu_1"]), { role: "user", content: "and then?" }],
      providerState: STATE,
    });
    expect(body().messages[1]).toEqual({ role: "assistant", content: THINKING });
  });

  it("is ignored once the conversation is cut back to an earlier turn, or holds no assistant turn", async () => {
    const truncated = await stubbed();
    await truncated.model.invoke({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Earlier." },
        { role: "user", content: "look it up" },
      ],
      providerState: STATE,
    });
    expect(truncated.body().messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Earlier." }],
    });

    const fresh = await stubbed();
    await fresh.model.invoke({ messages: [{ role: "user", content: "hello" }], providerState: STATE });
    expect(fresh.body().messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it.each<[string, unknown, Message[]]>([
    ["another model's", { ...STATE, model: "claude-other" }, loop(["toolu_1"])],
    ["another resource's", { ...STATE, resource: "App.other" }, loop(["toolu_1"])],
    ["another API's", { ...STATE, api: "responses" }, loop(["toolu_1"])],
    ["a turn with other call ids", STATE, loop(["toolu_9"])],
    ["a turn with more calls", STATE, loop(["toolu_1", "toolu_2"])],
  ])("is ignored when it is %s", async (what, state, messages) => {
    const { model, body } = await stubbed();
    await model.invoke({ messages, providerState: state });
    const ids = messages.filter((m) => m.role === "tool").map((m) => m.toolCallId!);
    expect(body().messages[1]).toEqual({ role: "assistant", content: rebuilt(ids) });
  });

  it("is ignored for an older assistant message, which is rebuilt", async () => {
    const { model, body } = await stubbed();
    await model.invoke({
      messages: [...loop(["toolu_1"]), { role: "assistant", content: "Found it." }, { role: "user", content: "more" }],
      providerState: STATE,
    });
    expect(body().messages[1]).toEqual({ role: "assistant", content: rebuilt(["toolu_1"]) });
    expect(body().messages[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "Found it." }] });
  });

  it("never stands for an empty turn: thinking alone identifies nothing", async () => {
    const state = { ...STATE, content: [{ type: "thinking", thinking: "Cut off.", signature: "sig-3" }] };
    const { model, body } = await stubbed();
    await model.invoke({
      messages: [
        { role: "user", content: "2 + 2?" },
        { role: "assistant", content: "" },
        { role: "user", content: "well?" },
      ],
      providerState: state,
    });
    expect(body().messages.map((turn: { role: string }) => turn.role)).toEqual(["user", "user"]);
  });

  // An agent keeps handing over the last state it was given, so a state outlives
  // a later answer that returned none.
  it("replaces a turn that made no call only when it holds the same text", async () => {
    const answer = [
      { type: "thinking", thinking: "Simple.", signature: "sig-2" },
      { type: "text", text: "Four." },
    ];
    const state = { ...STATE, content: answer };
    const after = (said: string): Message[] => [
      { role: "user", content: "2 + 2?" },
      { role: "assistant", content: said },
      { role: "user", content: "sure?" },
    ];

    const same = await stubbed();
    await same.model.invoke({ messages: after("Four."), providerState: state });
    expect(same.body().messages[1].content).toEqual(answer);

    const other = await stubbed();
    await other.model.invoke({ messages: after("Five."), providerState: state });
    expect(other.body().messages[1].content).toEqual([{ type: "text", text: "Five." }]);
  });
});

describe("a tool call the endpoint gave no id", () => {
  const MINTED = /^call_[0-9a-f]{8}-[0-9a-f-]{27}$/;
  const unnamed = (id?: string) => ({
    type: "tool_use",
    name: "lookup",
    input: { q: "a" },
    ...(id === undefined ? {} : { id }),
  });
  const answer = (...content: unknown[]) => ({ ...ANSWER, content, stop_reason: "tool_use" });

  it.each([["absent", unnamed()], ["empty", unnamed("")]])("is named here when the id is %s", async (what, block) => {
    const { model } = await stubbed(answer(block));
    const result = await model.invoke({ messages: ASK });
    expect(result.toolCalls![0]!.id).toMatch(MINTED);
  });

  it("gets a different id from the next one in the same answer", async () => {
    const { model } = await stubbed(answer(unnamed(), unnamed()));
    const [first, second] = (await model.invoke({ messages: ASK })).toolCalls!;
    expect(first!.id).toMatch(MINTED);
    expect(second!.id).toMatch(MINTED);
    expect(second!.id).not.toBe(first!.id);
  });

  it("carries that id in its state, and sends it back on the call and on its result", async () => {
    const thinking = { type: "thinking", thinking: "Look it up.", signature: "sig-1" };
    const { model, body } = await stubbed(answer(thinking, unnamed()));
    const result = await model.invoke({ messages: ASK });
    const id = result.toolCalls![0]!.id;
    const state = result.providerState as { content: Record<string, unknown>[] };
    expect(state.content[1]).toEqual({ ...unnamed(), id });

    await model.invoke({
      messages: [
        ...ASK,
        { role: "assistant", content: result.text, toolCalls: result.toolCalls },
        { role: "tool", toolCallId: id, content: "found" },
      ],
      providerState: result.providerState,
    });
    expect(body().messages.slice(1)).toEqual([
      { role: "assistant", content: [thinking, { ...unnamed(), id }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "found" }] },
    ]);
  });
});
