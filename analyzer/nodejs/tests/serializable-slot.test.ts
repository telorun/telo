import { describe, expect, it } from "vitest";
import { liveValueIn, serializableAnnotationProblems } from "../src/serializable-slot.js";

const stream = { "x-telo-type": { name: "Telo.Stream", of: "Telo.Bytes" } };

describe("liveValueIn", () => {
  it("finds a live value at any depth, naming the path to it", () => {
    expect(liveValueIn({ type: "object", properties: { body: stream } })).toEqual({
      path: "/body",
      type: "Telo.Stream",
    });
    expect(liveValueIn({ type: "array", items: { anyOf: [{ type: "string" }, stream] } })?.path).toBe("/*");
    expect(liveValueIn({ type: "object", additionalProperties: { allOf: [stream] } })?.path).toBe("/*");
    expect(liveValueIn({ patternProperties: { "^x": { oneOf: [stream] } } })?.path).toBe("/*");
    expect(
      liveValueIn({ type: "object", properties: { part: { $ref: "#/$defs/Part" } }, $defs: { Part: stream } })?.path,
    ).toBe("/part");
    const named = { type: "object", properties: { inner: stream } };
    expect(
      liveValueIn({ type: "array", items: { $ref: "telo:Lib/Inner" } }, (id) =>
        id === "telo:Lib/Inner" ? named : undefined,
      )?.path,
    ).toBe("/*/inner");
  });

  it("reads a plain or instance value type as data, and ends on a recursive shape", () => {
    const tree: Record<string, any> = {
      type: "object",
      properties: { at: { "x-telo-type": "Telo.Timestamp" }, children: { type: "array", items: { $ref: "#" } } },
    };
    expect(liveValueIn(tree)).toBeUndefined();
  });
});

describe("serializableAnnotationProblems", () => {
  it("accepts the annotation on a shape slot and refuses it anywhere else, or as anything but true", () => {
    const problems = serializableAnnotationProblems({
      type: "object",
      properties: {
        shape: { "x-telo-ref": { kind: "Telo.Type", use: "schema" }, "x-telo-serializable": true },
        data: { "x-telo-fragment": "JsonSchema7", "x-telo-serializable": true },
        held: { "x-telo-ref": { kind: "Telo.Type", use: "dependency" }, "x-telo-serializable": true },
        named: { type: "string", "x-telo-serializable": true },
        typo: { "x-telo-ref": { kind: "Telo.Type", use: "schema" }, "x-telo-serializable": "yes" },
      },
    });
    expect(problems.map((problem) => problem.pointer)).toEqual([
      "/properties/held",
      "/properties/named",
      "/properties/typo",
    ]);
    expect(problems[2]!.message).toContain("takes only 'true'");
  });
});
