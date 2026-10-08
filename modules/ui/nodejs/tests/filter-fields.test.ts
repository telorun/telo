import { describe, expect, it } from "vitest";
import type { CollectionQuery } from "../src/collection-controller.js";
import { filterFields } from "../src/filters-controller.js";

const schema = {
  properties: {
    dueOn: { type: ["string", "null"], format: "date" },
    tags: { type: "array" },
  },
};

const accepted: CollectionQuery["filters"] = [
  { property: "dueOn", operator: "gte" },
  { property: "tags", operator: "eq" },
];

describe("a listed filter", () => {
  it("is not judged where the property declares several types", () => {
    expect(filterFields(schema, accepted, [{ property: "dueOn", operator: "gte" }], "f")).toEqual([
      { property: "dueOn", operator: "gte", label: "dueOn", schema: schema.properties.dueOn, pinned: false, control: "auto" },
    ]);
  });

  it("is refused on a list whatever the collection accepts", () => {
    expect(() => filterFields(schema, accepted, [{ property: "tags", operator: "eq" }], "Ui.Filters 'f'")).toThrow(
      "'fields[0]' uses an operator the property's type does not support ('eq' on 'tags', declared array)",
    );
  });
});

describe("a filter naming a member every object inherits", () => {
  const inherited: CollectionQuery["filters"] = [{ property: "constructor", operator: "eq" }];

  it("is refused as a property the model does not declare, listed or derived", () => {
    expect(() => filterFields(schema, inherited, inherited, "f")).toThrow(
      "'fields[0]' filters by a property the model does not declare ('constructor')",
    );
    expect(() => filterFields(schema, inherited, undefined, "f")).toThrow("it does not declare 'constructor'");
  });
});
