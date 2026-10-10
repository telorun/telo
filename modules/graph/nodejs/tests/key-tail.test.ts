import { describe, expect, it } from "vitest";
import { encodeTypedFrame, TYPED_FRAME_GENERATION } from "@telorun/sdk";
import { decodeKeyTail, encodeKeyTail } from "../src/key-tail.js";

describe("a listing's key tail", () => {
  it("returns each key as the value it was written from", () => {
    const keys = [
      "p00042",
      42,
      9223372036854775807n,
      -9223372036854775808n,
      4.5,
      Number.NEGATIVE_INFINITY,
      true,
      false,
    ];
    expect(decodeKeyTail(encodeKeyTail(keys), keys.length)).toEqual(keys);
    expect(decodeKeyTail(encodeKeyTail([Number.NaN]), 1)).toEqual([Number.NaN]);
  });

  it("returns bytes as bytes", () => {
    const [read] = decodeKeyTail(encodeKeyTail([new Uint8Array([0, 255, 16])]), 1) ?? [];
    expect(read).toBeInstanceOf(Uint8Array);
    expect([...(read as Uint8Array)]).toEqual([0, 255, 16]);
  });

  it("gives no value for a tail of another arity", () => {
    expect(decodeKeyTail(encodeKeyTail(["a", "b"]), 1)).toBeUndefined();
    expect(decodeKeyTail(encodeKeyTail(["a"]), 2)).toBeUndefined();
  });

  it("gives no value for text that is not a frame behind a generation", () => {
    const generation = TYPED_FRAME_GENERATION;
    for (const tail of [
      "p00042",
      '["a"]',
      `${generation}:p00042`,
      `${generation}:"a"`,
      `${generation}:{"0":"a"}`,
      `${generation}:[{"$telo":"text","value":"a"}]`,
      `${generation}:[{"$telo":"int","value":"7; DROP"}]`,
      `${generation}:[{"$telo":"int","value":"9223372036854775808"}]`,
      `${generation}:[{"$telo":"int","value":"-9223372036854775809"}]`,
      `:${encodeTypedFrame(["a"])}`,
      `0${generation}:${encodeTypedFrame(["a"])}`,
    ]) {
      expect(decodeKeyTail(tail, 1), tail).toBeUndefined();
    }
  });

  it("gives no value for a frame generation this runtime does not read", () => {
    expect(decodeKeyTail(`999:${encodeTypedFrame(["a"])}`, 1)).toBeUndefined();
  });

  it("refuses a host date with the frame's own code", () => {
    expect(() => encodeKeyTail([new Date(0)])).toThrowError(
      expect.objectContaining({ code: "ERR_TYPED_FRAME_UNENCODABLE" }),
    );
  });
});
