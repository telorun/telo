import { describe, expect, it } from "vitest";
import { unboundCallReason } from "../src/unbound-call-site.js";

describe("x-telo-unbound-calls", () => {
  it("is found in a schema holding a bigint default and a cycle", () => {
    const schema: Record<string, any> = {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10n },
        logging: { type: "object", "x-telo-unbound-calls": "resolved before any resource exists" },
      },
    };
    schema.properties.self = schema;
    expect(unboundCallReason(schema, "logging.level")).toBe("resolved before any resource exists");
  });
});
