import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

type Schema = Record<string, any>;

const docs: Schema[] = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), {
  logLevel: "silent",
}).map((doc) => doc.toJS());
const match: Schema = docs.find((doc) => doc.kind === "Telo.JsonSchema" && doc.metadata?.name === "Match")!.schema;
const rows: { name: string; matches: Schema; holds: boolean }[] = JSON.parse(
  readFileSync(new URL("../../conformance/match.json", import.meta.url), "utf8"),
).rows;

const keywords = Object.keys(match.properties);
/** Keywords whose value is itself a schema of the profile, or a list or map of them. */
const NESTED: Record<string, "schema" | "list" | "map"> = {
  not: "schema",
  items: "schema",
  allOf: "list",
  anyOf: "list",
  properties: "map",
};

/** Every keyword a schema uses, at any depth, that the profile does not declare. */
function outside(schema: Schema, at: string): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!keywords.includes(key)) found.push(`${at}.${key}`);
    else if (NESTED[key] === "schema") found.push(...outside(value, `${at}.${key}`));
    else if (NESTED[key] === "list") value.forEach((item: Schema, i: number) => found.push(...outside(item, `${at}.${key}[${i}]`)));
    else if (NESTED[key] === "map") for (const [name, item] of Object.entries(value)) found.push(...outside(item as Schema, `${at}.${key}.${name}`));
  }
  return found;
}

/** Every keyword a schema uses, at any depth. */
function used(schema: Schema): string[] {
  return Object.entries(schema).flatMap(([key, value]) =>
    NESTED[key] === "schema"
      ? [key, ...used(value)]
      : NESTED[key] === "list"
        ? [key, ...value.flatMap(used)]
        : NESTED[key] === "map"
          ? [key, ...Object.values(value as Record<string, Schema>).flatMap(used)]
          : [key],
  );
}

describe("the interpreted profile's conformance rows", () => {
  it("hold every schema to the profile's keywords", () => {
    expect(rows.flatMap((row) => outside(row.matches, row.name))).toEqual([]);
  });

  it("exercise every keyword of the profile", () => {
    const exercised = new Set(rows.flatMap((row) => used(row.matches)));
    expect(keywords.filter((keyword) => !exercised.has(keyword))).toEqual([]);
  });
});
