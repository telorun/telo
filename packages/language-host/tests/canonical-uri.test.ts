import { expect, it } from "vitest";
import { canonicalUri } from "../src/canonical-uri.js";

it("gives every spelling of one file location one canonical form", () => {
  const canonical = "file:///c%3A/Users/u/My%20Project%20%28copy%29/app/telo.yaml";
  for (const spelling of [
    "file:///C:/Users/u/My%20Project%20(copy)/app/telo.yaml",
    "file:///c%3a/Users/u/My%20Project%20%28copy%29/app/telo.yaml",
    "file://localhost/C%3A/Users/u/My Project (copy)/app/telo.yaml",
    "file:///C:/Users/u/My%20Project%20(copy)/app/telo.yaml?query#fragment",
  ]) {
    expect(canonicalUri(spelling), spelling).toBe(canonical);
  }
  expect(canonicalUri("file:///home/u/%C5%BC%C3%B3%C5%82w/telo.yaml")).toBe(canonicalUri("file:///home/u/żółw/telo.yaml"));
  expect(canonicalUri("oci://ghcr.io/telorun/sql@1.0.0")).toBe("oci://ghcr.io/telorun/sql@1.0.0");
});
