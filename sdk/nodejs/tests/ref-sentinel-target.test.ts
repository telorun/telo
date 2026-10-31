import { describe, expect, it } from "vitest";
import { refSentinelTarget } from "../src/ref.js";

// Sentinels as the loader makes them: the `!ref` engine's verdict beside the text.
const sentinel = (source: string, verdict: object) => ({
  __tagged: true,
  engine: "ref",
  source,
  ...verdict,
});

describe("refSentinelTarget", () => {
  it("reads a plain, an aliased and a Self reference from the engine's verdict", () => {
    expect(refSentinelTarget(sentinel("db", { parsed: { name: "db", indexes: [] } }))).toEqual({
      name: "db",
    });
    expect(
      refSentinelTarget(
        sentinel("Console.writeLine", { parsed: { alias: "Console", name: "writeLine", indexes: [] } }),
      ),
    ).toEqual({ name: "writeLine", alias: "Console" });
    expect(
      refSentinelTarget(sentinel("Self.db", { parsed: { alias: "Self", name: "db", indexes: [] } })),
    ).toEqual({ name: "db" });
  });

  it("refuses a family member's reference and a text outside the grammar", () => {
    const indexed = sentinel("stores[each.key]", {
      parsed: { name: "stores", indexes: [{ binding: "each", member: "key" }] },
    });
    expect(() => refSentinelTarget(indexed)).toThrow(/'!ref stores\[each\.key\]' names a family member/);
    const refused = sentinel("a.b.c", { refusal: { code: "REF_MEMBER_INVALID", offset: 3 } });
    expect(() => refSentinelTarget(refused)).toThrow(/'!ref a\.b\.c' is not a reference \(inadmissible text at offset 3\)/);
    try {
      refSentinelTarget(refused);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ERR_REF_UNRESOLVED");
    }
  });
});
