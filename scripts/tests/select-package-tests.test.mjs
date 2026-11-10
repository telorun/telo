// Which diffs reach the macOS / Windows core job. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectCoreTests } from "../select-package-tests.mjs";

const pkg = (name, dir, dependsOn = []) => ({ name, dir, scripts: {}, dependsOn });
const packages = [
  pkg("@telorun/analyzer", "analyzer/nodejs"),
  pkg("@telorun/kernel", "kernel/nodejs", ["@telorun/analyzer"]),
  pkg("@telorun/cli", "cli/nodejs", ["@telorun/kernel"]),
  pkg("@telorun/studio", "apps/studio"),
  pkg("@telorun/runner-core", "packages/runner-core", ["@telorun/cli"]),
];

describe("core test selection", () => {
  it("runs the core packages for a kernel change", () => {
    const core = selectCoreTests(["kernel/nodejs/src/kernel.ts"], packages);
    assert.equal(core.mode, "full");
    assert.deepEqual(core.testArgs, [
      "--filter", "@telorun/analyzer", "--filter", "@telorun/kernel", "--filter", "@telorun/cli",
    ]);
  });

  it("runs nothing for a docs change", () => {
    assert.equal(selectCoreTests(["docs/guides/logging.md", ".changeset/a.md"], packages).mode, "none");
  });

  it("runs nothing for a package outside the core and not under it", () => {
    assert.equal(selectCoreTests(["apps/studio/src/app.tsx"], packages).mode, "none");
  });

  it("runs the core packages when a changed package is one they depend on", () => {
    const withDep = [...packages, pkg("@telorun/glob", "packages/glob")];
    withDep[0].dependsOn.push("@telorun/glob");
    assert.equal(selectCoreTests(["packages/glob/src/index.ts"], withDep).mode, "full");
  });

  it("fails open on a file no package owns", () => {
    assert.equal(selectCoreTests(["scripts/something.mjs"], packages).mode, "full");
  });
});
