import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPositions } from "../src/browser/listing-engine.js";
import { pageRequest, reloadRequests, valuesRequest, type ListingReads, type ReadPlan, type ReadPosition, type RelatedSource } from "../src/browser/listing-reads.js";

interface Row {
  name: string;
  listing: ListingReads & { paging: string };
  reads: ReadPlan;
  read: ReadPosition;
  event: "open" | "more" | "reload" | "values";
  loaded?: string[];
  answers?: (string | null)[];
  relations?: Record<string, RelatedSource>;
  requests: { path: string; params: [string, string][] }[];
}

/** `ui`'s conformance rows: the exact requests each read of a listing's plan sends. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/listing-reads.json", import.meta.url), "utf8")) as { rows: Row[] };

/** What the renderer sends for a row's event. */
function sent(row: Row) {
  const { basePath, pageSize, filters, bar, sort } = row.listing;
  const listing: ListingReads = { basePath, pageSize, filters, bar, ...(sort !== undefined ? { sort } : {}) };
  switch (row.event) {
    case "open":
      return [pageRequest(listing, row.reads, row.read)];
    case "more":
      return [pageRequest(listing, row.reads, row.read, row.loaded!.at(-1))];
    case "reload":
      return reloadRequests(listing, row.reads, row.read, row.loaded!.length, row.answers!);
    case "values": {
      const request = valuesRequest(listing, row.reads, row.relations ?? {});
      return request ? [request] : [];
    }
  }
}

describe("a listing's read plan", () => {
  it.each(rows)("$name", (row) => {
    expect(sent(row)).toEqual(row.requests);
  });
});

describe("a listing's reads", () => {
  it("are the product of the plan's dimensions: a read per group, per shown period and per tree level", () => {
    const plan: ReadPlan = {
      groups: { property: "status", values: "all", enum: ["open", "done"], labels: [] },
      span: { start: "startsOn", format: "date" },
      parent: "managerId",
    };
    const groups = { values: [{ value: "open", sent: "open" }, { value: "done", sent: "done" }], loading: false, hasMore: false, more: () => {} };
    const period = { from: "2026-10-01", to: "2026-10-31" };
    expect(readPositions(plan, groups, period, ["42"])).toEqual([
      { group: "open", period },
      { group: "open", period, parent: "42" },
      { group: "done", period },
      { group: "done", period, parent: "42" },
    ]);
    // A spanned plan reads nothing until its layout names a period.
    expect(readPositions(plan, groups, undefined, [])).toEqual([]);
    expect(readPositions({}, undefined, undefined, [])).toEqual([{}]);
  });
});
