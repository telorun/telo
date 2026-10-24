import { BYTE_STREAM_CODES, type ByteStreamTag, type IoMode } from "../contract.js";

/**
 * The runner's half of the session supervisor protocol, generation 1
 * (normative: `specs/supervisor-protocol.md`; the supervisor's half is the
 * `supervisor/` crate). Pinned by `supervisor/vectors/`.
 */
export const SUPERVISOR_GENERATION = 1;
export const SUPERVISOR_PATH = "/v1/supervisor";

export const SUPERVISOR_CLOSE = {
  protocolError: 4400,
  tokenMissing: 4401,
  tokenInvalid: 4403,
  helloTimeout: 4408,
  superseded: 4409,
  generationMismatch: 4426,
  backlogged: 4429,
} as const;

const MAX_DIMENSION = 10_000;
const MAX_GRACE_MS = 3_600_000;
const MAX_SEQ = 0xffff_ffff;
const FRAME_HEADER_BYTES = 5;

export type RunnerMessage =
  | { type: "hello"; generation: number; lastSeq: number }
  | {
      type: "run";
      runId: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      io: IoMode;
      cols?: number;
      rows?: number;
    }
  | { type: "stop"; runId: string; graceMs: number }
  | { type: "resize"; cols: number; rows: number };

export type SupervisorRefusalCode = "run_active" | "no_run";

/** `instance` is random per supervisor process: another one means the
 *  container restarted and the seqs a runner holds are not this one's. */
export type SupervisorHello =
  | { type: "hello"; generation: number; instance: string; state: "idle" }
  | { type: "hello"; generation: number; instance: string; state: "running"; runId: string };

export type SupervisorMessage =
  | SupervisorHello
  | { type: "started"; runId: string }
  | { type: "exited"; runId: string; code: number }
  | { type: "exited"; runId: string; signal: string }
  | { type: "failed"; runId: string; reason: string }
  | { type: "refused"; runId: string; code: SupervisorRefusalCode };

export interface OutputFrame {
  seq: number;
  stream: ByteStreamTag;
  payload: Buffer;
}

export class SupervisorProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorProtocolError";
  }
}

/** A supervisor `hello` of another generation: the pod predates this runner
 *  build (or follows it), and the backend recreates it. */
export class SupervisorGenerationMismatch extends Error {
  constructor(public readonly generation: number) {
    super(`the supervisor speaks generation ${generation}, this runner ${SUPERVISOR_GENERATION}`);
    this.name = "SupervisorGenerationMismatch";
  }
}

/** Encodes a runner message, refusing one the supervisor would close on. */
export function encodeRunnerMessage(message: RunnerMessage): string {
  switch (message.type) {
    case "hello":
      requireInteger(message.lastSeq, 0, MAX_SEQ, "hello.lastSeq");
      return JSON.stringify({ type: "hello", generation: message.generation, lastSeq: message.lastSeq });
    case "run": {
      requireRunId(message.runId, "run");
      if (message.argv.length === 0 || message.argv[0] === "") {
        throw new SupervisorProtocolError("'run.argv' names at least the program");
      }
      if (message.cwd === "") throw new SupervisorProtocolError("'run.cwd' must be a non-empty path");
      if ((message.cols === undefined) !== (message.rows === undefined)) {
        throw new SupervisorProtocolError("'run.cols' and 'run.rows' come together");
      }
      const encoded: Record<string, unknown> = {
        type: "run",
        runId: message.runId,
        argv: message.argv,
        env: message.env,
        cwd: message.cwd,
        io: message.io,
      };
      if (message.cols !== undefined && message.rows !== undefined) {
        requireInteger(message.cols, 1, MAX_DIMENSION, "run.cols");
        requireInteger(message.rows, 1, MAX_DIMENSION, "run.rows");
        encoded.cols = message.cols;
        encoded.rows = message.rows;
      }
      return JSON.stringify(encoded);
    }
    case "stop":
      requireRunId(message.runId, "stop");
      requireInteger(message.graceMs, 0, MAX_GRACE_MS, "stop.graceMs");
      return JSON.stringify({ type: "stop", runId: message.runId, graceMs: message.graceMs });
    case "resize":
      requireInteger(message.cols, 1, MAX_DIMENSION, "resize.cols");
      requireInteger(message.rows, 1, MAX_DIMENSION, "resize.rows");
      return JSON.stringify({ type: "resize", cols: message.cols, rows: message.rows });
  }
}

/** Decodes a supervisor text frame strictly: a field this generation does not
 *  define, or a shape it forbids, is a `SupervisorProtocolError`. A `hello` of
 *  another generation is a `SupervisorGenerationMismatch`, judged before its
 *  other fields, which that generation may define differently. */
