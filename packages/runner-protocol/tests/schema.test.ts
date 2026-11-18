import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IO_CLOSE } from "../src/index.js";

const schema = JSON.parse(readFileSync(new URL("../runner-protocol-schema.json", import.meta.url), "utf8"));

describe("runner-protocol-schema.json", () => {
  it("compiles and resolves every shape the route table names", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    ajv.addSchema(schema);
    const names = new Set<string>();
    for (const route of Object.values(schema["x-telo-routes"] as Record<string, any>)) {
      if (route.request) names.add(route.request);
      for (const name of Object.values(route.responses)) if (name) names.add(name as string);
    }
    for (const name of names) {
      expect(ajv.getSchema(`${schema.$id}#/$defs/${name}`), name).toBeTypeOf("function");
    }
  });

  it("closes every object shape a runner answers, bar the error and open bags", () => {
    const open = new Set(["RunnerError", "DebugFrame", "JsonSchema", "SessionConfig"]);
    const unclosed = Object.entries(schema.$defs as Record<string, any>)
      .filter(([name, def]) => !open.has(name) && def.type === "object" && def.properties)
      .filter(([, def]) => def.additionalProperties === undefined)
      .map(([name]) => name);
    expect(unclosed).toEqual([]);
  });

  it("states the byte channel's close codes the TypeScript does", () => {
    expect(schema["x-telo-byte-channel"].closeCodes).toEqual(IO_CLOSE);
  });
});
