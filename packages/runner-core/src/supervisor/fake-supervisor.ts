import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import { BYTE_STREAM_CODES, type ByteStreamTag } from "../contract.js";
import {
  SUPERVISOR_CLOSE,
  SUPERVISOR_PATH,
  SupervisorProtocolError,
  type RunnerMessage,
} from "./supervisor-protocol.js";

const HELLO_TIMEOUT_MS = 10_000;
const MAX_DIMENSION = 10_000;
const MAX_GRACE_MS = 3_600_000;
const MAX_SEQ = 0xffff_ffff;

export interface FakeSupervisorOptions {
  /** The address to listen on; port `0` picks a free one. */
  host: string;
  port: number;
  /** The bearer token a connection must carry. */
  token: string;
  /** The protocol generation it speaks; a runner's `hello` of another one is closed `4426`. */
  generation: number;
  /** A run already live when it starts, as an earlier runner process left it. */
  live?: string;
}

/** How the fake ends its live run: an exit status, a signal, or a spawn that never ran. */
export type FakeRunEnding = { code: number } | { signal: string } | { failed: string };

type Ending = { runId: string } & FakeRunEnding;

/**
 * A session supervisor that runs no program, for runners' tests. It speaks the
 * protocol (`specs/supervisor-protocol.md`) as the real one does — handshake,
 * strict validation, idempotent answers by `runId`, supersession, the output
 * ring replayed from `lastSeq` — and runner-core runs every exchange vector that
 * starts no program against it. A run is live from its `run` until `stop` (which
 * ends it with `SIGTERM` at once) or `end()`.
 */
export class FakeSupervisor {
  readonly token: string;
  /** The generation it speaks from now on. */
  generation: number;
  /** Random per process; `drop({ restart: true })` draws another. */
  instance = instanceId();
  live: string | undefined;
  /** Every control message a runner sent, `hello` included, as decoded. */
  readonly received: RunnerMessage[] = [];
  private lastEnding: Ending | undefined;
  private seq = 0;
  private ring: Buffer[] = [];
  private driver: WebSocket | undefined;
  private readonly sockets = new Set<WebSocket>();
  private closed = false;

  private constructor(
    private readonly server: WebSocketServer,
    options: FakeSupervisorOptions,
  ) {
    this.token = options.token;
    this.generation = options.generation;
    this.live = options.live;
    server.on("connection", (socket, request) => this.accept(socket, request.headers.authorization));
  }

