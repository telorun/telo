import { describe, expect, it } from "vitest";
import { componentLookupInput } from "../src/bill-of-materials/audit-components.js";

describe("componentLookupInput", () => {
  it("takes the version out of the purl's head, before a subpath or qualifiers that hold a slash", () => {
    expect(
      componentLookupInput({
        type: "library",
        "bom-ref": "x",
        name: "genproto",
        version: "0.0.1",
        purl: "pkg:golang/google.golang.org/genproto@0.0.1#googleapis/api/annotations",
      }),
    ).toEqual({ purl: "pkg:golang/google.golang.org/genproto#googleapis/api/annotations", version: "0.0.1" });
    expect(
      componentLookupInput({
        type: "library",
        "bom-ref": "y",
        name: "commons-lang3",
        version: "3.1",
        purl: "pkg:maven/org.apache.commons/commons-lang3@3.1?type=jar&repository_url=https://repo/x",
      }),
    ).toEqual({ purl: "pkg:maven/org.apache.commons/commons-lang3?type=jar&repository_url=https://repo/x", version: "3.1" });
  });

  it("leaves a plain versioned purl and a purl-less component alone", () => {
    expect(componentLookupInput({ type: "library", "bom-ref": "z", name: "k", version: "0.28.15", purl: "pkg:npm/kysely@0.28.15" })).toEqual({
      purl: "pkg:npm/kysely",
      version: "0.28.15",
    });
    expect(componentLookupInput({ type: "library", "bom-ref": "m", name: "M", version: "1" })).toBeUndefined();
  });
});
