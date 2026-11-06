import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AddressUnresolvedError, expandAddress, type AddressSpec } from "../src/address-expansion.js";
import type { Binding } from "../src/row-binding.js";

interface Row {
  name: string;
  address: AddressSpec;
  roots?: Record<string, unknown>;
  url?: string;
  unresolved?: string;
}

const { rows } = JSON.parse(readFileSync(new URL("../../conformance/addresses.json", import.meta.url), "utf8")) as { rows: Row[] };

const reading = (roots: Record<string, unknown>) => (binding: Binding) => {
  if ("value" in binding) return binding.value;
  let at: unknown = roots[binding.root];
  for (const key of binding.path) at = (at as Record<string, unknown> | undefined)?.[key];
  return at;
};

describe("addresses.json", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const read = reading(row.roots ?? {});
    if (row.unresolved === undefined) {
      expect(expandAddress(row.address, read)).toBe(row.url);
      return;
    }
    try {
      expandAddress(row.address, read);
    } catch (error) {
      expect(error).toBeInstanceOf(AddressUnresolvedError);
      expect((error as AddressUnresolvedError).code).toBe("ERR_UI_ADDRESS_UNRESOLVED");
      expect((error as AddressUnresolvedError).data.parameter).toBe(row.unresolved);
      return;
    }
    throw new Error("the address resolved");
  });
});
