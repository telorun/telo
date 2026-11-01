import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  pageRequest,
  reloadRequests,
  valuesRequest,
  type CollectionRequest,
  type ListingReads,
  type ReadPosition,
  type RelatedSource,
} from "../src/listing-requests.js";
import type { ReadPlan } from "../src/read-plan.js";

interface Row {
  name: string;
  listing: ListingReads;
  reads: ReadPlan;
  read: ReadPosition;
  event: "open" | "more" | "reload" | "values";
  loaded?: string[];
  answers?: (string | null)[];
  relations?: Record<string, RelatedSource>;
  requests: CollectionRequest[];
}

const rows: Row[] = JSON.parse(readFileSync(new URL("../../conformance/listing-reads.json", import.meta.url), "utf8")).rows;

function requested(row: Row): CollectionRequest[] {
  switch (row.event) {
    case "open":
      return [pageRequest(row.listing, row.reads, row.read)];
    case "more":
      return [pageRequest(row.listing, row.reads, row.read, row.loaded!.at(-1))];
    case "reload":
      return reloadRequests(row.listing, row.reads, row.read, row.loaded!.length, row.answers ?? []);
    case "values": {
      const request = valuesRequest(row.listing, row.reads, row.relations ?? {});
      return request ? [request] : [];
    }
  }
}

describe("the requests a listing's read plan sends", () => {
  it.each(rows)("$name", (row) => {
    expect(requested(row)).toEqual(row.requests);
  });
});
