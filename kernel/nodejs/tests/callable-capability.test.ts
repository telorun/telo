import { describe, expect, it } from "vitest";
import { createKindDocument } from "./create-kind-document.js";

/** A derived throw union is refused on a callable: a call fails the CEL
 *  evaluation it sits in, so there is no caller frame to catch what it
 *  dispatches. A literal `codes` list stays legal, as on every capability. The
 *  static twin is `THROWS_ON_NON_DISPATCH_CAPABILITY`. That a well-formed callable kind
 *  registers at all is pinned by `tests/check-run-agreement.yaml`, whose
 *  callable fixture boots. */
describe("capability: Telo.Callable", () => {
  it("refuses a derived throw union, which no caller could catch", async () => {
    expect(
      await createKindDocument({
        kind: "Telo.Definition",
        metadata: { name: "Sign" },
        capability: "Telo.Callable",
        throws: { passthrough: true },
      }),
    ).toMatchObject({
      code: "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
      message: expect.stringMatching(/\/throws\/passthrough is not allowed here/),
    });
  });
});
