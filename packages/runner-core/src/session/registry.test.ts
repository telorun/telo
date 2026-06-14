import { describe, expect, it } from "vitest";

import { SessionLimitError, SessionRegistry } from "./registry.js";

const deps = { maxSessions: 2, exitTtlMs: 60_000, replayBufferBytes: 10_000 };

function markExited(reg: SessionRegistry, sessionId: string): void {
  reg.emit(sessionId, { type: "status", status: { kind: "exited", code: 0 } });
}

describe("SessionRegistry capacity", () => {
  it("evicts the oldest terminal session to admit a new run at capacity", () => {
    const reg = new SessionRegistry(deps);
    reg.register({ sessionId: "a" });
    reg.register({ sessionId: "b" });
    markExited(reg, "a");

    // At capacity (2). The retained exited session yields to the new run.
    reg.register({ sessionId: "c" });

    expect(reg.has("a")).toBe(false);
    expect(reg.has("b")).toBe(true);
    expect(reg.has("c")).toBe(true);
  });

  it("rejects a new run when every session is still live", () => {
    const reg = new SessionRegistry(deps);
    reg.register({ sessionId: "a" });
    reg.register({ sessionId: "b" });

    expect(() => reg.register({ sessionId: "c" })).toThrow(SessionLimitError);
    expect(reg.size()).toBe(2);
  });
});
