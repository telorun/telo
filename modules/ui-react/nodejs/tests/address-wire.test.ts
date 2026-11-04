import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AddressUnresolvedError, expandAddress, isCurrentAddress, refreshCovers, resolveRefresh, type AddressWire } from "../src/browser/address-wire.js";
import type { Binding } from "../src/browser/bindings.js";

interface Row {
  name: string;
  address: AddressWire;
  roots?: Record<string, unknown>;
  url?: string;
  unresolved?: string;
}

/** `ui`'s conformance rows: what each address resolves to, or the parameter it fails on. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/addresses.json", import.meta.url), "utf8")) as { rows: Row[] };

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

interface CurrentRow {
  name: string;
  address: string;
  location: { path: string; search: string };
  current: boolean;
}

/** `ui`'s conformance rows: whether a link to an address is the current location. */
const current = JSON.parse(readFileSync(new URL("../../../ui/conformance/current-location.json", import.meta.url), "utf8")) as { rows: CurrentRow[] };

describe("current-location.json", () => {
  it.each(current.rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    expect(isCurrentAddress(row.address, row.location)).toBe(row.current);
  });
});

interface RefreshRow {
  name: string;
  address: AddressWire;
  roots?: Record<string, unknown>;
  path: string;
  match: boolean;
}

/** `ui`'s conformance rows: which readers a refresh entry reads again. */
const refreshRows = (JSON.parse(readFileSync(new URL("../../../ui/conformance/refreshes.json", import.meta.url), "utf8")) as { rows: RefreshRow[] }).rows;

describe("refreshes.json", () => {
  it.each(refreshRows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const refresh = resolveRefresh(row.address, row.roots ?? {}, "test");
    expect(refresh).toBeDefined();
    expect(refreshCovers(refresh!, row.path)).toBe(row.match);
  });
});
