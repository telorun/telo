/**
 * The Telo controller protocol — `kernel/specs/controller-protocol.md`. The four
 * conformance vector files are read from `sdk/controller-protocol/vectors/`, which
 * the Rust SDK reads too, and the message schemas from the directory beside them.
 *
 * The framing codec below is **private to this test** and is written from §3's
 * prose, never from the vectors: whoever writes the real carrier re-derives it, so
 * the vectors never end up testing a codec against itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { decodeTypedFrame, encodeTypedFrame } from "../src/typed-frame.js";

const PROTOCOL = new URL("../../controller-protocol/", import.meta.url);

const readJson = (file: string): any => JSON.parse(readFileSync(new URL(file, PROTOCOL), "utf8"));

interface MessageEntry {
  name: string;
  direction: "kernel-to-controller" | "controller-to-kernel" | "either";
  spec: string;
  request: object;
  response: object | null;
  errors: string[];
  synchronous: boolean;
  reentrant: boolean;
}

const MESSAGES = new Map<string, MessageEntry>(
  readdirSync(new URL("messages/", PROTOCOL))
    .sort()
    .map((file) => {
      const entry = readJson(`messages/${file}`) as MessageEntry;
      return [entry.name, entry];
    }),
);

const framing = readJson("vectors/framing.json");
const messageVectors = readJson("vectors/messages.json");
const sequenceVectors = readJson("vectors/sequences.json");
const equivalence = readJson("vectors/carrier-equivalence.json");

// --------------------------------------------------------------------- framing
// §3.1, §3.3. Nothing here is exported.

const MAX_FRAME_LENGTH = 16777216;
const CHUNK_CEILING = 8388608;
const CLASS_MESSAGE = 0x01;
const CLASS_DATA = 0x02;

class FrameRefusal extends Error {}

interface Envelope {
  id: number;
  session: string | null;
  type: string;
  payload: any;
}

interface Frame {
  class: "message" | "data";
  meta: string;
  data: Uint8Array;
  envelope: Envelope;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** length u32be | class u8 | metaLength u32be | meta | data */
