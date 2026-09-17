import { describe, expect, it } from "vitest";
import { validateResourceDefinition } from "../src/manifest-schemas.js";

/** A throw union is refused on a callable: a call fails the CEL evaluation it
 *  sits in, so there is no caller frame to catch a declared code. The static twin
 *  is `THROWS_ON_NON_DISPATCH_CAPABILITY`. That a well-formed callable kind
 *  registers at all is pinned by `tests/check-run-agreement.yaml`, whose
 *  callable fixture boots. */
describe("capability: Telo.Callable", () => {
  it("refuses a throw union, which no caller could catch", () => {
    expect(
      validateResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Sign" },
        capability: "Telo.Callable",
        throws: { codes: { ERR_BAD_KEY: { description: "The key is malformed." } } },
      }),
    ).toBe(false);
  });
});
