import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { attachDemuxed } from "./watch-session.js";

/** Docker's frame: `[stream:1][pad:3][len:4 BE][payload]`. */
function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function demux(chunks: Buffer[]): Array<[string, string]> {
  const stream = new EventEmitter() as unknown as NodeJS.ReadWriteStream;
  const seen: Array<[string, string]> = [];
  attachDemuxed(stream, (tag, chunk) => seen.push([tag, chunk.toString()]));
  for (const chunk of chunks) (stream as unknown as EventEmitter).emit("data", chunk);
  return seen;
}

describe("attachDemuxed", () => {
  it("separates stdout from stderr", () => {
    expect(demux([frame(1, "out"), frame(2, "err")])).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
    ]);
  });

  it("reassembles a frame split across chunks", () => {
    // The daemon does not respect frame boundaries, so a header arriving in two
    // pieces is ordinary — and mis-handling it corrupts every frame after it.
    const whole = frame(1, "hello world");
    expect(demux([whole.subarray(0, 3), whole.subarray(3, 10), whole.subarray(10)])).toEqual([
      ["stdout", "hello world"],
    ]);
  });

  it("emits both frames when two arrive in one chunk", () => {
    expect(demux([Buffer.concat([frame(1, "a"), frame(2, "b")])])).toEqual([
      ["stdout", "a"],
      ["stderr", "b"],
    ]);
  });

  it("waits rather than emitting a partial payload", () => {
    const whole = frame(1, "abcdef");
    expect(demux([whole.subarray(0, 10)])).toEqual([]);
  });

  it("reads an unknown stream id as stdout", () => {
    // Only stderr is distinguished; anything else is output, never dropped.
    expect(demux([frame(0 as 1, "x")])).toEqual([["stdout", "x"]]);
  });
});
