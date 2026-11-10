// npm's `rc` pointer follows a final or patch, and only forward.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planRcMoves } from "../release-dist-tags.mjs";

const tags = (table) => (name) => table[name] ?? {};

describe("rc dist-tag moves", () => {
  it("moves rc from the candidate to the final", () => {
    const moves = planRcMoves({
      published: [{ name: "@telorun/cli", version: "0.85.0" }],
      tagsOf: tags({ "@telorun/cli": { latest: "0.85.0", rc: "0.85.0-rc.2" } }),
    });
    assert.deepEqual(moves, [{ name: "@telorun/cli", version: "0.85.0", from: "0.85.0-rc.2" }]);
  });

  it("sets rc for a package that has none, and skips a prerelease", () => {
    const moves = planRcMoves({
      published: [
        { name: "a", version: "1.2.0" },
        { name: "b", version: "1.0.0-beta.1" },
      ],
      tagsOf: tags({}),
    });
    assert.deepEqual(moves, [{ name: "a", version: "1.2.0", from: undefined }]);
  });

  it("never moves a pointer that already holds a higher or equal version", () => {
    const moves = planRcMoves({
      published: [
        { name: "old", version: "0.85.0" },
        { name: "same", version: "0.85.1" },
      ],
      tagsOf: tags({ old: { rc: "0.86.0-rc.1" }, same: { rc: "0.85.1" } }),
    });
    assert.deepEqual(moves, []);
  });
});
