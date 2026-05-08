import { describe, expect, it } from "vitest";
import { walkCelExpressions } from "../src/cel/walk.js";
import { makeTaggedSentinel } from "../src/sentinel.js";

type Emit = [source: string, path: string, engine: string];

function collect(value: unknown): Emit[] {
  const out: Emit[] = [];
  walkCelExpressions(value, "", (source, path, engine) => out.push([source, path, engine]));
  return out;
}

describe("walkCelExpressions", () => {
  it("emits each ${{ }} segment in an untagged string with engine='cel'", () => {
    const value = { greeting: "Hello ${{ variables.name }}!" };
    expect(collect(value)).toEqual([["variables.name", "greeting", "cel"]]);
  });

  it("emits multiple segments in interpolated strings", () => {
    const value = "${{ a }} and ${{ b }}";
    const out: Emit[] = [];
    walkCelExpressions(value, "field", (s, p, e) => out.push([s, p, e]));
    expect(out).toEqual([
      ["a", "field", "cel"],
      ["b", "field", "cel"],
    ]);
  });

  it("recurses into arrays with [N] index segments in the path", () => {
    const value = { steps: [{ x: "${{ a }}" }, { x: "${{ b }}" }] };
    expect(collect(value)).toEqual([
      ["a", "steps[0].x", "cel"],
      ["b", "steps[1].x", "cel"],
    ]);
  });

  it("emits the source of a !cel-tagged sentinel with engine='cel'", () => {
    const value = { port: makeTaggedSentinel("cel", "variables.port") };
    expect(collect(value)).toEqual([["variables.port", "port", "cel"]]);
  });

  it("emits the source of a !literal-tagged sentinel with engine='literal'", () => {
    // The walker is generic over engines; downstream dispatch through the
    // registry decides whether the engine produces diagnostics. Today
    // literalEngine.analyze returns []; future engines may return real
    // findings without touching the walker.
    const value = { greeting: makeTaggedSentinel("literal", "Hello ${{ x }}") };
    expect(collect(value)).toEqual([["Hello ${{ x }}", "greeting", "literal"]]);
  });

  it("emits unknown-engine sentinels for forward-compat dispatch", () => {
    const value = { x: makeTaggedSentinel("future-engine", "expr") };
    expect(collect(value)).toEqual([["expr", "x", "future-engine"]]);
  });

  it("skips compiled values to avoid re-walking precompiled trees", () => {
    const compiled = { __compiled: true, source: "x", call: () => 1, nested: "${{ y }}" };
    expect(collect({ field: compiled })).toEqual([]);
  });

  it("returns no callbacks for plain primitives without ${{ }}", () => {
    expect(collect({ port: 8080, host: "localhost", flag: true })).toEqual([]);
  });

  it("does not double-emit when a tagged sentinel sits inside a deeply nested array", () => {
    const value = {
      routes: [
        { handler: { body: makeTaggedSentinel("cel", "request.query.name") } },
        { handler: { body: "literal" } },
      ],
    };
    expect(collect(value)).toEqual([
      ["request.query.name", "routes[0].handler.body", "cel"],
    ]);
  });
});
