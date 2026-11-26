import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import WebSocket from "ws";

import type { ByteStreamTag } from "../contract.js";
import {
  SUPERVISOR_PATH,
  SUPERVISOR_PORT_FORWARD_PATH,
  decodeOutputFrame,
  decodeSupervisorMessage,
} from "../supervisor/supervisor-protocol.js";
import { SUPERVISOR_VECTORS } from "./supervisor-binary.js";

/** One step of an exchange vector (format: `supervisor/README.md`). */
export type ExchangeStep = Record<string, unknown> & { on?: string; withinMs?: number };

export interface ExchangeVectors {
  workspace: Record<string, string>;
  exchanges: Array<{ name: string; steps: ExchangeStep[] }>;
}

export function supervisorVectors<T>(name: string): T {
  return JSON.parse(readFileSync(join(SUPERVISOR_VECTORS, name), "utf8")) as T;
}

/** A listening supervisor; `process` is the real executable's, which the
 *  steps that signal or await the supervisor itself need. */
export interface ExchangeTarget {
  host: string;
  port: number;
  token: string;
  process?: ChildProcess;
}

/** Whether an exchange needs a program run or the supervisor's own process:
 *  a `run`, a signal to the supervisor, or its exit. */
export function needsProcesses(steps: ExchangeStep[]): boolean {
  return steps.some(
    (step) =>
      (typeof step.send === "object" && step.send !== null && (step.send as { type?: unknown }).type === "run") ||
      step.signalSupervisor !== undefined ||
      step.expectSupervisorExit !== undefined,
  );
}

const DEFAULT_WITHIN_MS = 5_000;

function requireProcess(supervisor: ExchangeTarget, fail: (message: string) => Error): ChildProcess {
  if (!supervisor.process) throw fail("this step needs the supervisor's own process");
  return supervisor.process;
}

type Received =
  | { kind: "invalid"; message: string }
  | { kind: "text"; value: Record<string, unknown> }
  | { kind: "frame"; seq: number; stream: ByteStreamTag; payload: Buffer }
  | { kind: "bytes"; payload: Buffer }
  | { kind: "closed"; code: number };

/** The flood pattern: byte `i` is `i % 251`. */
function floodByte(offset: number): number {
  return offset % 251;
}

/** A loopback listener an exchange forwards to (`listen`). */
class Listener {
  accepted = 0;
  open = 0;
  /** A flood listener's every byte was handed to the system. */
  finished = false;

  private constructor(
    readonly server: Server,
    readonly port: number,
  ) {}

  static async start(serve: unknown): Promise<Listener> {
    const flood = typeof serve === "object" && serve !== null ? (serve as { flood?: unknown }).flood : undefined;
    if (serve !== "echo" && typeof flood !== "number") {
      throw new Error(`a listener serves "echo" or { "flood": <bytes> }, got ${JSON.stringify(serve)}`);
    }
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const listener = new Listener(server, (server.address() as AddressInfo).port);
    server.on("connection", (socket) => {
      listener.accepted += 1;
      listener.open += 1;
      socket.on("close", () => (listener.open -= 1));
      socket.on("error", () => socket.destroy());
      if (typeof flood === "number") listener.flood(socket, flood);
      else socket.pipe(socket);
    });
    return listener;
  }

  private flood(socket: Socket, total: number): void {
    let offset = 0;
    let written = 0;
    const next = (): void => {
      while (offset < total) {
        const length = Math.min(64 * 1024, total - offset);
        const chunk = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) chunk[i] = floodByte(offset + i);
        offset += length;
        const more = socket.write(chunk, () => {
          written += length;
          if (written === total) this.finished = true;
        });
        if (!more) return void socket.once("drain", next);
      }
      socket.end();
    };
    next();
  }

  close(): void {
    this.server.close();
  }
}

/** One scripted connection: everything it receives, in order. */
class ScriptedConnection {
  private readonly queue: Received[] = [];
  private waiter: (() => void) | undefined;
  readonly output = new Map<ByteStreamTag, Array<{ seq: number; payload: Buffer }>>();
  private lastFrameSeq: number | undefined;

