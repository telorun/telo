import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  needsProcesses,
  runExchange,
  supervisorVectors,
  type ExchangeVectors,
} from "../test-support/supervisor-exchange.js";
import { FakeSupervisor } from "./fake-supervisor.js";
import { SUPERVISOR_GENERATION, SUPERVISOR_PATH, type RunnerMessage } from "./supervisor-protocol.js";

interface RunnerMessageVectors {
  runner: {
    valid: Array<{ name: string; message: RunnerMessage }>;
    invalid: Array<{ name: string; text: string; close: number }>;
  };
}

const TOKEN = "vector-token";
const exchanges = supervisorVectors<ExchangeVectors>("exchanges.json").exchanges;
const messages = supervisorVectors<RunnerMessageVectors>("messages.json").runner;

let fake: FakeSupervisor | undefined;

async function startFake(): Promise<FakeSupervisor> {
  fake = await FakeSupervisor.start({ host: "127.0.0.1", port: 0, token: TOKEN, generation: SUPERVISOR_GENERATION });
  return fake;
}

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** A connection that has said hello, and every text message and close it receives. */
async function greeted(supervisor: FakeSupervisor, first?: string): Promise<{
  socket: WebSocket;
  texts: Array<Record<string, unknown>>;
  closed: Promise<number>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${supervisor.port}${SUPERVISOR_PATH}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const texts: Array<Record<string, unknown>> = [];
  socket.on("message", (data, isBinary) => {
    if (!isBinary) texts.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(first ?? JSON.stringify({ type: "hello", generation: SUPERVISOR_GENERATION, lastSeq: 0 }));
  return { socket, texts, closed };
}

// The fake runs no program, so the vectors that start one or signal the
// supervisor's own process are the real executable's alone.
describe("the fake supervisor answers the exchange vectors", () => {
  it.each(exchanges.filter((exchange) => !needsProcesses(exchange.steps)))("$name", async ({ steps }) => {
    const supervisor = await startFake();
    await runExchange({ host: "127.0.0.1", port: supervisor.port, token: TOKEN }, steps);
  });
});

describe("the fake supervisor reads the runner's message vectors", () => {
  it.each(messages.valid.filter((vector) => vector.message.type !== "hello"))(
    "accepts the runner's $name",
    async ({ message }) => {
      const supervisor = await startFake();
      const connection = await greeted(supervisor);
      connection.socket.send(JSON.stringify(message));
      // An answer to a later message proves the connection survived this one.
      connection.socket.send(JSON.stringify({ type: "stop", runId: "probe", graceMs: 0 }));
      await expect.poll(() => connection.texts.at(-1)).toEqual({ type: "refused", runId: "probe", code: "no_run" });
      expect(supervisor.received[1]).toEqual(message);
    },
  );

  it.each(messages.valid.filter((vector) => vector.message.type === "hello"))(
    "accepts the runner's $name",
    async ({ message }) => {
      const supervisor = await startFake();
      const connection = await greeted(supervisor, JSON.stringify(message));
      await expect.poll(() => connection.texts[0]).toMatchObject({ type: "hello", state: "idle" });
      expect(supervisor.received).toEqual([message]);
    },
  );

  // A refused hello is the first message; any other is refused after one.
  it.each(messages.invalid)("closes on the runner's $name", async ({ text, close }) => {
    const supervisor = await startFake();
    const isHello = text.includes('"type":"hello"');
    const connection = await greeted(supervisor, isHello ? text : undefined);
    if (!isHello) connection.socket.send(text);
    expect(await connection.closed).toBe(close);
  });
});