function encodeFrame(cls: "message" | "data", meta: string, data: Uint8Array): Uint8Array {
  const metaBytes = new TextEncoder().encode(meta);
  const length = 1 + 4 + metaBytes.length + data.length;
  if (length > MAX_FRAME_LENGTH) throw new FrameRefusal(`a frame of ${length} bytes exceeds MAX_FRAME_LENGTH`);
  const out = new Uint8Array(4 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  out[4] = cls === "message" ? CLASS_MESSAGE : CLASS_DATA;
  view.setUint32(5, metaBytes.length);
  out.set(metaBytes, 9);
  out.set(data, 9 + metaBytes.length);
  return out;
}

/** §3.2: the meta is the typed frame of an object with exactly four members. */
function readEnvelope(meta: string): Envelope {
  let value: unknown;
  try {
    value = decodeTypedFrame(meta);
  } catch (err) {
    throw new FrameRefusal(`a frame's meta is not a typed frame: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameRefusal("a frame's meta is not an envelope object");
  }
  const members = Object.keys(value as object).sort();
  if (members.join(",") !== "id,payload,session,type") {
    throw new FrameRefusal(`an envelope carries exactly id, session, type and payload, not ${members.join(", ")}`);
  }
  const { id, session, type, payload } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new FrameRefusal("an envelope's id is an unsigned integer");
  }
  if (session !== null && typeof session !== "string") throw new FrameRefusal("an envelope's session is text or null");
  if (typeof type !== "string") throw new FrameRefusal("an envelope's type is the message's name");
  return { id, session, type, payload };
}

function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < 4) throw new FrameRefusal("a frame's four-byte length prefix is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  // Refused on the length field alone, before any body is read or allocated.
  if (length > MAX_FRAME_LENGTH) throw new FrameRefusal(`a length of ${length} exceeds MAX_FRAME_LENGTH`);
  if (length < 5) throw new FrameRefusal(`a frame of length ${length} carries no class byte and no metaLength`);
  if (bytes.length !== 4 + length) {
    throw new FrameRefusal(`a frame of length ${length} is ${bytes.length - 4} bytes long`);
  }
  const cls = bytes[4];
  if (cls !== CLASS_MESSAGE && cls !== CLASS_DATA) throw new FrameRefusal(`no frame class is 0x${cls!.toString(16)}`);
  const metaLength = view.getUint32(5);
  if (metaLength > length - 5) throw new FrameRefusal(`a metaLength of ${metaLength} exceeds length - 5`);
  let meta: string;
  try {
    meta = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(9, 9 + metaLength));
  } catch {
    throw new FrameRefusal("a frame's meta is not well-formed UTF-8");
  }
  const data = bytes.subarray(9 + metaLength);
  const envelope = readEnvelope(meta);
  if (cls === CLASS_MESSAGE) {
    if (data.length > 0) throw new FrameRefusal("a message frame's whole content is its envelope");
    return { class: "message", meta, data, envelope };
  }
  if (envelope.type !== "Channel.Data") throw new FrameRefusal("Channel.Data is the only data frame");
  if (data.length > CHUNK_CEILING) throw new FrameRefusal(`a chunk of ${data.length} bytes exceeds the chunk ceiling`);
  const declared = envelope.payload?.byteLength;
  if (declared !== data.length) {
    throw new FrameRefusal(`a chunk declared ${declared} bytes and ${data.length} follow the meta`);
  }
  return { class: "data", meta, data, envelope };
}

// -------------------------------------------------------------------- schemas

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

function schemaFor(message: string, part: "request" | "response"): ValidateFunction {
  const key = `${message}#${part}`;
  const found = compiled.get(key);
  if (found) return found;
  const entry = MESSAGES.get(message);
  if (!entry) throw new Error(`No message named '${message}' in sdk/controller-protocol/messages/`);
  const schema = part === "request" ? entry.request : entry.response;
  if (!schema) throw new Error(`'${message}' is a notification: it has no response schema`);
  const validate = ajv.compile(schema);
  compiled.set(key, validate);
  return validate;
}

/** The distinct RFC 6901 instance pointers a refusal names. */
function refusalPointers(validate: ValidateFunction): string[] {
  return [...new Set((validate.errors ?? []).map((error) => error.instancePath))].sort();
}

// --------------------------------------------------------------------- tests

describe("framed carrier", () => {
  it.each(framing.frames)("frames and reads $name", (row: any) => {
    const decoded = decodeFrame(unhex(row.frame));
    expect(decoded.class).toBe(row.class);
    expect(decoded.meta).toBe(row.meta);
    expect(hex(decoded.data)).toBe(row.data);
    expect(hex(encodeFrame(row.class, row.meta, unhex(row.data)))).toBe(row.frame);
    // The meta is the canonical typed frame of the envelope it carries.
    expect(encodeTypedFrame(decodeTypedFrame(row.meta))).toBe(row.meta);
    expect(MESSAGES.has(decoded.envelope.type)).toBe(true);
  });

  it.each(framing.undecodable)("refuses $name", (row: any) => {
    expect(() => decodeFrame(unhex(row.frame))).toThrow(FrameRefusal);
  });

  // A table with no rows is the silent zero the vectors exist to prevent.
  it("has rows to run in every table", () => {
    const counts = {
      frames: framing.frames.length,
      undecodable: framing.undecodable.length,
      valid: messageVectors.valid.length,
      invalid: messageVectors.invalid.length,
      sequences: sequenceVectors.sequences.length,
      rows: equivalence.rows.length,
    };
    expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual([]);
  });
});

describe("message bodies", () => {
  it.each(messageVectors.valid)("$message $part is valid", (row: any) => {
    const validate = schemaFor(row.message, row.part);
    expect(validate(row.body) ? [] : refusalPointers(validate)).toEqual([]);
  });

  it.each(messageVectors.invalid)("refuses $name at its pointer", (row: any) => {
    const validate = schemaFor(row.message, row.part);
    expect(validate(row.body)).toBe(false);
    expect(refusalPointers(validate)).toEqual([row.pointer]);
  });

  it("carries a valid body for every message, in every direction it declares", () => {
    const covered = new Set(messageVectors.valid.map((row: any) => `${row.message}#${row.part}`));
    const missing = [...MESSAGES.values()].flatMap((entry) => {
      const wanted = ["request", ...(entry.response ? ["response"] : [])];
      return wanted.filter((part) => !covered.has(`${entry.name}#${part}`)).map((part) => `${entry.name}#${part}`);
    });
    expect(missing).toEqual([]);
  });
});

type Side = "kernel" | "controller";

interface Outstanding {
  type: string;
  session: string | null;
  from: Side;
  synchronous: boolean;
  index: number;
  response?: number;
}

/** Everything §3.2, §3.4, §8 and §10 decide about a whole exchange. */
function checkSequence(row: any): void {
  const open = new Set<string>(row.open);
  const outstanding = new Map<number, Outstanding>();
  const settled: Outstanding[] = [];
  const channels = new Map<string, { granted: number; spent: number; nextSeq: number; closed: boolean }>();

  row.frames.forEach((frame: any, index: number) => {
    const decoded = decodeFrame(unhex(frame.frame));
    expect(decoded.meta, frame.meta).toBe(frame.meta);
    expect(hex(decoded.data)).toBe(frame.data ?? "");

    const { id, session, type, payload } = decoded.envelope;
    const entry = MESSAGES.get(type);
    expect(entry, `frame ${index} names '${type}', which no message file declares`).toBeDefined();
    const from = frame.from as Side;
    // §3.2: the kernel end mints even ids and the controller end odd ones, so a
    // frame's id alone says whether it is a request or a response.
    const isRequest = id % 2 === (from === "kernel" ? 0 : 1);

    if (isRequest && type === "Session.Open") open.add(payload.session);
    // Both directions: Session.Hello precedes every session and carries none,
    // and every other frame names one that is open.
    if (session === null) {
      expect(type, `frame ${index}: only Session.Hello precedes every session`).toBe("Session.Hello");
    } else {
      expect(type, `frame ${index}: Session.Hello precedes every session`).not.toBe("Session.Hello");
      expect(open.has(session), `frame ${index} names session '${session}', which is not open`).toBe(true);
    }

    if (isRequest) {
      const blocked = [...outstanding.values()].find((out) => out.from === from && out.synchronous);
      expect(
        blocked === undefined,
        `frame ${index} was sent while '${blocked?.type}' — a synchronous request — was outstanding`,
      ).toBe(true);
      expect(outstanding.has(id), `frame ${index} reuses id ${id}, which is outstanding`).toBe(false);
      expect(validateAgainst(type, "request", payload), `frame ${index}`).toEqual([]);
      if (entry!.response !== null) {
        outstanding.set(id, { type, session, from, synchronous: entry!.synchronous, index });
      }
    } else {
      const request = outstanding.get(id);
      expect(request, `frame ${index} answers id ${id}, which no outstanding request carries`).toBeDefined();
      expect(request!.type, `frame ${index} answers '${request!.type}' with '${type}'`).toBe(type);
      expect(request!.session).toBe(session);
      expect(request!.from).not.toBe(from);
      expect(
        entry!.response !== null,
        `frame ${index} answers '${type}', whose response is null — a notification draws no response`,
      ).toBe(true);
      const members = Object.keys(payload);
      expect(members.length, `frame ${index}: a response payload carries exactly 'ok' or 'error'`).toBe(1);
      if (members[0] === "ok") {
        expect(validateAgainst(type, "response", payload.ok), `frame ${index}`).toEqual([]);
      } else {
        expect(members[0]).toBe("error");
        expect(
          entry!.errors,
          `frame ${index} answers with '${payload.error.code}', which '${type}' does not declare`,
        ).toContain(payload.error.code);
      }
      outstanding.delete(id);
      request!.response = index;
      settled.push(request!);
      if (type === "Session.Close" && members[0] === "ok") open.delete(request!.session as string);
      if (type === "Runtime.Run" && members[0] === "ok") open.add(payload.ok.session);
    }

    // §8: a chunk sits between its channel's Open and Close, in seq order, and
    // within the credit granted to it.
    if (type === "Channel.Open") channels.set(payload.channelId, { granted: payload.credit, spent: 0, nextSeq: 0, closed: false });
    if (type === "Channel.Credit" || type === "Channel.Data" || type === "Channel.Close") {
      const channel = channels.get(payload.channelId);
      expect(channel, `frame ${index} names channel '${payload.channelId}', which is not open`).toBeDefined();
      expect(channel!.closed, `frame ${index} follows channel '${payload.channelId}''s close`).toBe(false);
      if (type === "Channel.Credit") channel!.granted += payload.bytes;
      if (type === "Channel.Data") {
        expect(payload.seq, `frame ${index}: seq starts at 0 and increases by one`).toBe(channel!.nextSeq);
        channel!.nextSeq += 1;
        channel!.spent += payload.byteLength;
        expect(
          channel!.spent <= channel!.granted,
          `frame ${index} spends ${channel!.spent} bytes of ${channel!.granted} granted`,
        ).toBe(true);
      }
      if (type === "Channel.Close") channel!.closed = true;
    }
  });

  if (row.reentrancy) {
    const outer = MESSAGES.get(row.reentrancy.outer)!;
    expect(outer.synchronous && outer.reentrant).toBe(true);
    const call = settled.find((request) => request.type === row.reentrancy.outer);
    expect(call, `no '${row.reentrancy.outer}' exchange in this row`).toBeDefined();
    const inner = row.frames.findIndex(
      (frame: any, index: number) =>
        index > call!.index &&
        index < call!.response! &&
        frame.from !== row.frames[call!.index].from &&
        decodeFrame(unhex(frame.frame)).envelope.type === row.reentrancy.inner,
    );
    expect(
      inner,
      `no '${row.reentrancy.inner}' request is interleaved between '${row.reentrancy.outer}' and its response`,
    ).toBeGreaterThan(-1);
  }

  if (row.signal) {
    const codeOf = (type: string) => {
      const request = settled.find((settledRequest) => settledRequest.type === type);
      expect(request, `no '${type}' exchange in this row`).toBeDefined();
      const answer = decodeFrame(unhex(row.frames[request!.response!].frame)).envelope.payload;
      return { code: answer.error?.code, at: request!.response! };
    };
    const raised = codeOf(row.signal.raisedBy);
    const reraised = codeOf(row.signal.reraisedBy);
    expect(raised.code).toBe(row.signal.code);
    expect(reraised.code, "a signal leaves the construct that catches it unchanged").toBe(row.signal.code);
    expect(reraised.at).toBeGreaterThan(raised.at);
  }
}

function validateAgainst(message: string, part: "request" | "response", body: unknown): string[] {
  const validate = schemaFor(message, part);
  return validate(body) ? [] : refusalPointers(validate);
}

describe("exchanges", () => {
  it.each(sequenceVectors.sequences)("$name", (row: any) => {
    expect(row.frames.length).toBeGreaterThan(0);
    checkSequence(row);
  });
});

describe("carrier equivalence", () => {
  it.each(equivalence.rows)("$name carries the same bytes on both carriers", (row: any) => {
    const payloadBytes = new TextEncoder().encode(row.payload);
    expect(row.abi.buffer).toBe(hex(payloadBytes));

    const decoded = decodeFrame(unhex(row.framed.frame));
    expect(decoded.meta).toBe(row.framed.meta);
    expect(decoded.envelope.type).toBe(row.message);
    expect(encodeTypedFrame(decoded.envelope.payload)).toBe(row.payload);

    // The framed carrier adds its header and the envelope's other members, and
    // changes not one byte of the payload.
    const frameBytes = unhex(row.framed.frame);
    const at = 9 + new TextEncoder().encode(row.framed.meta.slice(0, row.framed.meta.indexOf(row.payload))).length;
    expect(row.framed.meta).toContain(row.payload);
    expect(hex(frameBytes.subarray(at, at + payloadBytes.length))).toBe(row.abi.buffer);
    if (row.abi.chunk !== undefined) expect(hex(decoded.data)).toBe(row.abi.chunk);
  });

  it("covers every section of the message set", () => {
    const sections = new Set([...MESSAGES.values()].map((entry) => entry.spec));
    expect([...new Set(equivalence.rows.map((row: any) => row.section))].sort()).toEqual([...sections].sort());
  });
});
