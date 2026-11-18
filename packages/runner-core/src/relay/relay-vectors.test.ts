// Replays the relay's rows of the share tunnel protocol vectors
// (`@telorun/share-tunnel/specs/vectors/`) against the relay, as spec § 9 says:
// `messages.json` both ways, and every `judge: "relay"` exchange of
// `channel.json` over a real WebSocket.

import { createRequire } from "node:module";

import {
  encodeControlMessage,
  readClientControlMessage,
  readRelayControlMessage,
  tunnelProofUrl,
} from "@telorun/share-tunnel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomBase32 } from "../session/session-id.js";
import { temporaryStore } from "../test-support/fake-workload-backend.js";
import { MemoryShareStore } from "../test-support/memory-share-store.js";
import { startRelay, TunnelDriver, type RelayUnderTest } from "../test-support/share-relay-harness.js";
import { TestIssuer, type TestUser } from "../test-support/test-identity.js";

const require = createRequire(import.meta.url);
const vectors = (file: string) => require(`@telorun/share-tunnel/specs/vectors/${file}`) as unknown;

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
  | { close: number };
interface Exchange {
  name: string;
  judge: "client" | "relay";
  share?: { epoch: number } | null;
  steps: Step[];
}
const channel = vectors("channel.json") as { exchanges: Exchange[] };

let jti: Awaited<ReturnType<typeof temporaryStore>>;
let shares: MemoryShareStore;
let relay: RelayUnderTest;
let user: TestUser;

beforeAll(async () => {
  const issuer = await TestIssuer.create();
  user = await issuer.user("vector-user");
  jti = await temporaryStore();
  shares = new MemoryShareStore();
  // Every row connects a share of one owner; no row is about the limits.
  relay = await startRelay({
    issuer,
    shares,
    jti: jti.store,
    settings: { maxConnected: 1_000, maxConnectedPerOwner: 1_000 },
  });
});

afterAll(async () => {
  await relay.close();
  await jti.dispose();
});

/** A share the user owns at `epoch`, or the id of none. */
async function shareFor(state: { epoch: number } | null): Promise<string> {
  if (state === null) return randomBase32(12);
  const created = await shares.createShare({
    owner: { kind: "identity", iss: "https://id.share.test", sub: user.sub },
    name: randomBase32(12),
    application: "Vectors",
    now: new Date(),
    maxPerOwner: 1_000,
  });
  if (created.kind !== "created") throw new Error(`no share: ${created.kind}`);
  shares.shares.get(created.share.id)!.epoch = state.epoch;
  return created.share.id;
}

async function openTunnel(shareId: string): Promise<TunnelDriver> {
  const url = relay.tunnelUrl(shareId);
  const { accessToken } = await user.token();
  const proof = await user.proof(accessToken, { htm: "GET", htu: tunnelProofUrl(url) });
  return TunnelDriver.open(url, { authorization: `DPoP ${accessToken}`, dpop: proof });
}

describe("messages.json", () => {
  for (const row of messages.client.valid) {
    it(`the relay reads the client's ${row.name}`, () => {
      expect(readClientControlMessage(JSON.stringify(row.message))).toEqual({ ok: true, message: row.message });
    });
  }
  for (const row of messages.client.invalid) {
    it(`the relay closes 4400 on the client's ${row.name}`, async () => {
      const driver = await openTunnel(await shareFor({ epoch: 0 }));
      // A hello is judged as the first message; anything else after the handshake.
      if (!/"type":"hello"/.test(row.text)) {
        driver.send({ type: "hello", epoch: null });
        expect(await driver.next()).toEqual({ kind: "text", text: '{"type":"hello","epoch":1}' });
      }
      driver.ws.send(row.text);
      expect((await driver.nextClose()).code).toBe(4400);
    });
  }
  for (const row of messages.relay.valid) {
    it(`the relay sends ${row.name} as the client reads it`, () => {
      const text = encodeControlMessage(row.message as { type: "hello"; epoch: number });
      expect(readRelayControlMessage(text)).toEqual({ ok: true, message: row.message });
    });
  }
});

describe("channel.json", () => {
  for (const row of channel.exchanges.filter((exchange) => exchange.judge === "relay")) {
    it(row.name, async () => {
      const driver = await openTunnel(await shareFor(row.share ?? null));
      for (const step of row.steps) await play(driver, step);
    });
  }
});

async function play(driver: TunnelDriver, step: Step): Promise<void> {
  if ("send" in step) driver.send(step.send);
  else if ("sendText" in step) driver.ws.send(step.sendText.padEnd(step.padTo ?? 0, " "));
  else if ("sendBinary" in step) driver.ws.send(Buffer.alloc(step.sendBinary));
  else if ("close" in step) driver.ws.close(step.close);
  else if ("expect" in step) {
    const message = await driver.next();
    expect(message.kind).toBe("text");
    expect(JSON.parse((message as { text: string }).text)).toEqual(step.expect);
  } else if ("expectBinary" in step) {
    expect((await driver.next()).kind).toBe("binary");
    await settle();
    driver.takeBinaries();
  } else if ("expectOpen" in step) {
    const pong = new Promise<void>((resolve) => driver.ws.once("pong", () => resolve()));
    driver.ws.ping();
    await pong;
    await settle();
    driver.takeBinaries();
    expect(driver.ws.readyState).toBe(driver.ws.OPEN);
    expect(driver.queued()).toEqual([]);
  } else if ("expectClose" in step) {
    expect((await driver.nextClose()).code).toBe(step.expectClose);
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
