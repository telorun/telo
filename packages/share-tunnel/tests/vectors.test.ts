// Replays the client's rows of the protocol vectors (`specs/vectors/`) against
// the engine; the relay's rows are runner-core's to replay.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  readClientControlMessage,
  readRelayControlMessage,
  startShareTunnel,
  type ShareTunnelEvent,
  type SharePort,
} from "../src/index.js";
import { FakeRelay, type RelayConnection } from "./support/fake-relay.js";
import { TestCredentialProvider } from "./support/test-credential-provider.js";

const vectors = (file: string) => JSON.parse(readFileSync(new URL(`../specs/vectors/${file}`, import.meta.url), "utf8"));

interface Codec {
  valid: Array<{ name: string; message: unknown }>;
  invalid: Array<{ name: string; text: string }>;
}
const messages = vectors("messages.json") as { client: Codec; relay: Codec };

type Step =
  | { send: unknown }
  | { sendText: string; padTo?: number }
  | { sendBinary: number }
  | { expect: unknown }
  | { expectBinary: true }
  | { expectOpen: true }
  | { expectClose: number }
  | { close: number }
  | { reconnect: true };
interface Exchange {
  name: string;
  judge: "client" | "relay";
  ports?: SharePort[];
  steps: Step[];
}
const channel = vectors("channel.json") as { exchanges: Exchange[] };

interface UpgradeRow {
  name: string;
  answer: { subprotocol?: string | null; status?: number };
  outcome: string;
  cause?: string;
  warning?: string;
}
interface CloseRow {
  name: string;
  code: number;
  after: "upgrade" | "handshake";
  outcome: string;
  cause?: string;
  lost?: string;
  warning?: string;
}
const closes = vectors("closes.json") as { offered: string[]; upgrades: UpgradeRow[]; closes: CloseRow[] };

const RUNNER_URL = "https://runner.test";
const TIMINGS = { backoffInitialMs: 5, backoffMaxMs: 20, closeGraceMs: 100 };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tunnelTo(relay: FakeRelay, ports?: SharePort[]) {
  const events: ShareTunnelEvent[] = [];
  const tunnel = startShareTunnel({
    tunnelUrl: relay.tunnelUrl,
    runnerUrl: RUNNER_URL,
    credentials: new TestCredentialProvider(),
    ports,
    onEvent: (event) => events.push(event),
    timings: TIMINGS,
  });
  cleanup.push(() => tunnel.close());
  return { tunnel, events };
}

async function relayFor(options?: Parameters<typeof FakeRelay.start>[0]): Promise<FakeRelay> {
  const relay = await FakeRelay.start(options);
  cleanup.push(() => relay.close());
  return relay;
}

describe("messages.json", () => {
  for (const [direction, codec, read] of [
    ["client", messages.client, readClientControlMessage],
    ["relay", messages.relay, readRelayControlMessage],
  ] as const) {
    for (const row of codec.valid) {
      it(`${direction} sends ${row.name}`, () => {
        expect(read(JSON.stringify(row.message))).toEqual({ ok: true, message: row.message });
      });
    }
    for (const row of codec.invalid) {
      it(`${direction} refused: ${row.name}`, () => {
        expect(read(row.text).ok).toBe(false);
      });
    }
  }
});

describe("channel.json", () => {
  for (const row of channel.exchanges.filter((exchange) => exchange.judge === "client")) {
    it(row.name, async () => {
      const relay = await relayFor();
      const { tunnel } = await tunnelTo(relay, row.ports);
      let connection = await relay.nextConnection();
      let closedWith: number | undefined;
      for (const step of row.steps) {
        if ("reconnect" in step) connection = await relay.nextConnection();
        else closedWith = (await play(connection, step)) ?? closedWith;
      }
      if (closedWith === 4400) {
        await expect(tunnel.ended).resolves.toMatchObject({ outcome: "runner-unsupported", cause: "protocol-error" });
      }
    });
  }
});

/** One driver step; answers the close code an `expectClose` saw. */
async function play(connection: RelayConnection, step: Step): Promise<number | undefined> {
  if ("send" in step) connection.ws.send(JSON.stringify(step.send));
  else if ("sendText" in step) connection.ws.send(step.sendText.padEnd(step.padTo ?? 0, " "));
  else if ("sendBinary" in step) connection.ws.send(Buffer.alloc(step.sendBinary));
  else if ("close" in step) connection.close(step.close);
  else if ("expect" in step) {
    const message = await connection.next();
    expect(message.kind).toBe("text");
    expect(JSON.parse((message as { text: string }).text)).toEqual(step.expect);
  } else if ("expectBinary" in step) {
    const message = await connection.next();
    expect(message.kind).toBe("binary");
    await settle();
    connection.takeBinaries();
  } else if ("expectOpen" in step) {
    const pong = new Promise<void>((resolve) => connection.ws.once("pong", () => resolve()));
    connection.ws.ping();
    await pong;
    await settle();
    connection.takeBinaries();
    expect(connection.ws.readyState).toBe(connection.ws.OPEN);
    expect(connection.queued()).toEqual([]);
  } else if ("expectClose" in step) {
    for (;;) {
      const message = await connection.next();
      if (message.kind === "binary") continue;
      expect(message).toMatchObject({ kind: "close", code: step.expectClose });
      return step.expectClose;
    }
  }
  return undefined;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("closes.json", () => {
  for (const row of closes.upgrades) {
    it(row.name, async () => {
      const relay = await relayFor(row.answer);
      const { tunnel, events } = await tunnelTo(relay);
      if (row.outcome === "retry") {
        await waitFor(() => relay.attempts >= 3);
        expect(warnings(events, row.warning!)).toHaveLength(1);
        return;
      }
      await expect(tunnel.ended).resolves.toMatchObject({ outcome: row.outcome, cause: row.cause, offered: closes.offered });
      expect(relay.attempts).toBe(1);
    });
  }

  for (const row of closes.closes) {
    it(`${row.code} after the ${row.after}: ${row.name}`, async () => {
      const relay = await relayFor();
      const { tunnel, events } = await tunnelTo(relay);
      const closeOnce = async () => {
        const connection = await relay.nextConnection();
        await connection.nextControl();
        if (row.after === "handshake") connection.sendControl({ type: "hello", epoch: 1 });
        connection.close(row.code, `closed by the vector: ${row.name}`);
        await connection.closed;
      };
      await closeOnce();
      if (row.outcome === "retry") {
        if (row.after === "upgrade") await closeOnce();
        await relay.nextConnection();
        expect(warnings(events, row.warning!)).toEqual([
          { type: "warning", reason: row.warning, code: row.code, detail: `closed by the vector: ${row.name}` },
        ]);
        return;
      }
      const ending = await tunnel.ended;
      if (row.outcome === "lost") {
        expect(ending).toEqual({ outcome: "lost", reason: row.lost, code: row.code, detail: `closed by the vector: ${row.name}` });
      } else {
        expect(ending).toMatchObject({ outcome: row.outcome, cause: row.cause, offered: closes.offered });
      }
      expect(relay.connections).toHaveLength(1);
    });
  }
});

function warnings(events: ShareTunnelEvent[], reason: string): ShareTunnelEvent[] {
  return events.filter((event) => event.type === "warning" && event.reason === reason);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await settle();
  }
}