  /** `raw` is a port forward, whose binary frames are bytes. */
  constructor(
    readonly socket: WebSocket,
    readonly raw: boolean,
  ) {
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      // Through the runner's decoders: what the supervisor sends must be what it reads.
      try {
        if (isBinary && raw) {
          this.push({ kind: "bytes", payload: bytes });
        } else if (isBinary) {
          const frame = decodeOutputFrame(bytes);
          this.push({ kind: "frame", seq: frame.seq, stream: frame.stream, payload: frame.payload });
        } else {
          const value = decodeSupervisorMessage(bytes.toString("utf8")) as unknown as Record<string, unknown>;
          this.push({ kind: "text", value });
        }
      } catch (error) {
        this.push({ kind: "invalid", message: `the supervisor sent what the runner refuses: ${(error as Error).message}` });
      }
    });
    socket.on("close", (code) => this.push({ kind: "closed", code }));
    socket.on("error", (error) => this.push({ kind: "invalid", message: `the connection failed: ${error.message}` }));
  }

  private push(received: Received): void {
    this.queue.push(received);
    this.waiter?.();
  }

  async receive(withinMs: number): Promise<Exclude<Received, { kind: "invalid" }> | undefined> {
    const deadline = Date.now() + withinMs;
    while (this.queue.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
      this.waiter = undefined;
    }
    const next = this.queue.shift()!;
    if (next.kind === "invalid") throw new Error(next.message);
    if (next.kind === "frame") {
      if (this.lastFrameSeq !== undefined && next.seq !== this.lastFrameSeq + 1) {
        throw new Error(`frame seq ${next.seq} after ${this.lastFrameSeq}`);
      }
      this.lastFrameSeq = next.seq;
    }
    return next;
  }

  keep(frame: Extract<Received, { kind: "frame" }>): void {
    const list = this.output.get(frame.stream) ?? [];
    list.push({ seq: frame.seq, payload: frame.payload });
    this.output.set(frame.stream, list);
  }
}

/** Plays one exchange's steps against a supervisor, failing at the first step
 *  whose answer differs from the vector's. */
export async function runExchange(supervisor: ExchangeTarget, steps: ExchangeStep[]): Promise<void> {
  const connections = new Map<string, ScriptedConnection>();
  const recorded = new Map<string, number>();
  const listeners = new Map<string, Listener>();
  try {
    await playSteps(supervisor, steps, connections, recorded, listeners);
  } finally {
    for (const connection of connections.values()) connection.socket.terminate();
    for (const listener of listeners.values()) listener.close();
  }
}

