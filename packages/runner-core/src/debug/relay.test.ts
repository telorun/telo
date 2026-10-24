import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { DebugEvent, DebugFrame } from "@telorun/debug-wire";
import { afterEach, describe, expect, it } from "vitest";

import { DEBUG_FRAME_MAX_BYTES, relayDebugStream } from "./relay.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function sse(id: number, frame: DebugFrame): string {
  return `id: ${id}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** Serves the frames once, in chunks of `chunk` bytes, then holds the stream open. */
async function serve(frames: string[], chunk: number): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const text = frames.join("");
    for (let at = 0; at < text.length; at += chunk) res.write(text.slice(at, at + chunk));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/events`;
}

describe("the debug relay", () => {
  it("relays a frame over the bound as a stand-in naming its event and size, and the frames around it as written", async () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => ({ id: `r${i}`, vector: [1, i / 1000, 0] }));
    const big: DebugEvent = {
      kind: "event",
      timestamp: "2026-10-24T20:38:37.188Z",
      event: "rows.Invoked",
      payload: { outputs: { rows } },
    };
    const bigText = sse(2, big);
    expect(bigText.length).toBeGreaterThan(DEBUG_FRAME_MAX_BYTES);
    const before: DebugEvent = { kind: "event", timestamp: "2026-10-24T20:38:36.000Z", event: "Kernel.Starting" };
    const after: DebugEvent = { kind: "event", timestamp: "2026-10-24T20:38:39.000Z", event: "Kernel.Stopped" };
    const url = await serve([sse(1, before), bigText, sse(3, after)], 64 * 1024);

    const received: DebugFrame[] = [];
    const abort = new AbortController();
    const relayed = relayDebugStream({
      url,
      signal: abort.signal,
      onFrame: (frame) => {
        received.push(frame);
        if (received.length === 3) abort.abort();
      },
    });
    await relayed;

    expect(received[0]).toEqual(before);
    expect(received[2]).toEqual(after);
    const standIn = received[1] as DebugEvent;
    expect(standIn.event).toBe("rows.Invoked");
    expect(standIn.timestamp).toBe("2026-10-24T20:38:37.188Z");
    expect(standIn.payload).toEqual({
      omitted: expect.stringContaining(`over the ${DEBUG_FRAME_MAX_BYTES} a runner relays`),
      bytes: bigText.length - 2,
    });
  });
});
