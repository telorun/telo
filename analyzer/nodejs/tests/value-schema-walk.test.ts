import { describe, expect, it } from "vitest";
import {
  renderValuePath,
  walkValueSchema,
  type ResidualKeys,
  type SchemaVisit,
  type ValueSchemaReader,
} from "../src/value-schema-walk.js";

const residualsOf = (schema: Record<string, any>, data: unknown, reader: ValueSchemaReader = {}) => {
  const found: ResidualKeys[] = [];
  walkValueSchema(schema, data, { ...reader, residualKeys: (residual) => found.push(residual) });
  return found.map(({ path, keys }) => ({ path: renderValuePath(path), keys }));
};

const visitsOf = (schema: Record<string, any>, data: unknown, reader: ValueSchemaReader = {}) => {
  const visits: SchemaVisit[] = [];
  walkValueSchema(schema, data, { ...reader, visit: (visit) => void visits.push(visit) });
  return visits;
};

describe("the value/schema co-walk", () => {
  it("reports the keys a closed schema does not type, beside the resource envelope", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string" }, inner: { type: "object", additionalProperties: false, properties: {} } },
    };
    expect(residualsOf(schema, { kind: "X.Y", metadata: {}, label: "a", href: "/", inner: { old: 1 } })).toEqual([
      { path: "", keys: ["href"] },
      { path: "inner", keys: ["old"] },
    ]);
  });

  it("reports nothing under an open schema", () => {
    const schema = { type: "object", properties: { label: { type: "string" } }, additionalProperties: { type: "object" } };
    expect(residualsOf(schema, { label: "a", payload: { anything: true }, other: { x: 1 } })).toEqual([]);
  });

  it("visits a union branch that excludes the value, marking it excluded, and counts its keys as typed", () => {
    const closed = { type: "object", required: ["to"], additionalProperties: false, properties: { to: { type: "string" } } };
    const other = { type: "object", additionalProperties: false, properties: { href: { type: "string" } } };
    const schema = { properties: { link: { anyOf: [closed, other] } } };
    const visits = visitsOf(schema, { link: { href: "/" } }).filter((visit) => visit.node === closed || visit.node === other);
    expect(visits.map((visit) => ({ branch: visit.node === closed ? "closed" : "other", excluded: visit.excluded }))).toEqual([
      { branch: "closed", excluded: true },
      { branch: "other", excluded: false },
    ]);
    expect(residualsOf(schema, { link: { href: "/" } })).toEqual([]);
  });

  it("reports a reference slot and does not descend into it", () => {
    const beneath = { type: "string" };
    const slot = { "x-telo-ref": { kind: "Telo.Invocable", use: "call" }, properties: { name: beneath } };
    const schema = { type: "object", additionalProperties: false, properties: { handler: slot } };
    const slots: { path: string; uses: string[] }[] = [];
    const visits = visitsOf(schema, { handler: { kind: "Self.Handler", name: "h", extra: 1 } }, {
      referenceSlot: (visit, found) => void slots.push({ path: renderValuePath(visit.path), uses: [...found.uses] }),
    });
    expect(slots).toEqual([{ path: "handler", uses: ["call"] }]);
    expect(visits.some((visit) => visit.node === beneath)).toBe(false);
    expect(residualsOf(schema, { handler: { kind: "Self.Handler", name: "h", extra: 1 } })).toEqual([]);
  });

  it("does not walk a schema the reader's reach gate says cannot reach its target", () => {
    const schema = { type: "object", properties: { label: { type: "string" } } };
    expect(visitsOf(schema, { label: "a" }, { reaches: () => false })).toEqual([]);
    expect(visitsOf(schema, { label: "a" }, { reaches: () => true }).length).toBeGreaterThan(0);
  });

  it("walks the values standing at a position in place of the one written there", () => {
    const tagged = { tag: "if", then: { label: "a" }, else: { label: "b", stale: 1 } };
    const label = { type: "string" };
    const schema = { type: "object", additionalProperties: false, properties: { field: { type: "object", additionalProperties: false, properties: { label } } } };
    const reader: ValueSchemaReader = {
      standing: (value, path) =>
        value === tagged
          ? [
              { value: tagged.then, path: [...path, "then"] },
              { value: tagged.else, path: [...path, "else"] },
            ]
          : undefined,
    };
    const atLabel = visitsOf(schema, { field: tagged }, reader)
      .filter((visit) => visit.node === label)
      .map((visit) => ({ path: renderValuePath(visit.path), value: visit.value }));
    expect(atLabel).toEqual([
      { path: "field.then.label", value: "a" },
      { path: "field.else.label", value: "b" },
    ]);
    expect(residualsOf(schema, { field: tagged }, reader)).toEqual([{ path: "field.else", keys: ["stale"] }]);
  });

  it("treats a value the seam answers with no values as a boundary, seen and never descended", () => {
    const label = { type: "string" };
    const schema = { type: "object", properties: { field: { type: "object", properties: { label } } } };
    const expression = { expression: "self.x" };
    const visits = visitsOf(schema, { field: expression }, { standing: (value) => (value === expression ? [] : undefined) });
    expect(visits.filter((visit) => visit.boundary).map((visit) => renderValuePath(visit.path))).toEqual(["field"]);
    expect(visits.some((visit) => visit.node === label)).toBe(false);
  });
});
