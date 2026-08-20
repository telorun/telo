import { describe, expect, it } from "vitest";
import { refSlotReadingSchema, withRefSlotsAsReadings } from "../src/ref-slot-reading.js";

const REPORTING = {
  kind: "Telo.Definition",
  metadata: { name: "Table", module: "Sql" },
  status: {
    type: "object",
    properties: { table: { type: "string" }, rowCount: { type: "integer" } },
  },
};

const OTHER = {
  kind: "Telo.Definition",
  metadata: { name: "View", module: "Sql" },
  status: { type: "object", properties: { table: { type: "string" } } },
};

const scope = (defs: Record<string, any>) => ({
  resolve: (kind: string) => defs[kind],
});

describe("refSlotReadingSchema", () => {
  it("types the declared `status` half and leaves the snapshot half open", () => {
    const reading = refSlotReadingSchema(
      { title: "Table", "x-telo-ref": { kind: "Sql.Table", use: "dependency" } },
      scope({ "Sql.Table": REPORTING }),
    )!;

    // The flat half is what `snapshot()` returned, which no manifest declares.
    expect(reading.additionalProperties).toBe(true);
    expect(reading.properties.status.additionalProperties).toBe(false);
    expect(Object.keys(reading.properties.status.properties)).toEqual(["table", "rowCount"]);
    // The slot's own prose survives, so hover still says what the slot is.
    expect(reading.title).toBe("Table");
  });

  it("keeps only the status fields every permitted kind declares", () => {
    const reading = refSlotReadingSchema(
      { "x-telo-ref": { kind: ["Sql.Table", "Sql.View"], use: "dependency" } },
      scope({ "Sql.Table": REPORTING, "Sql.View": OTHER }),
    )!;

    // `rowCount` is reported by one of the two, so a read of it cannot be
    // rejected — it degrades to the open half rather than to an error.
    expect(Object.keys(reading.properties.status.properties)).toEqual(["table"]);
  });

  it("stays open when the constrained kind declares no status", () => {
    const reading = refSlotReadingSchema(
      { "x-telo-ref": { kind: "Sql.Table", use: "dependency" } },
      scope({ "Sql.Table": { kind: "Telo.Abstract", metadata: { name: "Table" } } }),
    )!;

    expect(reading.additionalProperties).toBe(true);
    expect(reading.properties).toBeUndefined();
  });

  it("leaves a slot whose constraint resolves to nothing exactly as it was", () => {
    const slot = { "x-telo-ref": { kind: "Nope.Missing", use: "dependency" } };
    expect(refSlotReadingSchema(slot, scope({}))).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("rewrites ref slots nested in a kind's schema and leaves the rest identical", () => {
    const schema = {
      type: "object",
      properties: {
        table: { "x-telo-ref": { kind: "Sql.Table", use: "dependency" } },
        name: { type: "string" },
      },
    };
    const out = withRefSlotsAsReadings(schema, scope({ "Sql.Table": REPORTING })) as any;

    expect(out.properties.status).toBeUndefined();
    expect(out.properties.table.properties.status.properties.rowCount).toEqual({
      type: "integer",
    });
    // Untouched subtrees keep identity, so nothing downstream re-walks a copy.
    expect(out.properties.name).toBe(schema.properties.name);
  });

  it("treats a `kind` key inside a schema as an ordinary property, not a boundary", () => {
    const schema = {
      type: "object",
      properties: {
        step: {
          type: "object",
          kind: "Run.Sequence",
          properties: { table: { "x-telo-ref": { kind: "Sql.Table", use: "dependency" } } },
        },
      },
    };
    const out = withRefSlotsAsReadings(schema, scope({ "Sql.Table": REPORTING })) as any;
    // This is a schema walk: `kind` here is a property NAMED kind, not a nested
    // resource declaration, so there is no boundary and the slot is retyped.
    expect(out.properties.step.properties.table.properties?.status).toBeDefined();
  });
});
