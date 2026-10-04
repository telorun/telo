import {
  celDurationFromNanos,
  celMapFromEntries,
  celTimestamp,
  celUint,
} from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { nodeCelHandlers } from "../src/cel-handlers.js";

/**
 * `json(dyn): string` is the JSON text of a CEL value for a reader that is NOT a Telo
 * runtime, so the host handler behind it writes through the SDK's plain-JSON writer — the
 * one writer for exactly that audience — rather than letting `JSON.stringify` write
 * whatever each representation happens to look like.
 *
 * **What this gate's filter cannot reach:** it asks what `json` answers for values the
 * writer has a form for. A representation the writer does not know is left to the
 * serializer by design, so a NEW value type added to the domain without a plain form
 * passes here and still writes its internals. That is the writer's own gate
 * (`sdk/tests/plain-json.test.ts`), which enumerates the forms.
 */
describe("the json handler", () => {
  it("writes a map as its contents, not as the container the value domain holds it in", () => {
    // `{"entries":{}}` is what a bare `JSON.stringify` wrote: the carrier.
    expect(nodeCelHandlers.json(celMapFromEntries(["a", 1n]))).toBe('{"a":1}');
    // A key a plain object cannot hold is written as its text — the protobuf JSON rule —
    // rather than dropped or collapsed with another.
    expect(nodeCelHandlers.json(celMapFromEntries([1n, "one", true, "yes"]))).toBe(
      '{"1":"one","true":"yes"}',
    );
    expect(nodeCelHandlers.json({ nested: celMapFromEntries(["a", 1n]) })).toBe(
      '{"nested":{"a":1}}',
    );
  });

  it("writes every other value of the domain as the one plain form its type declares", () => {
    expect(nodeCelHandlers.json(9007199254740993n)).toBe("9007199254740993");
    expect(nodeCelHandlers.json(celUint(7n))).toBe("7");
    expect(nodeCelHandlers.json(new Uint8Array([1, 2, 255]))).toBe('"AQL_"');
    expect(nodeCelHandlers.json(celTimestamp(0n, 0))).toBe('"1970-01-01T00:00:00Z"');
    expect(nodeCelHandlers.json(celDurationFromNanos(5400n * 1_000_000_000n))).toBe('"5400s"');
    expect(nodeCelHandlers.json(null)).toBe("null");
  });

  it("refuses a map two of whose keys are written as one text, rather than dropping one", () => {
    expect(() => nodeCelHandlers.json(celMapFromEntries([1n, "int", "1", "string"]))).toThrow(
      /two of its keys are written as '1'/,
    );
  });
});