  static async start(options: FakeSupervisorOptions): Promise<FakeSupervisor> {
    const server = new WebSocketServer({ host: options.host, port: options.port, path: SUPERVISOR_PATH });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    return new FakeSupervisor(server, options);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** The live run writes `payload`; kept in the ring and sent to the driving connection. */
  output(stream: ByteStreamTag, payload: Buffer | string): void {
    this.seq += 1;
    if (this.seq > MAX_SEQ) throw new Error("the fake supervisor ran out of output seqs");
    const bytes = typeof payload === "string" ? Buffer.from(payload) : payload;
    const frame = Buffer.alloc(5 + bytes.byteLength);
    frame.writeUInt32BE(this.seq, 0);
    frame.writeUInt8(BYTE_STREAM_CODES[stream], 4);
    bytes.copy(frame, 5);
    this.ring.push(frame);
    this.driver?.send(frame, { binary: true });
  }

  /** The ring forgets every frame it holds, as an overflowing one would: a
   *  runner reconnecting below the next seq sees the gap. */
  forgetOutput(): void {
    this.ring = [];
  }

  /** The live run ends as `ending` says. */
  end(ending: FakeRunEnding): void {
    if (this.live === undefined) throw new Error("the fake supervisor has no live run to end");
    this.finish({ runId: this.live, ...ending });
  }

  /** Drop every connection, as a restarted container would; `restart` also
   *  answers the next hello as another process, its run and ring gone. */
  drop(options?: { restart?: boolean }): void {
    if (options?.restart) {
      this.instance = instanceId();
      this.live = undefined;
      this.lastEnding = undefined;
      this.seq = 0;
      this.ring = [];
    }
    for (const socket of this.sockets) socket.terminate();
  }

  /** Stop listening and drop every connection; closing again does nothing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private accept(socket: WebSocket, authorization: string | undefined): void {
    if (authorization === undefined) return socket.close(SUPERVISOR_CLOSE.tokenMissing, "no bearer token");
    if (authorization !== `Bearer ${this.token}`) return socket.close(SUPERVISOR_CLOSE.tokenInvalid, "wrong token");
    this.sockets.add(socket);
    let greeted = false;
    const helloTimer = setTimeout(() => socket.close(SUPERVISOR_CLOSE.helloTimeout, "no hello"), HELLO_TIMEOUT_MS);
    helloTimer.unref();
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.sockets.delete(socket);
      if (this.driver === socket) this.driver = undefined;
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return; // stdin: the fake's runs read none
      let message: RunnerMessage;
      try {
        message = decodeRunnerMessage(data.toString(), this.generation);
      } catch (error) {
        const code = error instanceof GenerationMismatch ? SUPERVISOR_CLOSE.generationMismatch : SUPERVISOR_CLOSE.protocolError;
        return socket.close(code, (error as Error).message.slice(0, 120));
      }
      if (greeted === (message.type === "hello")) {
        return socket.close(SUPERVISOR_CLOSE.protocolError, greeted ? "a second hello" : `'${message.type}' before hello`);
      }
      this.received.push(message);
      if (message.type === "hello") {
        greeted = true;
        clearTimeout(helloTimer);
        this.greet(socket, message.lastSeq);
      } else {
        this.answer(socket, message);
      }
    });
  }

  private greet(socket: WebSocket, lastSeq: number): void {
    const before = this.driver;
    this.driver = socket;
    before?.close(SUPERVISOR_CLOSE.superseded, "another connection took over");
    send(socket, {
      type: "hello",
      generation: this.generation,
      instance: this.instance,
      ...(this.live !== undefined ? { state: "running", runId: this.live } : { state: "idle" }),
    });
    for (const frame of this.ring) if (frame.readUInt32BE(0) > lastSeq) socket.send(frame, { binary: true });
  }

  private answer(socket: WebSocket, message: Exclude<RunnerMessage, { type: "hello" }>): void {
    if (message.type === "resize") return;
    const { runId } = message;
    if (this.lastEnding?.runId === runId) return send(socket, endingMessage(this.lastEnding));
    if (message.type === "run") {
      if (this.live !== undefined && this.live !== runId) return send(socket, { type: "refused", runId, code: "run_active" });
      this.live = runId;
      return send(socket, { type: "started", runId });
    }
    if (this.live !== runId) return send(socket, { type: "refused", runId, code: "no_run" });
    this.finish({ runId, signal: "SIGTERM" });
  }

  private finish(ending: Ending): void {
    this.live = undefined;
    this.lastEnding = ending;
    if (this.driver) send(this.driver, endingMessage(ending));
  }
}

function endingMessage(ending: Ending): Record<string, unknown> {
  if ("failed" in ending) return { type: "failed", runId: ending.runId, reason: ending.failed };
  if ("code" in ending) return { type: "exited", runId: ending.runId, code: ending.code };
  return { type: "exited", runId: ending.runId, signal: ending.signal };
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  socket.send(JSON.stringify(message));
}

function instanceId(): string {
  return randomBytes(16).toString("hex");
}

class GenerationMismatch extends Error {}

/** The supervisor's strict reading of a runner message (spec § 3, § 4.1). */
function decodeRunnerMessage(text: string, generation: number): RunnerMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SupervisorProtocolError(`not JSON: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw new SupervisorProtocolError("a control message is a JSON object");
  const fields = new Fields(value);
  const type = fields.string("type");
  let message: RunnerMessage;
  switch (type) {
    case "hello": {
      const claimed = fields.integer("generation", 0, Number.MAX_SAFE_INTEGER);
      if (claimed !== generation) throw new GenerationMismatch(`the runner speaks generation ${claimed}, this supervisor ${generation}`);
      message = { type, generation: claimed, lastSeq: fields.integer("lastSeq", 0, MAX_SEQ) };
      break;
    }
    case "run": {
      const runId = fields.runId();
      const argv = fields.take("argv");
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && !a.includes("\0")) || argv[0] === "") {
        throw new SupervisorProtocolError("'argv' must be a non-empty array of strings, the first non-empty");
      }
      const env = fields.take("env");
      if (
        !isObject(env) ||
        !Object.entries(env).every(([name, v]) => name !== "" && !/[=\0]/.test(name) && typeof v === "string" && !v.includes("\0"))
      ) {
        throw new SupervisorProtocolError("'env' must map names holding neither '=' nor NUL to strings");
      }
      const cwd = fields.string("cwd");
      if (cwd === "") throw new SupervisorProtocolError("'cwd' must be a non-empty path");
      const io = fields.string("io");
      if (io !== "tty" && io !== "streams") throw new SupervisorProtocolError(`'io' must be "tty" or "streams"`);
      const cols = fields.optionalInteger("cols", 1, MAX_DIMENSION);
      const rows = fields.optionalInteger("rows", 1, MAX_DIMENSION);
      if ((cols === undefined) !== (rows === undefined)) throw new SupervisorProtocolError("'cols' and 'rows' come together");
      message = { type, runId, argv: argv as string[], env: env as Record<string, string>, cwd, io };
      if (cols !== undefined && rows !== undefined) Object.assign(message, { cols, rows });
      break;
    }
    case "stop":
      message = { type, runId: fields.runId(), graceMs: fields.integer("graceMs", 0, MAX_GRACE_MS) };
      break;
    case "resize":
      message = { type, cols: fields.integer("cols", 1, MAX_DIMENSION), rows: fields.integer("rows", 1, MAX_DIMENSION) };
      break;
    default:
      throw new SupervisorProtocolError(`unknown message type ${JSON.stringify(type)}`);
  }
  fields.finish(type);
  return message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Fields {
  private readonly read = new Set<string>();
  constructor(private readonly object: Record<string, unknown>) {}

  take(name: string): unknown {
    this.read.add(name);
    return this.object[name];
  }

  string(name: string): string {
    const value = this.take(name);
    if (typeof value !== "string") throw new SupervisorProtocolError(`'${name}' must be a string`);
    return value;
  }

  integer(name: string, min: number, max: number): number {
    const value = this.take(name);
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new SupervisorProtocolError(`'${name}' must be an integer from ${min} to ${max}`);
    }
    return value;
  }

  optionalInteger(name: string, min: number, max: number): number | undefined {
    return this.object[name] === undefined ? (this.read.add(name), undefined) : this.integer(name, min, max);
  }

  runId(): string {
    const runId = this.string("runId");
    if (runId === "") throw new SupervisorProtocolError("'runId' must not be empty");
    return runId;
  }

  finish(type: string): void {
    const extra = Object.keys(this.object).find((key) => !this.read.has(key));
    if (extra !== undefined) throw new SupervisorProtocolError(`'${type}' has no field '${extra}'`);
  }
}
