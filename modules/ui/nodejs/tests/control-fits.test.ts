import { CelEnvironment } from "@telorun/cel";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { controlFits, type Control } from "../src/control-fit.js";
import { isEnterable } from "../src/model-schema.js";

type Row = { name: string; control: Control; property: Record<string, unknown>; operator: string | null; fits: boolean };

const rows: Row[] = JSON.parse(readFileSync(new URL("../../conformance/control-fits.json", import.meta.url), "utf8")).rows;
const docs = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), {
  logLevel: "silent",
  customTags: [{ tag: "!cel", resolve: (text: string) => text }, { tag: "!ref", resolve: (text: string) => text }],
}).map((doc) => doc.toJS());
const body: string = docs.find((doc) => doc.kind === "Telo.Function" && doc.metadata?.name === "controlFits")!.body;
const environment = new CelEnvironment();

describe("which control fits which property", () => {
  it.each(rows)("$name (the controllers' fit)", (row) => {
    expect(controlFits(row.control, row.property, row.operator as never)).toBe(row.fits);
  });

  it.each(rows)("$name (Ui.controlFits)", (row) => {
    expect(environment.evaluate(body, { control: row.control, property: row.property, operator: row.operator })).toBe(row.fits);
  });

  it("a property name enters exactly what an input field's auto control enters", () => {
    for (const { property } of rows) expect(isEnterable(property)).toBe(controlFits("auto", property, null));
  });
});
