import { describe, expect, it } from "vitest";
import type { AcceptedQuery } from "../src/collection-source.js";
import { filterFields } from "../src/filters-controller.js";
import type { OptionSourceSpec } from "../src/option-source.js";
import { schemaText } from "../src/spec-texts.js";

const schema = {
  properties: {
    dueOn: { type: ["string", "null"], format: "date" },
    authorId: { type: "integer" },
  },
};

const query: AcceptedQuery = {
  filters: [
    { property: "dueOn", operator: "gte" },
    { property: "dueOn", operator: "absent" },
    { property: "authorId", operator: "eq" },
  ],
  sort: [],
  facets: [{ property: "authorId" }],
};

const records = (basePath: string, value: string): OptionSourceSpec => ({
  type: "collection",
  schema: { type: "object", properties: { [value]: { type: "integer" } } },
  value: { root: "row", path: [value] },
  label: { root: "row", path: [value] },
  basePath,
  filters: {},
  pageSize: 25,
});

describe("a listed filter", () => {
  it("is not judged where the property declares several types", () => {
    expect(filterFields(schema, query, [{ property: "dueOn", operator: "gte" }], "f")).toEqual([
      {
        property: "dueOn",
        operator: "gte",
        label: schemaText("dueOn", null),
        labels: [],
        schema: schema.properties.dueOn,
        pinned: false,
        control: "auto",
        values: "all",
      },
    ]);
  });

  it("holds only true under absent, as a switch does", () => {
    expect(filterFields(schema, query, [{ property: "dueOn", operator: "absent", default: true }], "f")[0].default).toEqual([true]);
    expect(() => filterFields(schema, query, [{ property: "dueOn", operator: "absent", default: false }], "f")).toThrow(
      "anything but 'true' under 'absent'",
    );
  });
});

describe("a filter over a property with a relation", () => {
  const relations = { authorId: records("/api/authors", "id") };

  it("offers the related records, listed or derived", () => {
    const listed = filterFields(schema, query, [{ property: "authorId", operator: "eq" }], "f", { overrides: new Map(), relations });
    expect(listed[0].options).toBe(relations.authorId);
    const derived = filterFields(schema, query, undefined, "f", { overrides: new Map(), relations });
    expect(derived.find((field) => field.property === "authorId")?.options).toBe(relations.authorId);
  });

  it("offers its own option source's records in their place", () => {
    const own = records("/api/people", "personId");
    const [field] = filterFields(schema, query, [{ property: "authorId", operator: "eq" }], "f", {
      overrides: new Map([[0, own]]),
      relations,
    });
    expect(field.options).toBe(own);
  });
});
