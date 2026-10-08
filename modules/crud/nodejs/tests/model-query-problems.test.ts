import { describe, expect, it } from "vitest";
import { shapeProblems } from "../src/model-controller.js";

const draft = { additionalProperties: false, properties: { text: { type: "string" } } };
const record = { required: ["id"], properties: { id: { type: "integer" }, text: { type: "string" } } };
const schemas = { read: record, list: record, create: draft, update: draft };

const codes = (query: { filters: { property: string; operator: string }[]; sort: { property: string }[] }) =>
  shapeProblems(schemas, query).map((problem) => problem.code);

describe("a declared query naming a member every object inherits", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])("refuses %s as a property the read shape lacks", (name) => {
    expect(codes({ filters: [{ property: name, operator: "eq" }], sort: [{ property: name }] })).toEqual([
      "CRUD_MODEL_FILTER_UNKNOWN_PROPERTY",
      "CRUD_MODEL_SORT_UNKNOWN_PROPERTY",
    ]);
  });
});
