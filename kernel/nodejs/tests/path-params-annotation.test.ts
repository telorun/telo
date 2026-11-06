import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

describe("a kind whose x-telo-path-params-for is misplaced", () => {
  it("is refused when it is registered", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Link", module: "Ui" },
        capability: "Telo.Provider",
        schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            id: { type: "string", "x-telo-path-params-for": { template: "/path" } },
          },
        },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_PATH_PARAMS_FOR_INVALID",
        message: expect.stringContaining(
          "Telo.Definition 'Link' declares 'schema.properties.id.x-telo-path-params-for' on a property that holds no object",
        ),
      }),
    );
  });
});
