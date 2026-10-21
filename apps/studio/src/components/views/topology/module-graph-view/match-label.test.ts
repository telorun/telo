import { describe, expect, it } from "vitest";
import { matchLabel } from "./match-label";

describe("a row's match label", () => {
  it("shows a list, a tagged value and a literal mapping as written", () => {
    expect(
      matchLabel({
        path: "/",
        hostnames: [
          { tag: "ref", source: "site" },
          { tag: "ref", source: "Shop.admin" },
        ],
        method: { tag: "cel", source: "variables.method" },
        filter: { map: { tag: "cel", source: "1+1" } },
      }),
    ).toBe("/ [!ref site, !ref Shop.admin] !cel variables.method {tag: cel, source: 1+1}");
  });
});
