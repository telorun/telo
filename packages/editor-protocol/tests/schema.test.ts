import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TeloMethod } from "../src/index.js";

const schema = JSON.parse(
  readFileSync(new URL("../editor-protocol-schema.json", import.meta.url), "utf8"),
);

describe("editor-protocol-schema.json", () => {
  // The schema is the contract for a host that cannot read the TypeScript, so it
  // must name every method the TypeScript does and compile as JSON Schema.
  it("covers every method and compiles", () => {
    expect(Object.keys(schema["x-telo-methods"]).sort()).toEqual(Object.values(TeloMethod).sort());
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(schema);
    for (const { params, result } of Object.values(
      schema["x-telo-methods"] as Record<string, { params: string; result?: string }>,
    )) {
      for (const ref of [params, result].filter((r): r is string => r !== undefined)) {
        expect(ajv.getSchema(`${schema.$id}${ref}`), ref).toBeTypeOf("function");
      }
    }
  });
});