export function decodeSupervisorMessage(text: string): SupervisorMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SupervisorProtocolError(`not JSON: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorProtocolError("a control message is a JSON object");
  }
  const fields = new Fields(value as Record<string, unknown>);
  const type = fields.string("type");
  let message: SupervisorMessage;
  switch (type) {
    case "hello": {
      const generation = fields.integer("generation", 0, Number.MAX_SAFE_INTEGER);
      if (generation !== SUPERVISOR_GENERATION) throw new SupervisorGenerationMismatch(generation);
      const instance = fields.string("instance");
      if (instance === "") throw new SupervisorProtocolError("'hello.instance' must not be empty");
      const state = fields.string("state");
      const runId = fields.optionalString("runId");
      if (state === "idle") {
        if (runId !== undefined) throw new SupervisorProtocolError("an idle hello carries no runId");
        message = { type, generation, instance, state };
      } else if (state === "running") {
        if (!runId) throw new SupervisorProtocolError("a running hello carries its runId");
        message = { type, generation, instance, state, runId };
      } else {
        throw new SupervisorProtocolError(`'hello.state' must be "idle" or "running", got ${JSON.stringify(state)}`);
      }
      break;
    }
    case "started":
      message = { type, runId: fields.runId() };
      break;
    case "exited": {
      const runId = fields.runId();
      const code = fields.optionalInteger("code");
      const signal = fields.optionalString("signal");
      if ((code === undefined) === (signal === undefined)) {
        throw new SupervisorProtocolError("'exited' carries exactly one of 'code' and 'signal'");
      }
      message = code !== undefined ? { type, runId, code } : { type, runId, signal: signal! };
      break;
    }
    case "failed":
      message = { type, runId: fields.runId(), reason: fields.string("reason") };
      break;
    case "refused": {
      const runId = fields.runId();
      const code = fields.string("code");
      if (code !== "run_active" && code !== "no_run") {
        throw new SupervisorProtocolError(`'refused.code' must be "run_active" or "no_run", got ${JSON.stringify(code)}`);
      }
      message = { type, runId, code };
      break;
    }
    default:
      throw new SupervisorProtocolError(`unknown message type ${JSON.stringify(type)}`);
  }
  fields.finish(type);
  return message;
}

const STREAMS_BY_CODE = new Map<number, ByteStreamTag>(
  (Object.entries(BYTE_STREAM_CODES) as Array<[ByteStreamTag, number]>).map(([tag, code]) => [code, tag]),
);

export function decodeOutputFrame(frame: Buffer): OutputFrame {
  if (frame.byteLength < FRAME_HEADER_BYTES) {
    throw new SupervisorProtocolError(`an output frame is at least ${FRAME_HEADER_BYTES} bytes, got ${frame.byteLength}`);
  }
  const seq = frame.readUInt32BE(0);
  if (seq === 0) throw new SupervisorProtocolError("an output frame's seq starts at 1");
  const stream = STREAMS_BY_CODE.get(frame.readUInt8(4));
  if (!stream) throw new SupervisorProtocolError(`unknown stream code ${frame.readUInt8(4)}`);
  return { seq, stream, payload: frame.subarray(FRAME_HEADER_BYTES) };
}

class Fields {
  private readonly read = new Set<string>();
  constructor(private readonly object: Record<string, unknown>) {}

  private take(name: string): unknown {
    this.read.add(name);
    return this.object[name];
  }

  string(name: string): string {
    const value = this.take(name);
    if (typeof value !== "string") throw new SupervisorProtocolError(`'${name}' must be a string`);
    return value;
  }

  optionalString(name: string): string | undefined {
    const value = this.take(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new SupervisorProtocolError(`'${name}' must be a string`);
    return value;
  }

  integer(name: string, min: number, max: number): number {
    const value = this.take(name);
    requireInteger(value, min, max, name);
    return value as number;
  }

  optionalInteger(name: string): number | undefined {
    const value = this.take(name);
    if (value === undefined) return undefined;
    requireInteger(value, -0x8000_0000, 0x7fff_ffff, name);
    return value as number;
  }

  runId(): string {
    const runId = this.string("runId");
    if (runId === "") throw new SupervisorProtocolError("'runId' must not be empty");
    return runId;
  }

  finish(type: string): void {
    for (const key of Object.keys(this.object)) {
      if (!this.read.has(key)) {
        throw new SupervisorProtocolError(
          `'${type}' has no field '${key}' in generation ${SUPERVISOR_GENERATION}`,
        );
      }
    }
  }
}

function requireInteger(value: unknown, min: number, max: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SupervisorProtocolError(`'${name}' must be an integer from ${min} to ${max}`);
  }
}

function requireRunId(runId: string, type: string): void {
  if (runId === "") throw new SupervisorProtocolError(`'${type}.runId' must not be empty`);
}
