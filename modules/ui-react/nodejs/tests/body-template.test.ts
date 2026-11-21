import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBody, type BodyTemplate } from "../src/browser/body-template.js";

/** `ui`'s rows: the body a query's template resolves to from the roots it reads. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/template-bindings.json", import.meta.url), "utf8")) as {
  rows: { name: string; template: BodyTemplate; roots: Record<string, unknown>; body?: unknown; omitted?: true }[];
};

describe("template-bindings.json", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s", (name, row) => {
    expect(resolveBody(row.template, row.roots)).toEqual(row.omitted ? { present: false } : { present: true, value: row.body });
  });
});
