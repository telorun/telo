import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it, vi } from "vitest";
import { create } from "../src/channel-controller.js";
import { PostgresBroadcastChannel } from "../src/postgres-channel.js";

const settings = { name: "rooms", messageType: { type: "object" }, maxBytes: 1024 };

function fixture(zones: unknown[] = []) {
  let notify: ((payload: string | undefined) => void) | undefined;
  let reconnect: (() => void) | undefined;
  const unlisten = vi.fn(async () => {});
  const connection = {
    listen: vi.fn(async (_channel: string, onNotify: any, options: any) => {
      notify = onNotify;
      reconnect = options.onReconnect;
      return unlisten;
    }),
    notify: vi.fn(async () => {}),
    execute: vi.fn(async () => ({})),
    bindsZone: (zone: unknown) => zones.includes(zone),
  };
  const ctx = { zonesFor: () => zones } as unknown as ResourceContext;
  const channel = new PostgresBroadcastChannel(settings, connection as any, ctx);
  return { channel, connection, unlisten, notify: (p?: string) => notify!(p), reconnect: () => reconnect!() };
}

describe("PostgresBroadcastChannel", () => {
  it("listens once for all subscriptions, relays payloads and gaps, and releases with the last", async () => {
    const { channel, connection, unlisten, notify, reconnect } = fixture();
    const a = { receive: vi.fn(), gap: vi.fn() };
    const b = { receive: vi.fn(), gap: vi.fn() };
    const first = await channel.subscribe(a);
    const second = await channel.subscribe(b);
    expect(connection.listen).toHaveBeenCalledTimes(1);
    expect(connection.listen.mock.calls[0]![0]).toBe("telo_broadcast_rooms");

    notify('{"message":{}}');
    expect(a.receive).toHaveBeenCalledWith('{"message":{}}');
    expect(b.receive).toHaveBeenCalledWith('{"message":{}}');
    reconnect();
    expect(a.gap).toHaveBeenCalledTimes(1);
    expect(b.gap).toHaveBeenCalledTimes(1);

    await first.close();
    expect(unlisten).not.toHaveBeenCalled();
    await second.close();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("notifies inside the caller's open transaction, and directly outside one", async () => {
    const zone = { kind: "transaction" };
    const inside = fixture([zone]);
    await inside.channel.publish("p");
    expect(inside.connection.execute).toHaveBeenCalledWith(
      "SELECT pg_notify($1, $2)",
      ["telo_broadcast_rooms", "p"],
      zone,
      undefined,
    );
    expect(inside.connection.notify).not.toHaveBeenCalled();

    const outside = fixture();
    await outside.channel.publish("p");
    expect(outside.connection.notify).toHaveBeenCalledWith("telo_broadcast_rooms", "p");
  });
});

describe("create", () => {
  it("refuses a bound above the notification payload limit", async () => {
    const ctx = { lookupSchema: () => undefined, resolveRef: () => ({}) } as unknown as ResourceContext;
    await expect(
      create(
        { metadata: { name: "c" }, name: "rooms", messageType: { schema: { type: "object" } }, maxBytes: 8000, connection: {} },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ERR_BROADCAST_MAX_BYTES_EXCEEDS_BACKEND" });
  });
});