async function playSteps(
  supervisor: ExchangeTarget,
  steps: ExchangeStep[],
  connections: Map<string, ScriptedConnection>,
  recorded: Map<string, number>,
  listeners: Map<string, Listener>,
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const fail = (message: string): Error => new Error(`step ${index} (${JSON.stringify(step)}): ${message}`);
    const within = step.withinMs ?? DEFAULT_WITHIN_MS;
    if (typeof step.listen === "string") {
      const listener = await Listener.start(step.serve);
      listeners.set(step.listen, listener);
      recorded.set(step.listen, listener.port);
      continue;
    }
    if (typeof step.freePort === "string") {
      const reserved = await Listener.start("echo");
      reserved.close();
      recorded.set(step.freePort, reserved.port);
      continue;
    }
    if (typeof step.expectListenerClosed === "string") {
      const listener = listeners.get(step.expectListenerClosed);
      if (!listener) throw fail(`no listener ${step.expectListenerClosed}`);
      const deadline = Date.now() + within;
      while (listener.accepted === 0 || listener.open > 0) {
        if (Date.now() > deadline) throw fail("the listener's connections are still open");
        await new Promise((done) => setTimeout(done, 20));
      }
      continue;
    }
    if (typeof step.connect === "string") {
      const forward = typeof step.forward === "string" ? substituteText(step.forward, recorded) : undefined;
      connections.set(step.connect, await connect(supervisor, step.token as string, forward));
      continue;
    }
    if (typeof step.wait === "number") {
      await new Promise((done) => setTimeout(done, step.wait as number));
      continue;
    }
    if (typeof step.close === "string") {
      const connection = connections.get(step.close);
      if (!connection) throw fail(`no connection ${step.close}`);
      await new Promise<void>((done) => {
        if (connection.socket.readyState === WebSocket.CLOSED) return done();
        connection.socket.once("close", () => done());
        connection.socket.close(1000);
      });
      continue;
    }
    if (typeof step.signalSupervisor === "string") {
      requireProcess(supervisor, fail).kill(step.signalSupervisor as NodeJS.Signals);
      continue;
    }
    if (typeof step.expectSupervisorExit === "number") {
      const child = requireProcess(supervisor, fail);
      const code =
        child.exitCode ??
        (await new Promise<number | null>((done, reject) => {
          const timer = setTimeout(() => reject(fail("the supervisor is still running")), within);
          child.once("exit", (exitCode) => {
            clearTimeout(timer);
            done(exitCode);
          });
        }));
      if (code !== step.expectSupervisorExit) throw fail(`the supervisor exited ${code}`);
      continue;
    }
    const on = step.on ?? "main";
    const connection = connections.get(on);
    if (!connection) throw fail(`no connection ${on}`);
    if (step.send !== undefined) {
      connection.socket.send(JSON.stringify(substitute(step.send, recorded)));
    } else if (typeof step.sendText === "string") {
      connection.socket.send(step.sendText);
    } else if (typeof step.sendStdin === "string" || typeof step.sendBytes === "string") {
      connection.socket.send(Buffer.from((step.sendStdin ?? step.sendBytes) as string, "utf8"), { binary: true });
    } else if (typeof step.pauseReading === "number") {
      connection.socket.pause();
      await new Promise((done) => setTimeout(done, step.pauseReading as number));
      if (typeof step.expectUnfinished === "string") {
        const listener = listeners.get(step.expectUnfinished);
        if (!listener) throw fail(`no listener ${step.expectUnfinished}`);
        if (listener.finished) throw fail(`${step.expectUnfinished} wrote every byte while nothing read them`);
      }
      connection.socket.resume();
    } else if (step.expectBytes !== undefined) {
      await expectBytes(connection, step.expectBytes as { text?: string; flood?: number }, within, fail);
    } else if (step.expect !== undefined) {
      const actual = await nextText(connection, within, fail);
      for (const key of (step.ignore as string[] | undefined) ?? []) {
        if (!(key in actual)) throw fail(`${JSON.stringify(actual)} carries no ${key}`);
        delete actual[key];
      }
      expect(actual, `step ${index}`).toEqual(step.expect);
    } else if (step.expectOutput !== undefined) {
      const output = step.expectOutput as { stream: ByteStreamTag; text?: string; contains?: string; firstSeq?: number | string };
      const deadline = Date.now() + within;
      for (;;) {
        const kept = connection.output.get(output.stream) ?? [];
        const text = Buffer.concat(kept.map((frame) => frame.payload)).toString("utf8");
        const satisfied = output.text !== undefined ? text === output.text : text.includes(output.contains!);
        if (satisfied) {
          if (output.firstSeq !== undefined) {
            const expected = seqOf(output.firstSeq, recorded);
            if (kept[0]!.seq !== expected) throw fail(`first frame seq ${kept[0]!.seq} is not ${expected}`);
          }
          if (typeof step.record === "string") recorded.set(step.record, kept[kept.length - 1]!.seq);
          connection.output.delete(output.stream);
          break;
        }
        if (output.text !== undefined && !output.text.startsWith(text)) throw fail(`${output.stream} reads ${JSON.stringify(text)}`);
        const next = await connection.receive(deadline - Date.now());
        if (!next) throw fail(`${output.stream} reads ${JSON.stringify(text)} when time ran out`);
        if (next.kind !== "frame") throw fail(`${output.stream} reads ${JSON.stringify(text)}, then ${JSON.stringify(next)} arrived`);
        connection.keep(next);
      }
    } else if (typeof step.expectClose === "number") {
      for (;;) {
        const next = await connection.receive(within);
        if (!next) throw fail("never closed");
        if (next.kind !== "closed") continue;
        if (next.code !== step.expectClose) throw fail(`closed with ${next.code}`);
        break;
      }
    } else if (typeof step.expectSilence === "number") {
      const next = await connection.receive(step.expectSilence);
      if (next) throw fail(`${JSON.stringify(next)} arrived`);
    } else {
      throw fail("unknown step");
    }
  }
}

