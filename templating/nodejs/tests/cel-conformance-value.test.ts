import { Optional } from "@marcbachmann/cel-js";
import { Duration, UnsignedInt } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelLanguageEnvironment } from "../src/cel/environment.js";
import { conformanceValueCodec, unpairedSurrogateAt } from "./cel-conformance-value.js";

const env = buildCelLanguageEnvironment();
const codec = conformanceValueCodec(env);
const type = (name: string) => env.evaluate(name);

describe("conformance value", () => {
  it.each([
    ["int64 beyond 2^53", -(2n ** 63n), { $telo: "int", value: "-9223372036854775808" }],
    ["uint", new UnsignedInt(2n ** 64n - 1n), { $telo: "uint", value: "18446744073709551615" }],
    ["NaN", Number.NaN, { $telo: "double", value: "NaN" }],
    ["Infinity", Number.POSITIVE_INFINITY, { $telo: "double", value: "Infinity" }],
    ["-Infinity", Number.NEGATIVE_INFINITY, { $telo: "double", value: "-Infinity" }],
    ["-0", -0, { $telo: "double", value: "-0" }],
    ["bytes", new Uint8Array([0, 255]), { $telo: "bytes", value: "AP8" }],
    ["timestamp", new Date("2009-02-13T23:31:30Z"), { $telo: "google.protobuf.Timestamp", value: "2009-02-13T23:31:30.000Z" }],
    ["duration", new Duration(90n, 5), { $telo: "google.protobuf.Duration", value: "90.000000005s" }],
    [
      "map with non-string keys",
      new Map<unknown, unknown>([[2n, "b"], [true, "t"], [new UnsignedInt(1n), "a"]]),
      {
        $telo: "map",
        value: [
          [true, "t"],
          [{ $telo: "int", value: "2" }, "b"],
          [{ $telo: "uint", value: "1" }, "a"],
        ],
      },
    ],
    ["map holding the $cel key", { $cel: "type", value: "int" }, { $telo: "map", value: [["$cel", "type"], ["value", "int"]] }],
    [
      "nested type and optional forms",
      { b: Optional.of([type("int"), Optional.none()]), a: Optional.of(Optional.of(type("google.protobuf.Duration"))) },
      {
        a: { $cel: "optional", value: { $cel: "optional", value: { $cel: "type", value: "google.protobuf.Duration" } } },
        b: { $cel: "optional", value: [{ $cel: "type", value: "int" }, { $cel: "optional" }] },
      },
    ],
    ["the null type", type("null_type"), { $cel: "type", value: "null" }],
  ])("writes and reads back %s", (name, value, encoded) => {
    expect(codec.encode(value)).toStrictEqual(encoded);
    expect(codec.encode(codec.decode(encoded))).toStrictEqual(encoded);
  });

  it.each([
    ["an int outside int64", 2n ** 63n],
    ["an undefined map value", { a: undefined }],
    ["a class instance", new (class Thing {})()],
  ])("refuses to write %s", (name, value) => {
    expect(() => codec.encode(value)).toThrow(/Cannot write a conformance value/);
  });

  it.each([
    ["a type the environment does not name", { $cel: "type", value: "Nope" }],
    ["a tagged map whose keys are plain", { $telo: "map", value: [["a", 1]] }],
    ["a plain map out of key order", { b: 1, a: 2 }],
  ])("refuses to read %s", (name, node) => {
    expect(() => codec.decode(node)).toThrow(/Cannot read a conformance value/);
  });
});

describe("a conformance file holding an unpaired surrogate", () => {
  it.each([
    ["a value written as an escape", '{"rows":[{"id":"a","source":"x","bindings":{"x":"\\ud83d"}}]}', "/rows/0/bindings/x"],
    ["a value written raw", `{"rows":[{"source":"${"\ude00"}"}]}`, "/rows/0/source"],
    ["a key", '{"rows":[{"bindings":{"\\udc00":1}}]}', "/rows/0/bindings/\udc00"],
  ])("is found in %s", (name, text, at) => {
    expect(unpairedSurrogateAt(JSON.parse(text))).toBe(at);
  });

  it("is not found where every surrogate is paired", () => {
    expect(unpairedSurrogateAt(JSON.parse('{"rows":[{"source":"\\ud83d\\ude00 \ud83d\ude00"}]}'))).toBeUndefined();
  });
});
