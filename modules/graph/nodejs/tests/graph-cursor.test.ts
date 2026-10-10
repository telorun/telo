import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/graph-cursor.js";
import { stampRefIdentity } from "@telorun/sdk";
import { boundName, Listing } from "../src/operation-binding.js";

const refused = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const envelope = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("the cursor envelope", () => {
  const binding = { operation: "FindNodes", type: "person" };

  it("hands the backend's tail back verbatim", () => {
    const tail = '[["s","p00042"]] é "';
    expect(decodeCursor("op", binding, encodeCursor(binding, tail))).toBe(tail);
  });

  it("refuses text that is no envelope", () => {
    expect(refused(() => decodeCursor("op", binding, "not a cursor"))).toBe("GRAPH_CURSOR_INVALID");
    expect(refused(() => decodeCursor("op", binding, envelope({ v: 1, t: "tail" })))).toBe(
      "GRAPH_CURSOR_INVALID",
    );
  });

  it("refuses an envelope version it does not read, whatever the envelope binds", () => {
    const current = JSON.parse(
      Buffer.from(encodeCursor(binding, "tail"), "base64url").toString("utf8"),
    );
    expect(refused(() => decodeCursor("op", binding, envelope({ ...current, v: 2 })))).toBe(
      "GRAPH_CURSOR_INVALID",
    );
  });

  it("refuses a cursor issued for another binding", () => {
    const cursor = encodeCursor(binding, "tail");
    expect(refused(() => decodeCursor("op", { ...binding, type: "team" }, cursor))).toBe(
      "GRAPH_CURSOR_INVALID",
    );
  });
});

describe("a listing", () => {
  const subject = { operation: "FindNodes", type: "person" };
  const issue = (where: unknown) =>
    new Listing("op", { where }, subject).result({
      status: "found",
      value: { items: [], next: "tail" },
    }).next;

  it("binds one filter one way: key order, empty operators and integer form aside", () => {
    const cursor = issue({ eq: { age: 7, name: "Ada" }, lt: {} });
    const resumed = new Listing(
      "op",
      { cursor, where: { eq: { name: "Ada", age: 7n } } },
      subject,
    );
    expect(resumed.page.after).toBe("tail");
  });

  it("turns a tail its store refused into GRAPH_CURSOR_INVALID", () => {
    const listing = new Listing("op", { cursor: issue({}) }, subject);
    expect(refused(() => listing.result({ status: "cursorInvalid" }))).toBe("GRAPH_CURSOR_INVALID");
  });
});

describe("the store in a binding", () => {
  const store = (name: string, module: string) => {
    const instance = {};
    stampRefIdentity(instance, "GraphSql.Store", name, { module });
    return instance;
  };
  const listing = (instance: object, cursor?: string) =>
    new Listing(
      "op",
      { cursor },
      { operation: "FindNodes", store: boundName(instance, "op", "store"), type: "person" },
    );
  const issued = (instance: object) =>
    listing(instance).result({ status: "found", value: { items: [], next: "tail" } }).next;

  it("refuses a cursor issued through a store of another name, either way", () => {
    const a = store("tenantA", "file:///srv/app/telo.yaml");
    const b = store("tenantB", "file:///srv/app/telo.yaml");
    expect(refused(() => listing(b, issued(a)))).toBe("GRAPH_CURSOR_INVALID");
    expect(refused(() => listing(a, issued(b)))).toBe("GRAPH_CURSOR_INVALID");
  });

  it("accepts a cursor from the same store declared at another location", () => {
    const here = store("kb", "file:///srv/replica-1/app/telo.yaml");
    const there = store("kb", "file:///mnt/replica-2/telo.yaml");
    expect(listing(there, issued(here)).page.after).toBe("tail");
    expect(listing(here, issued(there)).page.after).toBe("tail");
  });

  it("refuses to bind an instance that was declared under no name", () => {
    expect(() => boundName({}, "op", "store")).toThrow(/'store' holds an instance with no declared name/);
  });
});
