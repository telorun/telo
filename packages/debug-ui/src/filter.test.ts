import { describe, expect, it } from "vitest";
import { distinctSuffixes, matchesFilter } from "./filter.js";
import type { DebugEvent } from "./wire.js";

const ev = (event: string, payload?: unknown): DebugEvent => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  event,
  payload,
});

describe("matchesFilter", () => {
  it("empty filter matches everything", () => {
    expect(matchesFilter(ev("A.B.Invoked"), {})).toBe(true);
  });

  it("filters by suffix", () => {
    const f = { suffixes: ["Failed"] };
    expect(matchesFilter(ev("A.B.Failed"), f)).toBe(true);
    expect(matchesFilter(ev("A.B.Invoked"), f)).toBe(false);
  });

  it("filters by kind substring (case-insensitive)", () => {
    expect(matchesFilter(ev("Http.Server.Listening"), { kind: "server" })).toBe(true);
    expect(matchesFilter(ev("Sql.Query.Invoked"), { kind: "server" })).toBe(false);
  });

  it("text searches name and payload", () => {
    expect(matchesFilter(ev("A.Invoked", { port: 5599 }), { text: "5599" })).toBe(true);
    expect(matchesFilter(ev("A.Invoked", { port: 1 }), { text: "listening" })).toBe(false);
    expect(matchesFilter(ev("Server.Listening"), { text: "listening" })).toBe(true);
  });

  it("AND-combines fields", () => {
    const f = { suffixes: ["Invoked"], text: "5599" };
    expect(matchesFilter(ev("A.Invoked", { port: 5599 }), f)).toBe(true);
    expect(matchesFilter(ev("A.Failed", { port: 5599 }), f)).toBe(false);
  });

  it("tolerates a non-serializable payload in text search", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(matchesFilter(ev("A.Invoked", cyclic), { text: "A" })).toBe(true);
  });
});

describe("distinctSuffixes", () => {
  it("returns sorted distinct suffixes", () => {
    expect(distinctSuffixes([ev("A.Invoked"), ev("B.Failed"), ev("C.Invoked")])).toEqual([
      "Failed",
      "Invoked",
    ]);
  });
});