/** Reads raw bytes until they are `{ text }`, or `{ flood: n }` bytes of the
 *  flood pattern. */
async function expectBytes(
  connection: ScriptedConnection,
  expected: { text?: string; flood?: number },
  within: number,
  fail: (message: string) => Error,
): Promise<void> {
  const text = expected.text !== undefined ? Buffer.from(expected.text, "utf8") : undefined;
  const total = text?.byteLength ?? expected.flood;
  if (total === undefined) throw fail("expectBytes names text or flood");
  const deadline = Date.now() + within;
  let read = 0;
  while (read < total) {
    const next = await connection.receive(deadline - Date.now());
    if (!next) throw fail(`${read} of ${total} bytes read when time ran out`);
    if (next.kind !== "bytes") throw fail(`${read} of ${total} bytes read, then ${JSON.stringify(next)} arrived`);
    for (let i = 0; i < next.payload.byteLength; i += 1) {
      const at = read + i;
      const wanted = text ? text[at] : at < total ? floodByte(at) : undefined;
      if (next.payload[i] !== wanted) throw fail(`byte ${at} is ${next.payload[i]}, not ${wanted}`);
    }
    read += next.payload.byteLength;
  }
}

async function nextText(
  connection: ScriptedConnection,
  within: number,
  fail: (message: string) => Error,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + within;
  for (;;) {
    const next = await connection.receive(deadline - Date.now());
    if (!next) throw fail("nothing arrived");
    if (next.kind === "text") return next.value;
    if (next.kind === "closed") throw fail(`closed with ${next.code}`);
    if (next.kind === "bytes") throw fail("raw bytes arrived on a supervisor connection");
    connection.keep(next);
  }
}

/** A connection to the supervisor's own channel, or with `forward` (its query)
 *  a port forward. */
async function connect(supervisor: ExchangeTarget, token: string, forward?: string): Promise<ScriptedConnection> {
  const headers: Record<string, string> = {};
  if (token === "valid") headers.authorization = `Bearer ${supervisor.token}`;
  else if (token === "wrong") headers.authorization = `Bearer ${supervisor.token}-not`;
  const path = forward !== undefined ? `${SUPERVISOR_PORT_FORWARD_PATH}?${forward}` : SUPERVISOR_PATH;
  const socket = new WebSocket(`ws://${supervisor.host}:${supervisor.port}${path}`, { headers });
  const connection = new ScriptedConnection(socket, forward !== undefined);
  await new Promise<void>((done, reject) => {
    socket.once("open", () => done());
    socket.once("error", reject);
  });
  return connection;
}

function substitute(value: unknown, recorded: Map<string, number>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const seq = recorded.get(value.slice(1));
    if (seq === undefined) throw new Error(`nothing recorded as ${value}`);
    return seq;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, recorded));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, recorded)]));
  }
  return value;
}

function substituteText(text: string, recorded: Map<string, number>): string {
  return text.replace(/\$([A-Za-z0-9]+)/g, (match, label: string) => {
    const value = recorded.get(label);
    if (value === undefined) throw new Error(`nothing recorded as $${label}`);
    return String(value);
  });
}

function seqOf(value: number | string, recorded: Map<string, number>): number {
  if (typeof value === "number") return value;
  const match = /^\$(.+)\+1$/.exec(value);
  const seq = match ? recorded.get(match[1]!) : undefined;
  if (seq === undefined) throw new Error(`firstSeq ${value} names nothing recorded`);
  return seq + 1;
}
