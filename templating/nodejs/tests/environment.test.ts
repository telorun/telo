import { Stream } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";

describe("buildCelEnvironment", () => {
  it("registers Telo's stdlib of CEL functions", () => {
    const env = buildCelEnvironment();
    expect(env.parse("join(['a', 'b', 'c'], '-')")({})).toBe("a-b-c");
    expect(env.parse("keys({'x': 1, 'y': 2})")({})).toEqual(["x", "y"]);
    // cel-js parses integer literals as BigInts; assert that shape.
    expect(env.parse("values({'x': 1, 'y': 2})")({})).toEqual([1n, 2n]);
  });

  it("calls user-supplied handlers for sha256", () => {
    const env = buildCelEnvironment({ sha256: (s) => `H(${s})` });
    expect(env.parse("sha256('hello')")({})).toBe("H(hello)");
  });

  it("registers Stream as a CEL object type so producers can pass async iterables through", () => {
    const env = buildCelEnvironment();
    const stream = new Stream(
      (async function* () {
        yield "a";
      })(),
    );
    // Pass through the value — type-checker accepts the registered constructor.
    expect(env.parse("input")({ input: stream })).toBe(stream);
  });

  it("default sha256 stub throws a helpful error", () => {
    const env = buildCelEnvironment();
    expect(() => env.parse("sha256('x')")({})).toThrow(/sha256/);
  });
});
