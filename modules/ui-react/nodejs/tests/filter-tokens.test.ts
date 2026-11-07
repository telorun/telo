import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterKey, type Values } from "../src/browser/filter-state.js";
import { commitToken, readToken, type TokenField, type TokenReading } from "../src/browser/filter-tokens.js";

interface Row {
  name: string;
  fields?: Partial<TokenField>[];
  typed: string;
  holding?: Values;
  result: Record<string, unknown>;
  after?: Values;
}

const file = JSON.parse(readFileSync(new URL("../../../ui/conformance/filter-tokens.json", import.meta.url), "utf8")) as { fields: Partial<TokenField>[]; rows: Row[] };
const barOf = (fields: Partial<TokenField>[]): TokenField[] => fields.map((field) => ({ labels: [], relation: false, ...field }) as TokenField);

/** A reading as the rows state it: the filter by its key. */
const stated = (reading: TokenReading, fields: TokenField[]) => {
  const { field, ...rest } = reading as TokenReading & { field?: number };
  return field === undefined ? rest : { ...rest, field: filterKey(fields[field]) };
};

describe("the typed-token conformance rows", () => {
  for (const row of file.rows) {
    it(row.name, () => {
      const fields = barOf(row.fields ?? file.fields);
      const reading = readToken(row.typed, fields);
      expect(stated(reading, fields)).toEqual(row.result);
      if (row.after !== undefined) {
        if (reading.kind !== "token") throw new Error("a row with `after` must read as a token");
        expect(commitToken(row.holding ?? {}, fields[reading.field], reading.values)).toEqual(row.after);
      }
    });
  }
});
