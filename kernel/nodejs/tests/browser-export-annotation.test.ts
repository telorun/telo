import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

describe("a kind whose x-telo-browser-export is malformed", () => {
  it("is refused when it is registered", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Component", module: "Ui" },
        capability: "Telo.Provider",
        schema: {
          type: "object",
          properties: {
            entry: { type: "string" },
            export: { type: "string", "x-telo-browser-export": { entry: "/entry", abi: ["ui"] } },
          },
        },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_BROWSER_EXPORT_ANNOTATION_INVALID",
        message: expect.stringContaining(
          "Telo.Definition 'Component' declares 'schema.properties.export.x-telo-browser-export.abi'",
        ),
      }),
    );
  });
});
