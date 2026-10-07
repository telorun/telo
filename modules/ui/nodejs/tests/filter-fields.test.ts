import { describe, expect, it } from "vitest";
import { filterFields } from "../src/filters-controller.js";

const schema = {
  properties: {
    dueOn: { type: ["string", "null"], format: "date" },
    tags: { type: "array" },
  },
};

describe("a listed filter", () => {
  it("is not judged where the property declares several types", () => {
    expect(filterFields(schema, [{ property: "dueOn", operator: "gte" }], "f")).toEqual([
      { property: "dueOn", operator: "gte", label: "dueOn", schema: schema.properties.dueOn },
    ]);
  });

  it("is refused on a list even with no operator written", () => {
    expect(() => filterFields(schema, [{ property: "tags" }], "Ui.Filters 'f'")).toThrow(
      "'fields[0]' uses an operator the property's type does not support ('eq' on 'tags', declared array)",
    );
  });
});
