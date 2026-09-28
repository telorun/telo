import { describe, expect, it } from "vitest";
import { refuseMistypedResults } from "../src/compiled-results.js";
import { SchemaValidator } from "../src/schema-validator.js";

/**
 * Holding a compile-eval result to its slot's schema must not change the result:
 * an expression may return an object other readers share (`variables.x`, a
 * published `resources.x`), and a default the slot declares is not written into
 * it.
 */
describe("refuseMistypedResults", () => {
  it("leaves the evaluated value exactly as the expression produced it", () => {
    const expression = { __compiled: true, call: () => undefined };
    const shared = { a: "x" };
    const schema = {
      type: "object",
      properties: {
        cfg: {
          type: "object",
          properties: {
            a: { type: "string" },
            filled: { type: "string", default: "INJECTED" },
          },
        },
      },
    };
    refuseMistypedResults({ cfg: expression }, { cfg: shared }, schema, new SchemaValidator(), (path, problem) =>
      new Error(`${path} ${problem}`),
    );
    expect(shared).toEqual({ a: "x" });
  });
});
