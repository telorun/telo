import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const prepackScript = path.join(repoRoot, "scripts", "prepack-bake-overrides.mjs");

/**
 * The prepack hook bakes `overrides` and `pnpm.overrides` into the published
 * package.json so a user installing the kernel directly gets a pinned tree
 * for its `dependencies`. `peerDependencies` (notably `@telorun/sdk`) are
 * intentionally NOT baked — peer deps express a single-instance contract the
 * consumer must satisfy, and an override on that name would defeat the point.
 */
describe("prepack-bake-overrides", () => {
  it("writes overrides + pnpm.overrides for every direct dep", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-prepack-"));
    try {
      const pkg = {
        name: "@telorun/test-pkg",
        version: "1.2.3",
        dependencies: {
          "@telorun/templating": "^0.7.0",
          "some-lib": "^1.0.0",
        },
        peerDependencies: {
          // Peer deps must NOT receive an override — that would force the
          // consumer's resolution to a baked value and defeat the
          // single-instance contract peer deps exist to express.
          "@telorun/sdk": "workspace:*",
        },
      };
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

      execFileSync("node", [prepackScript, tmp], { encoding: "utf8" });

      const written = JSON.parse(await fs.readFile(path.join(tmp, "package.json"), "utf8"));
      expect(written.overrides).toEqual({
        "@telorun/templating": "$@telorun/templating",
        "some-lib": "$some-lib",
      });
      expect(written.pnpm.overrides).toEqual({
        "@telorun/templating": "$@telorun/templating",
        "some-lib": "$some-lib",
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
