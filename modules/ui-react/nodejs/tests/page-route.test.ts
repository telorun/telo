import { describe, expect, it } from "vitest";
import { matchPage } from "../src/browser/page-route.js";

const pages = ["/", "/plans/{id}", "/plans/new", "/plans/{id}/diff", "/{section}/new"];

describe("the page an address opens", () => {
  it("fills each variable with one non-empty segment, percent-decoded", () => {
    expect(matchPage(pages, "/plans/p%207")).toEqual({ path: "/plans/{id}", params: { id: "p 7" } });
    expect(matchPage(pages, "/plans/p7/diff")).toEqual({ path: "/plans/{id}/diff", params: { id: "p7" } });
    expect(matchPage(pages, "/")).toEqual({ path: "/", params: {} });
    expect(matchPage(pages, "/plans/")).toBeUndefined();
    expect(matchPage(pages, "/plans/p7/other")).toBeUndefined();
  });

  it("prefers a literal segment to a variable, at the first segment where they differ", () => {
    expect(matchPage(pages, "/plans/new")).toEqual({ path: "/plans/new", params: {} });
    expect(matchPage([...pages].reverse(), "/plans/new")).toEqual({ path: "/plans/new", params: {} });
    expect(matchPage(["/{section}/new", "/plans/{id}"], "/plans/new")).toEqual({ path: "/plans/{id}", params: { id: "new" } });
  });

  it("opens no page through a malformed percent-encoded segment", () => {
    expect(matchPage(pages, "/plans/%E0%A4%A")).toBeUndefined();
    expect(matchPage(pages, "/plans/%ZZ")).toBeUndefined();
  });
});
