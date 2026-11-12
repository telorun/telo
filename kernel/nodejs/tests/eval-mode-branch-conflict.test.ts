import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

describe("a kind whose union gives one property two eval modes", () => {
  it("is refused when it is registered", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Card", module: "Ui" },
        capability: "Telo.Provider",
        schema: {
          type: "object",
          properties: {
            content: {
              oneOf: [
                { type: "object", properties: { text: { "x-telo-eval": "accessor" } } },
                { type: "object", properties: { text: { type: "string" } } },
              ],
            },
          },
        },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_EVAL_MODE_BRANCH_CONFLICT",
        message: expect.stringContaining(
          "Telo.Definition 'Card' declares a union at 'schema.properties.content' whose branches give 'text' two eval modes: oneOf[0] makes it an accessor",
        ),
      }),
    );
  });
});
