import { describe, expect, it } from "vitest";
import { millisOfTimestamp } from "../src/instants.js";
import { ERR_SESSION_CONTENDED } from "../src/session-index.js";
import { ERR_SESSION_NOT_FOUND } from "../src/sessions-controller.js";
import { ERR_SESSION_STORE_INCONSISTENT, ERR_SESSION_STORE_UNAVAILABLE } from "../src/session-store.js";
import { AlwaysConflictingStore, Clock, CountingStore, SETTINGS, principalFor, sessionsOver } from "./fakes.js";

function setup(settings = SETTINGS) {
  const clock = new Clock();
  const store = new CountingStore(clock);
  return { clock, store, sessions: sessionsOver(store, clock, settings) };
}

const reasonOf = async (sessions: ReturnType<typeof sessionsOver>, token: string) => {
  const verdict = await sessions.verify(token);
  return verdict.accepted ? "accepted" : verdict.reason;
};

describe("start and verify", () => {
  it("accepts the token it issued and reads the principal back", async () => {
    const { sessions } = setup();
    const issued = await sessions.start({ principal: principalFor("alice"), userAgent: "ua", address: "10.0.0.1" });
    const verdict = await sessions.verify(issued.token);
    expect(verdict.accepted && verdict.record.principal.subject).toBe("alice");
    expect(issued.sessionId).toMatch(/^ses_[0-9A-Za-z]{22}$/);
    expect(issued.token).toHaveLength(65);
    expect(issued.cookieExpiresAt).toBeNull();
  });

  it("mints a fresh id on every start, so a session cannot be fixed", async () => {
    const { sessions } = setup();
    const first = await sessions.start({ principal: principalFor("alice") });
    const second = await sessions.start({ principal: principalFor("alice") });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("gives a persistent session a cookie expiry at its absolute deadline", async () => {
    const { sessions, clock } = setup();
    const issued = await sessions.start({ principal: principalFor("alice"), persistent: true });
    expect(millisOfTimestamp(issued.cookieExpiresAt!)).toBe(clock.now + SETTINGS.persistent!.absoluteMs);
  });

  it("refuses a persistent session when the set declares no persistent lifetimes", async () => {
    const { sessions } = setup({ ...SETTINGS, persistent: null });
    await expect(sessions.start({ principal: principalFor("alice"), persistent: true })).rejects.toThrow(/persistent/);
  });
});

describe("refusal reasons", () => {
  it("malformed: a token of the wrong length or alphabet", async () => {
    const { sessions } = setup();
    expect(await reasonOf(sessions, "short")).toBe("malformed");
    expect(await reasonOf(sessions, "!".repeat(65))).toBe("malformed");
  });

  it("unknown: no such session, or a validator that does not match", async () => {
    const { sessions } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    expect(await reasonOf(sessions, "A".repeat(65))).toBe("unknown");
    const tampered = issued.token.slice(0, -1) + (issued.token.endsWith("a") ? "b" : "a");
    expect(await reasonOf(sessions, tampered)).toBe("unknown");
  });

  it("ended: a session no longer listed for its subject", async () => {
    const { sessions } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    await sessions.endAll("alice");
    expect(await reasonOf(sessions, issued.token)).toBe("ended");
  });

  it("expired: past the idle timeout, and past the absolute lifetime however busy", async () => {
    const { sessions, clock } = setup();
    const idle = await sessions.start({ principal: principalFor("alice") });
    clock.advance(SETTINGS.normal.idleMs);
    expect(await reasonOf(sessions, idle.token)).toBe("expired");

    const busy = await sessions.start({ principal: principalFor("bob") });
    for (let elapsed = 0; elapsed < SETTINGS.normal.absoluteMs; elapsed += SETTINGS.normal.idleMs / 2) {
      expect(await reasonOf(sessions, busy.token)).toBe("accepted");
      clock.advance(SETTINGS.normal.idleMs / 2);
    }
    expect(await reasonOf(sessions, busy.token)).toBe("expired");
  });
});

describe("ending", () => {
  it("End ends the subject's own session and says false for another subject's", async () => {
    const { sessions } = setup();
    const alice = await sessions.start({ principal: principalFor("alice") });
    expect(await sessions.end("bob", alice.sessionId)).toBe(false);
    expect(await reasonOf(sessions, alice.token)).toBe("accepted");
    expect(await sessions.end("alice", alice.sessionId)).toBe(true);
    expect(await reasonOf(sessions, alice.token)).toBe("ended");
  });

  it("EndAll is one write and keeps the excepted session", async () => {
    const { sessions, store } = setup();
    const kept = await sessions.start({ principal: principalFor("alice") });
    const other = await sessions.start({ principal: principalFor("alice") });
    const before = store.writes.length;
    const ended = await sessions.endAll("alice", kept.sessionId);
    expect(store.writes.length - before).toBe(1);
    expect(ended).toEqual([other.sessionId]);
    expect(await reasonOf(sessions, kept.token)).toBe("accepted");
    expect(await reasonOf(sessions, other.token)).toBe("ended");
  });
});

describe("rotate", () => {
  it("swaps the old id for a new one in one index write and keeps the absolute deadline", async () => {
    const { sessions, store, clock } = setup();
    const old = await sessions.start({ principal: principalFor("alice") });
    clock.advance(1000);
    const indexWrites = () => store.writes.filter((w) => w.key.includes("/u/")).length;
    const before = indexWrites();
    const rotated = await sessions.rotate({ sessionId: old.sessionId, subject: "alice" });
    expect(indexWrites() - before).toBe(1);
    expect(await reasonOf(sessions, old.token)).toBe("ended");
    expect(await reasonOf(sessions, rotated.token)).toBe("accepted");
    const verdict = await sessions.verify(rotated.token);
    expect(verdict.accepted && verdict.record.expiresAt).toBe(clock.now - 1000 + SETTINGS.normal.absoluteMs);
  });

  it("refuses a session the subject does not hold, ended, expired or another's, and changes nothing", async () => {
    const { sessions, store, clock } = setup();
    const alice = await sessions.start({ principal: principalFor("alice") });
    const ended = await sessions.start({ principal: principalFor("alice") });
    await sessions.end("alice", ended.sessionId);
    const expiring = await sessions.start({ principal: principalFor("carol") });
    clock.advance(SETTINGS.normal.idleMs);
    const live = await sessions.start({ principal: principalFor("alice") });
    const writes = store.writes.length;

    for (const [subject, sessionId] of [
      ["bob", live.sessionId],
      ["alice", ended.sessionId],
      ["carol", expiring.sessionId],
      ["alice", alice.sessionId],
    ] as const) {
      await expect(sessions.rotate({ sessionId, subject })).rejects.toMatchObject({ code: ERR_SESSION_NOT_FOUND });
    }
    expect(store.writes.length).toBe(writes);
  });

  it("ends a session once: true, then false without an error", async () => {
    const { sessions } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    expect(await sessions.end("alice", issued.sessionId)).toBe(true);
    expect(await sessions.end("alice", issued.sessionId)).toBe(false);
  });
});

describe("the per-subject index", () => {
  it("ends the oldest session past maxPerSubject and reports it", async () => {
    const { sessions } = setup();
    const issued = [];
    for (let i = 0; i < 3; i++) issued.push(await sessions.start({ principal: principalFor("alice") }));
    const fourth = await sessions.start({ principal: principalFor("alice") });
    expect(fourth.ended).toEqual([issued[0]!.sessionId]);
    expect(await reasonOf(sessions, issued[0]!.token)).toBe("ended");
    expect(await reasonOf(sessions, issued[1]!.token)).toBe("accepted");
    expect((await sessions.list("alice")).map((s) => s.id)).toEqual([
      issued[1]!.sessionId,
      issued[2]!.sessionId,
      fourth.sessionId,
    ]);
  });

  it("does not list a session whose record was never written", async () => {
    const { sessions, store } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    store.writes.length = 0;
    expect((await sessions.list("alice")).map((s) => s.id)).toEqual([issued.sessionId]);
    expect(await sessions.list("nobody")).toEqual([]);
  });
});

describe("sliding the idle deadline", () => {
  it("writes a session at most about ten times per idle period under steady traffic", async () => {
    const { sessions, store, clock } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    store.writes.length = 0;
    const step = SETTINGS.normal.idleMs / 1000;
    for (let i = 0; i < 1000; i++) {
      clock.advance(step);
      expect(await reasonOf(sessions, issued.token)).toBe("accepted");
    }
    const slides = store.writes.filter((w) => w.op === "compareAndSet").length;
    expect(slides).toBeGreaterThanOrEqual(9);
    expect(slides).toBeLessThanOrEqual(11);
  });

  it("treats a slide that loses to another replica as an outcome", async () => {
    const { sessions, store, clock } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    clock.advance(SETTINGS.normal.idleMs / 5);
    store.compareAndSet = async () => null;
    expect(await reasonOf(sessions, issued.token)).toBe("accepted");
  });
});

describe("contention", () => {
  it("gives up with ERR_SESSION_CONTENDED after bounded re-applies of a conflicting write", async () => {
    const clock = new Clock();
    const store = new AlwaysConflictingStore(clock);
    const sessions = sessionsOver(store, clock);
    await expect(sessions.start({ principal: principalFor("alice") })).rejects.toMatchObject({ code: ERR_SESSION_CONTENDED });
    expect(store.reads).toBe(8);
  });
});

class ThrowingStore extends CountingStore {
  constructor(clock: Clock, private readonly failure: unknown) {
    super(clock);
  }
  async get(): Promise<never> {
    throw this.failure;
  }
  async putIfAbsent(): Promise<never> {
    throw this.failure;
  }
  async compareAndSet(): Promise<never> {
    throw this.failure;
  }
  async compareAndDelete(): Promise<never> {
    throw this.failure;
  }
}

describe("a failing store", () => {
  const token = "A".repeat(65);
  const calls: [string, (s: ReturnType<typeof sessionsOver>) => Promise<unknown>][] = [
    ["start", (s) => s.start({ principal: principalFor("alice") })],
    ["rotate", (s) => s.rotate({ sessionId: "ses_" + "a".repeat(22), subject: "alice" })],
    ["end", (s) => s.end("alice", "ses_" + "a".repeat(22))],
    ["endAll", (s) => s.endAll("alice")],
    ["list", (s) => s.list("alice")],
    ["verify", (s) => s.verify(token)],
  ];

  it.each(calls)("%s raises ERR_SESSION_STORE_UNAVAILABLE with the store's error as the cause", async (_name, call) => {
    const clock = new Clock();
    const failure = new Error("connection refused");
    const sessions = sessionsOver(new ThrowingStore(clock, failure), clock);
    await expect(call(sessions)).rejects.toMatchObject({ code: ERR_SESSION_STORE_UNAVAILABLE, cause: failure });
  });

  it("wraps the write of a slide too", async () => {
    const { sessions, store, clock } = setup();
    const issued = await sessions.start({ principal: principalFor("alice") });
    clock.advance(SETTINGS.normal.idleMs / 5);
    const failure = new Error("disk full");
    store.compareAndSet = async () => {
      throw failure;
    };
    await expect(sessions.verify(issued.token)).rejects.toMatchObject({ code: ERR_SESSION_STORE_UNAVAILABLE, cause: failure });
  });

  it("lets a cancellation through unchanged", async () => {
    const clock = new Clock();
    const cancelled = Object.assign(new Error("cancelled"), { code: "ERR_INVOKE_CANCELLED" });
    const sessions = sessionsOver(new ThrowingStore(clock, cancelled), clock);
    await expect(sessions.list("alice")).rejects.toBe(cancelled);
  });
});

describe("a store that takes a freshly minted id", () => {
  it("is ERR_SESSION_STORE_INCONSISTENT after one index append, evicting no live session", async () => {
    const { sessions, store } = setup();
    const kept = [];
    for (let i = 0; i < 2; i++) kept.push(await sessions.start({ principal: principalFor("alice") }));
    const indexWrites = () => store.writes.filter((w) => w.key.includes("/u/")).length;
    const before = indexWrites();
    store.putIfAbsent = async () => null;
    await expect(sessions.start({ principal: principalFor("alice") })).rejects.toMatchObject({
      code: ERR_SESSION_STORE_INCONSISTENT,
    });
    expect(indexWrites() - before).toBe(1);
    for (const session of kept) expect(await reasonOf(sessions, session.token)).toBe("accepted");
  });
});
