import { describe, expect, it } from "vitest";
import { create } from "../src/equals.js";

/** The `inputPointer` a failed `Assert.Equals` raises for these inputs. */
async function pointerFor(actual: unknown, expected: unknown): Promise<string | undefined> {
  const quiet = { write: () => true };
  const equals = await create({ metadata: { name: "equals" } }, { env: {}, stdout: quiet, stderr: quiet } as never);
  try {
    equals.invoke({ actual, expected });
  } catch (err) {
    return (err as { inputPointer?: string }).inputPointer;
  }
  throw new Error("expected the assertion to fail");
}

describe("a failed Assert.Equals points into its expected input", () => {
  it("at the first changed value", async () => {
    expect(await pointerFor({ rows: [1, 2], name: "a" }, { rows: [1, 3], name: "b" })).toBe("/expected/name");
  });

  it("at a key only the expected value holds", async () => {
    expect(await pointerFor({}, { "a/b": 1 })).toBe("/expected/a~1b");
  });

  it("at the enclosing node for what only the actual value holds", async () => {
    expect(await pointerFor({ rows: [1, 2, 3] }, { rows: [1, 2] })).toBe("/expected/rows");
    expect(await pointerFor({ server: { port: 1 } }, { server: {} })).toBe("/expected/server");
  });
});
