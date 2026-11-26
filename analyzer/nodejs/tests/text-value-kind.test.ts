import { DYN, INT, mapOf, recordOf, STRING } from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { celTypeValueKind } from "../src/text-judgement.js";

describe("what a CEL type admits as a message value", () => {
  it("reads the type itself, so a record and a map that print alike are told apart", () => {
    // Both print `map`: a reader of the text could not say which one a value is.
    expect(celTypeValueKind(recordOf(new Map([["a", STRING]])))).toEqual({ kind: "refused", describe: "a record" });
    expect(celTypeValueKind(mapOf(DYN, DYN))).toEqual({ kind: "refused", describe: "a map" });
    expect(celTypeValueKind(STRING)).toEqual({ kind: "string", describe: "a string" });
    expect(celTypeValueKind(INT)).toEqual({ kind: "number", describe: "a int" });
    expect(celTypeValueKind(DYN).kind).toBe("unknown");
  });
});
