import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, FrameReader, FrameRefusal, MAX_FRAME_LENGTH } from "../src/controller-frame.js";

const message = (meta: string) => encodeFrame("message", meta);

describe("controller frame codec", () => {
  it("round-trips a message frame and a data frame", () => {
    expect(decodeFrame(message('{"a":1}'))).toEqual({ class: "message", meta: '{"a":1}', data: new Uint8Array(0) });
    const data = new Uint8Array([1, 2, 3]);
    expect(decodeFrame(encodeFrame("data", "é", data))).toEqual({ class: "data", meta: "é", data });
  });

  it("reads frames from a stream split and coalesced at any byte", () => {
    const first = message("one");
    const second = encodeFrame("data", "two", new Uint8Array([9, 9]));
    const bytes = new Uint8Array([...first, ...second]);
    const reader = new FrameReader();
    const metas: string[] = [];
    for (const byte of bytes) metas.push(...reader.push(new Uint8Array([byte])).map((frame) => frame.meta));
    expect(metas).toEqual(["one", "two"]);
    expect(new FrameReader().push(bytes).map((frame) => frame.meta)).toEqual(["one", "two"]);
    reader.end();
  });

  it("reads a large frame arriving in many small chunks without re-copying what is pending", () => {
    const payload = new Uint8Array(1024 * 1024).fill(7);
    const bytes = encodeFrame("data", "big", payload);
    const reader = new FrameReader();
    const frames = [];
    for (let at = 0; at < bytes.length; at += 16) frames.push(...reader.push(bytes.subarray(at, at + 16)));
    expect(frames).toHaveLength(1);
    expect(frames[0].meta).toBe("big");
    expect(frames[0].data).toEqual(payload);
    reader.end();
  }, 5000);

  it("refuses a length over the bound from the prefix alone, and stays refused", () => {
    const reader = new FrameReader();
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, MAX_FRAME_LENGTH + 1);
    expect(() => reader.push(prefix)).toThrow(FrameRefusal);
    expect(() => reader.push(message("x"))).toThrow(FrameRefusal);
    expect(() => encodeFrame("data", "", new Uint8Array(MAX_FRAME_LENGTH))).toThrow(FrameRefusal);
  });

  it("refuses a stream that ends inside a frame", () => {
    const reader = new FrameReader();
    reader.push(message("x").subarray(0, 6));
    expect(() => reader.end()).toThrow(FrameRefusal);
  });
});
