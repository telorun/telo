import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../session-store/session-store.js";
import { SessionRegistry } from "./registry.js";

function record(id: string, apps: string[]): SessionRecord {
  const now = new Date();
  return {
    id,
    owner: { kind: "secret", secretHash: "0".repeat(64) },
    workspace: id,
    agent: null,
    apps: apps.map((name) => ({ name, entryRelativePath: `${name}.yaml`, ports: [] })),
    config: {},
    status: "running",
    createdAt: now,
    lastActiveAt: now,
    suspendedAt: null,
    containerEngine: null,
  };
}

describe("byte channels are per app", () => {
  it("routes a push to the named app and drops one for an unknown name", () => {
    const registry = new SessionRegistry({ replayBufferBytes: 100_000 });
    const entry = registry.register(record("s1", ["web", "worker"]), { kind: "running" });

    registry.pushBytes("s1", "web", Buffer.from("hello"));
    expect(entry.apps.get("web")!.byteBuffer.size).toBe(1);
    expect(entry.apps.get("worker")!.byteBuffer.size).toBe(0);

    expect(registry.pushBytes("s1", "nope", Buffer.from("x"))).toBeUndefined();
  });

  it("carries the stream tag through the buffer", () => {
    const registry = new SessionRegistry({ replayBufferBytes: 100_000 });
    registry.register(record("s1", ["app"]), { kind: "running" });
    registry.pushBytes("s1", "app", Buffer.from("out"), "stdout");
    registry.pushBytes("s1", "app", Buffer.from("err"), "stderr");

    const entries = registry.get("s1")!.apps.get("app")!.byteBuffer.replay(0).entries;
    expect(entries.map((e) => e.stream)).toEqual(["stdout", "stderr"]);
  });
});
