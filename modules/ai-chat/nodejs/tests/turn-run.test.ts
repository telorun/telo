import { describe, expect, it } from "vitest";
import type { TurnOperations } from "../src/turn-plan.js";
import { turnRecords } from "../src/turn-run.js";
import { wireEntry, wireToolResult } from "../src/wire-shapes.js";
import { mediaTypeMatches } from "../src/conversation-spec.js";
import { unacceptedPart } from "../../../ai/nodejs/src/accepted-content.js";

const ctx = {} as never;

describe("a turn's records", () => {
  it("end at the terminal event, without waiting for the agent's stream to finish", async () => {
    const output = {
      [Symbol.asyncIterator]() {
        const parts = [
          { type: "message", message: { role: "assistant", content: "hi" } },
          { type: "finish", finishReason: "stop", usage: {} },
        ];
        return {
          next: () => (parts.length > 0 ? Promise.resolve({ done: false, value: parts.shift() }) : new Promise(() => {})),
        };
      },
    };
    const ops = {
      append: { invoke: async () => ({ id: "ent" }) },
      agent: { invoke: async () => ({ output }) },
    } as unknown as TurnOperations;
    const plan = { decisions: [], history: [], parent: null, media: [], attachments: [] };
    const records: Array<Record<string, any>> = [];
    for await (const record of turnRecords(ops, { conversation: "cnv", turn: "trn" }, plan, "hello", ctx, () => {})) {
      records.push(record);
    }
    expect(records.map((record) => record.type)).toEqual(["turn-end"]);
  });

  it("register the media the agent produces bound to the turn before its bytes are put, and show it under the conversation", async () => {
    const image = { type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
    const parts = [
      { type: "content-part", part: image },
      { type: "message", message: { role: "assistant", content: [image] } },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const output = { async *[Symbol.asyncIterator]() { yield* parts; } };
    let minted = 0;
    const calls: Array<[string, Record<string, any>]> = [];
    const op = (name: string, answer: () => unknown) => ({
      invoke: async (inputs: Record<string, any>) => (calls.push([name, inputs]), answer()),
    });
    const ops = {
      registerAttachment: op("register", () => ({ id: `att_${++minted}` })),
      blobPut: op("put", () => ({ size: 3 })),
      append: op("append", () => ({ id: "ent" })),
      agent: { invoke: async () => ({ output }) },
    } as unknown as TurnOperations;
    const plan = { decisions: [], history: [], parent: null, media: [], attachments: [] };
    const records: Array<Record<string, any>> = [];
    for await (const record of turnRecords(ops, { conversation: "cnv_1", turn: "trn" }, plan, "draw", ctx, () => {})) {
      records.push(record);
    }
    expect(records[0]).toEqual({
      type: "content",
      part: { type: "image", url: "conversations/cnv_1/attachments/att_1", mediaType: "image/png" },
    });
    // Each id registered bound to the turn before its bytes are put; no append binds produced media.
    const register = { binding: { conversation: "cnv_1", turn: "trn" } };
    expect(calls.map(([name, inputs]) => [name, name === "put" ? inputs.key : inputs])).toEqual([
      ["append", { conversation: "cnv_1", parent: null, turn: "trn", message: { role: "user", content: "draw" }, attachments: [] }],
      ["register", register],
      ["put", "attachments/att_1"],
      ["register", register],
      ["put", "attachments/att_2"],
      [
        "append",
        {
          conversation: "cnv_1",
          parent: "ent",
          turn: "trn",
          message: { role: "assistant", content: [{ type: "image", uri: "attachment:att_2", mediaType: "image/png" }] },
        },
      ],
    ]);
  });
});

describe("a tool's media on the wire", () => {
  const result = [{ type: "image", uri: "attachment:att_0000000000000000000000", mediaType: "image/png" }];
  const wired = [{ type: "image", url: "conversations/cnv_1/attachments/att_0000000000000000000000", mediaType: "image/png" }];

  it("is a relative reference under its conversation in a tool-result event", () => {
    expect(wireToolResult(result, "cnv_1")).toEqual(wired);
  });

  it("is a relative reference under its conversation in an entry's tool results", () => {
    const entry = wireEntry(
      {
        id: "e",
        turn: "t",
        siblings: { position: 1, count: 1 },
        createdAt: new Date(0),
        message: { role: "tool", toolCallId: "c1", content: result },
      },
      "cnv_1",
    );
    expect(entry.toolResults).toEqual([{ id: "c1", result: wired }]);
  });
});

describe("the media type rule", () => {
  it("matches the model's own", () => {
    for (const declared of ["text/plain", "text/plain; charset=utf-8", "Image/PNG", "image/webp", "application/pdf"]) {
      const part = { type: "file", mediaType: declared } as never;
      const accepts = [{ type: "file" as const, mediaTypes: ["text/plain", "image/*"] }];
      expect(mediaTypeMatches(accepts[0]!.mediaTypes, declared)).toBe(unacceptedPart(accepts, part, "x") === undefined);
    }
  });
});
