import { InvokeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { ConversationTitler, cleanTitle, titleIfUntitled, titlePrompt } from "../src/conversation-titles.js";
import type { OperationCall } from "../src/operation-call.js";
import type { TurnOperations } from "../src/turn-plan.js";
import { turnRecords } from "../src/turn-run.js";

const ctx = {} as never;

const call = (answer: (inputs: Record<string, any>) => unknown, calls: Array<Record<string, any>> = []) =>
  ({ invoke: async (inputs: Record<string, any>) => (calls.push(inputs), answer(inputs)) }) as unknown as OperationCall;

const titlerAnswering = (text: string, calls: Array<Record<string, any>> = []) => new ConversationTitler(call(() => ({ text }), calls));

describe("a title", () => {
  it("is the answer's first line without a label, quotes, markup or a trailing stop", () => {
    expect(cleanTitle('\n  Title: "Tokyo weekend weather."  \nmore')).toBe("Tokyo weekend weather");
    expect(cleanTitle("## **Currency   conversion**")).toBe("Currency conversion");
    expect(cleanTitle("  \n ")).toBeUndefined();
  });

  it("is cut at a word to at most 80 characters", () => {
    const title = cleanTitle(`${"word ".repeat(30)}end`) as string;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("word")).toBe(true);
  });

  it("is asked for from the user's message, then the reply", () => {
    const [system, user] = titlePrompt("What's the weather in Tokyo?", "Rainy, 10 °C.");
    expect(system.role).toBe("system");
    expect(user.content.startsWith("What's the weather in Tokyo?")).toBe(true);
    expect(user.content).toContain("Rainy, 10 °C.");
  });
});

describe("titling a conversation", () => {
  it("writes the title at the version read when the conversation has none", async () => {
    const updates: Array<Record<string, any>> = [];
    const ops = { read: call(() => ({ title: null, version: 4 })), update: call(() => ({}), updates) };
    await titleIfUntitled(ops, titlerAnswering("Tokyo weather"), "cnv_1", "hi", "hello", ctx);
    expect(updates).toEqual([{ conversation: "cnv_1", version: 4, title: "Tokyo weather" }]);
  });

  it("keeps a title already set, and asks the model nothing", async () => {
    const asked: Array<Record<string, any>> = [];
    const updates: Array<Record<string, any>> = [];
    const ops = { read: call(() => ({ title: "Mine", version: 2 })), update: call(() => ({}), updates) };
    await titleIfUntitled(ops, titlerAnswering("Other", asked), "cnv_1", "hi", "hello", ctx);
    expect(asked).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("reads again after a conflict and keeps a rename that landed meanwhile", async () => {
    const reads = [{ title: null, version: 1 }, { title: "Renamed", version: 2 }];
    const updates: Array<Record<string, any>> = [];
    const ops = {
      read: call(() => reads.shift()),
      update: call(() => {
        throw new InvokeError("ERR_CONVERSATION_CONFLICT", "changed");
      }, updates),
    };
    await titleIfUntitled(ops, titlerAnswering("Tokyo weather"), "cnv_1", "hi", "hello", ctx);
    expect(updates).toHaveLength(1);
  });

  it("is written before the turn's terminal event, from the reply's text", async () => {
    const parts = [
      { type: "text-delta", delta: "Rain" },
      { type: "text-delta", delta: "y." },
      { type: "message", message: { role: "assistant", content: "Rainy." } },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const output = { async *[Symbol.asyncIterator]() { yield* parts; } };
    const ops = {
      append: { invoke: async () => ({ id: "ent" }) },
      agent: { invoke: async () => ({ output }) },
    } as unknown as TurnOperations;
    const plan = { decisions: [], history: [], parent: null, media: [], attachments: [] };
    const seen: string[] = [];
    const records = turnRecords(ops, { conversation: "cnv", turn: "trn" }, plan, "Weather?", ctx, () => {}, async (reply) => {
      seen.push(`titled from ${reply}`);
    });
    for await (const record of records) seen.push(String(record.type));
    expect(seen).toEqual(["text-delta", "text-delta", "titled from Rainy.", "turn-end"]);
  });
});
