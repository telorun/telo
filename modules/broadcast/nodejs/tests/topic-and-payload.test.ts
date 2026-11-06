import { describe, expect, it } from "vitest";
import { decodeBroadcastPayload, encodeBroadcastPayload } from "../src/broadcast-payload.js";
import { isTopic, isTopicPattern, topicMatches } from "../src/topic-grammar.js";

describe("topic grammar", () => {
  it("accepts dot-separated segments and refuses the rest", () => {
    expect(["rooms.42", "a", "tasks.7.comments", "a-b_c.9"].every(isTopic)).toBe(true);
    expect(["", "Rooms", "a..b", ".a", "a.", "a b", "a".repeat(129), "a.*"].some(isTopic)).toBe(false);
  });

  it("accepts `*` anywhere and `>` only last, and refuses `**`", () => {
    expect(["rooms.*", "rooms.>", ">", "*.typing", "a.*.c"].every(isTopicPattern)).toBe(true);
    expect(["rooms.**", ">.a", "a.>.b", "a.", "", "A"].some(isTopicPattern)).toBe(false);
  });

  it("matches `*` as one segment and `>` as one or more", () => {
    expect(topicMatches("rooms.*", "rooms.42")).toBe(true);
    expect(topicMatches("rooms.*", "rooms.42.typing")).toBe(false);
    expect(topicMatches("rooms.*", "rooms")).toBe(false);
    expect(topicMatches("rooms.>", "rooms.42.typing")).toBe(true);
    expect(topicMatches("rooms.>", "rooms")).toBe(false);
    expect(topicMatches(">", "a")).toBe(true);
    expect(topicMatches("a.*.c", "a.b.c")).toBe(true);
    expect(topicMatches("rooms.42", "rooms.42")).toBe(true);
    expect(topicMatches("rooms.42", "rooms.43")).toBe(false);
  });
});

describe("payload", () => {
  it("is one text for one message whatever its key order, and reads back exactly", () => {
    const payload = encodeBroadcastPayload("rooms.1", { b: 1, a: [2n ** 62n] });
    expect(payload).toBe('{"message":{"a":[4611686018427387904],"b":1},"topic":"rooms.1"}');
    expect(decodeBroadcastPayload(payload)).toEqual({
      ok: true,
      topic: "rooms.1",
      message: { a: [4611686018427387904n], b: 1 },
    });
  });

  it("reads an absent topic as null and refuses what is no payload", () => {
    expect(decodeBroadcastPayload(encodeBroadcastPayload(null, { a: 1 }))).toMatchObject({ ok: true, topic: null });
    for (const bad of ["x", "[]", "{}", '{"message":1,"topic":"A"}']) {
      expect(decodeBroadcastPayload(bad).ok).toBe(false);
    }
  });
});
