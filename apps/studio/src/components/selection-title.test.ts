import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { selectionTitle } from "./selection-title";

const app = (targets: unknown[]) => ({
  kind: "Telo.Application",
  name: "HelloWorld",
  fields: { targets },
});
const call = makeTaggedSentinel("ref", "Console.writeLine");

describe("selectionTitle", () => {
  it("names a boot step's arguments", () => {
    const r = app([{ invoke: call, inputs: { output: "Hi" } }]);
    expect(selectionTitle(r, "/targets/0/inputs")).toBe(
      "Boot step 1 · Console.writeLine · arguments",
    );
  });

  it("names the step itself, with a bare reference as its target", () => {
    expect(selectionTitle(app([call, call]), "/targets/1")).toBe("Boot step 2 · Console.writeLine");
  });

  it("keeps the pointer for anything else", () => {
    expect(selectionTitle(app([call]), "/variables/x")).toBe("HelloWorld • /variables/x");
    expect(
      selectionTitle({ kind: "Console.Thing", name: "t", fields: {} }, "/targets/0/inputs"),
    ).toBe("t • /targets/0/inputs");
    expect(selectionTitle(app([]), "")).toBe("HelloWorld");
  });
});
