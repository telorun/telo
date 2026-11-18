import { describe, expect, it } from "vitest";
import { SchemaValidationError, SchemaValidator } from "../src/schema-validator.js";

/** A tagged union with a tagged union inside it, registered as a named shape and
 *  then validated against as itself: the failure path holds it twice — as the
 *  schema asked about whole and as the registered document its references name. */
const NODE = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      required: ["type", "store"],
      properties: {
        type: { const: "view" },
        store: {
          oneOf: [
            { type: "object", required: ["type"], properties: { type: { const: "list" } } },
            { type: "object", required: ["type"], properties: { type: { const: "map" } } },
          ],
        },
      },
    },
    { type: "object", required: ["type"], properties: { type: { const: "text" } } },
  ],
};

const BAD = { type: "view", store: { type: "lst" } };
const TAG = "/store/type must be equal to one of the allowed values (list | map)";

function refusalOf(validator: SchemaValidator, schema: object, value: unknown): string[] {
  try {
    validator.compile(schema).validate(value);
  } catch (error) {
    if (error instanceof SchemaValidationError) return error.issues.map((issue) => issue.message);
    throw error;
  }
  throw new Error("The value was accepted.");
}

describe("a union refused on the kernel's failure path", () => {
  it("is decided by its tag when the schema is itself a registered shape", () => {
    const validator = new SchemaValidator();
    validator.addSchema("telo:Test/Node", NODE);
    expect(refusalOf(validator, NODE, BAD)).toEqual([TAG]);
  });

  it("is decided by its tag inside a shape another schema reaches, once the shape was refused as a whole", () => {
    const validator = new SchemaValidator();
    validator.addSchema("telo:Test/Node", NODE);
    refusalOf(validator, NODE, BAD);
    const holder = { type: "object", properties: { node: { $ref: "telo:Test/Node" } } };
    expect(refusalOf(validator, holder, { node: BAD })).toEqual([`/node${TAG}`]);
  });
});
