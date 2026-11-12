// Which packages a GitHub Release names when the changesets action reports a partial set.
// Run: node --test scripts/tests/release-package-set.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidatePackages } from "../release-package-set.mjs";

const pkg = (name, version = "0.135.0") => ({ name, version });
const names = (list) => list.map((entry) => entry.name);

describe("candidatePackages", () => {
  const recovered = [pkg("@telorun/cli"), pkg("@telorun/kernel"), pkg("@telorun/sdk")];

  it("adds the release commit's bumps to a final's partial set, so the CLI names the cycle", () => {
    const result = candidatePackages({ published: [pkg("@telorun/kernel")], recovered, channel: "final" });
    assert.deepEqual(names(result), ["@telorun/kernel", "@telorun/cli", "@telorun/sdk"]);
  });

  it("does the same for a patch", () => {
    const result = candidatePackages({ published: [pkg("@telorun/kernel", "0.135.1")], recovered, channel: "patch" });
    assert.deepEqual(names(result), ["@telorun/kernel", "@telorun/cli", "@telorun/sdk"]);
    assert.equal(result[0].version, "0.135.1");
  });

  it("recovers the whole set when the action reported nothing, whatever the channel", () => {
    for (const channel of ["final", "patch", "candidate", "none", undefined]) {
      assert.deepEqual(candidatePackages({ published: [], recovered, channel }), recovered);
    }
  });

  it("leaves a candidate's and a packages-only release's reported set alone", () => {
    for (const channel of ["candidate", "none", undefined]) {
      const published = [pkg("@telorun/kernel")];
      assert.deepEqual(candidatePackages({ published, recovered, channel }), published);
    }
  });

  it("names a package once when the action and the commit both have it", () => {
    const result = candidatePackages({ published: recovered, recovered, channel: "final" });
    assert.deepEqual(names(result), names(recovered));
  });
});
