import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { kindDeclarationOf } from "../src/kind-declaration.js";

const needType = {
  kind: "Telo.NeedType",
  metadata: {
    name: "DatabaseAccess",
    module: "fixtures",
    description: "The address of a database.",
    categories: ["Storage"],
    deprecated: { reason: "Use Endpoint." },
  },
  fields: { url: { type: "string" }, schema: { type: "string" } },
  required: ["url"],
} as unknown as ResourceManifest;

describe("the kind a document declares", () => {
  it("is the document itself for a definition or an abstract", () => {
    const definition = { kind: "Telo.Definition", metadata: { name: "Thing" } };
    const abstract = { kind: "Telo.Abstract", metadata: { name: "Contract" } };
    expect(kindDeclarationOf(definition)).toBe(definition);
    expect(kindDeclarationOf(abstract)).toBe(abstract);
    expect(kindDeclarationOf({ kind: "Telo.Library", metadata: { name: "Lib" } })).toBeUndefined();
  });

  it("is one object per need-type document", () => {
    expect(kindDeclarationOf(needType)).toBe(kindDeclarationOf(needType));
  });

  it("carries a need type's authored metadata whole", () => {
    expect(kindDeclarationOf(needType)!.metadata).toEqual(needType.metadata);
  });

  it("gives a need type a closed author schema of its fields", () => {
    const declared = kindDeclarationOf(needType)!;
    expect(declared.capability).toBe("Telo.Provider");
    expect(declared.schema).toEqual({
      type: "object",
      properties: {
        fields: {
          type: "object",
          properties: { url: { type: "string" }, schema: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      required: ["fields"],
      additionalProperties: false,
    });
  });
});
