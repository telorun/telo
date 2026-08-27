import { describe, expect, it } from "vitest";

import type { DebugFrame } from "@telorun/debug-wire";
import { portKey, portsResolvedFrom, PORTS_RESOLVED_EVENT } from "./ports-resolved.js";

const frame = (event: string, payload?: unknown): DebugFrame => ({
  kind: "event",
  timestamp: "2026-01-01T00:00:00.000Z",
  event,
  payload,
});

describe("portsResolvedFrom", () => {
  it("reads the declared port set the kernel resolved", () => {
    expect(
      portsResolvedFrom(
        frame(PORTS_RESOLVED_EVENT, {
          ports: [
            { name: "http", port: 3000, protocol: "tcp" },
            { name: "metrics", port: 9100, protocol: "udp" },
          ],
        }),
      ),
    ).toEqual([
      { port: 3000, protocol: "tcp" },
      { port: 9100, protocol: "udp" },
    ]);
  });

  it("reads an empty set as an empty set, not as 'no information'", () => {
    // An app that dropped its last `ports:` entry has to un-route it, so the
    // difference between [] and undefined is load-bearing.
    expect(portsResolvedFrom(frame(PORTS_RESOLVED_EVENT, { ports: [] }))).toEqual([]);
  });

  it("ignores every other frame", () => {
    expect(portsResolvedFrom(frame("Kernel.Started"))).toBeUndefined();
    expect(
      portsResolvedFrom({ kind: "log", timestamp: "", stream: "stdout", line: "x" }),
    ).toBeUndefined();
  });

  it("ignores a payload it cannot make sense of", () => {
    // The runner reads a stream from a kernel it is not versioned with, so an
    // unrecognizable frame is one to skip, never one to fail the session on.
    expect(portsResolvedFrom(frame(PORTS_RESOLVED_EVENT))).toBeUndefined();
    expect(portsResolvedFrom(frame(PORTS_RESOLVED_EVENT, { ports: "3000" }))).toBeUndefined();
    expect(
      portsResolvedFrom(frame(PORTS_RESOLVED_EVENT, { ports: [{ port: "3000" }, { port: 80 }] })),
    ).toEqual([{ port: 80, protocol: "tcp" }]);
  });

  it("defaults an unstated protocol to tcp", () => {
    expect(portsResolvedFrom(frame(PORTS_RESOLVED_EVENT, { ports: [{ port: 80 }] }))).toEqual([
      { port: 80, protocol: "tcp" },
    ]);
  });
});

describe("portKey", () => {
  it("separates the two protocols on one number", () => {
    expect(portKey({ port: 3000, protocol: "tcp" })).not.toBe(
      portKey({ port: 3000, protocol: "udp" }),
    );
  });
});
