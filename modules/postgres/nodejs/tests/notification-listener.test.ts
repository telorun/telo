import { EventEmitter } from "node:events";
import type { Logger } from "@telorun/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationListener } from "../src/notification-listener.js";

const clients = vi.hoisted(() => [] as Array<any>);

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  const { vi } = await import("vitest");
  class Client extends EventEmitter {
    readonly queries: string[] = [];
    connect = vi.fn(async () => {});
    end = vi.fn(async () => {});
    async query(sql: string) {
      this.queries.push(sql);
    }
    constructor() {
      super();
      clients.push(this);
    }
  }
  return { Client };
});

const log = new Proxy({}, { get: () => () => {} }) as unknown as Logger;

describe("NotificationListener reconnect notice", () => {
  afterEach(() => {
    clients.length = 0;
    vi.useRealTimers();
  });

  it("tells a subscriber once its connection was re-established and its subscriptions replayed", async () => {
    vi.useFakeTimers();
    const listener = new NotificationListener({}, log);
    const onReconnect = vi.fn();
    const onNotify = vi.fn();
    await listener.listen("jobs", onNotify, { onReconnect });
    const first = clients[0] as EventEmitter & { queries: string[] };

    first.emit("end");
    expect(onReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(clients).toHaveLength(2);
    expect(clients[1].queries).toEqual(['LISTEN "jobs"']);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    clients[1].emit("notification", { channel: "jobs", payload: "x" });
    expect(onNotify).toHaveBeenCalledWith("x");
    await listener.close();
  });

  it("keeps listen(channel, handler) working without options", async () => {
    vi.useFakeTimers();
    const listener = new NotificationListener({}, log);
    await listener.listen("jobs", () => {});
    clients[0].emit("end");
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    await listener.close();
  });
});
