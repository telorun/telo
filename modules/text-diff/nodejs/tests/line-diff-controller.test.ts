import type { FunctionContext } from "@telorun/sdk";
import { expect, it } from "vitest";
import { LineDiff } from "../src/line-diff-controller.js";

it("an instance declaring no `maxInputBytes` compares texts of up to 262144 bytes", async () => {
  const instance = await LineDiff.create(
    { kind: "TextDiff.LineDiff", metadata: { name: "plain" } },
    {} as FunctionContext,
  );
  const atLimit = "a".repeat(262144);

  expect(instance.call({ before: atLimit, after: atLimit }).comparable).toBe(true);
  expect(instance.call({ before: `${atLimit}a`, after: "" })).toEqual({
    comparable: false,
    added: null,
    removed: null,
    hunks: null,
  });
});
