import { describe, expect, it } from "vitest";
import { shapeProblems } from "../src/collection-controller.js";

const draft = { additionalProperties: false, properties: { text: { type: "string" } } };
const model = { required: ["id"], properties: { id: { type: "integer" }, text: { type: "string" } } };

describe("an operation shape declaring a member every object inherits", () => {
  it.each(["constructor", "toString", "hasOwnProperty"])("refuses %s as a property the model lacks", (name) => {
    const list = { required: ["id"], properties: { ...model.properties, [name]: { type: "string" } } };
    expect(shapeProblems(model, { list, create: draft, update: draft }).map((problem) => problem.code)).toEqual([
      "CRUD_COLLECTION_PROPERTY_NOT_READABLE",
    ]);
  });
});
