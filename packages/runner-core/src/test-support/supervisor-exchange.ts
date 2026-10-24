import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import WebSocket from "ws";

import type { ByteStreamTag } from "../contract.js";
import { SUPERVISOR_PATH, decodeOutputFrame, decodeSupervisorMessage } from "../supervisor/supervisor-protocol.js";
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
  | { kind: "closed"; code: number };

/** One scripted connection: everything it receives, in order. */
class ScriptedConnection {
  private readonly queue: Received[] = [];
  private waiter: (() => void) | undefined;
  readonly output = new Map<ByteStreamTag, Array<{ seq: number; payload: Buffer }>>();
  private lastFrameSeq: number | undefined;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      // Through the runner's decoders: what the supervisor sends must be what it reads.
      try {
        if (isBinary) {
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
  for (const [index, step] of steps.entries()) {
    const fail = (message: string): Error => new Error(`step ${index} (${JSON.stringify(step)}): ${message}`);
    const within = step.withinMs ?? DEFAULT_WITHIN_MS;
    if (typeof step.connect === "string") {
      connections.set(step.connect, await connect(supervisor, step.token as string));
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
    } else if (typeof step.sendStdin === "string") {
      connection.socket.send(Buffer.from(step.sendStdin, "utf8"), { binary: true });
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
  for (const connection of connections.values()) connection.socket.terminate();
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
    connection.keep(next);
  }
}

async function connect(supervisor: ExchangeTarget, token: string): Promise<ScriptedConnection> {
  const headers: Record<string, string> = {};
  if (token === "valid") headers.authorization = `Bearer ${supervisor.token}`;
  else if (token === "wrong") headers.authorization = `Bearer ${supervisor.token}-not`;
  const socket = new WebSocket(`ws://${supervisor.host}:${supervisor.port}${SUPERVISOR_PATH}`, { headers });
  const connection = new ScriptedConnection(socket);
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

function seqOf(value: number | string, recorded: Map<string, number>): number {
  if (typeof value === "number") return value;
  const match = /^\$(.+)\+1$/.exec(value);
  const seq = match ? recorded.get(match[1]!) : undefined;
  if (seq === undefined) throw new Error(`firstSeq ${value} names nothing recorded`);
  return seq + 1;
}
