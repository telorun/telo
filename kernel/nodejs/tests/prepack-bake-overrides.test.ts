import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const prepackScript = path.join(repoRoot, "scripts", "prepack-bake-overrides.mjs");
const generateRuntimeDepsScript = path.join(repoRoot, "scripts", "generate-runtime-deps.mjs");

/**
 * The prepack hook bakes `overrides` and `pnpm.overrides` into the published
 * package.json so a user installing the kernel directly gets a pinned tree.
 * The hook also re-runs `generate-runtime-deps.mjs` so the runtime metadata
 * mirrors the published manifest.
 */
describe("prepack-bake-overrides", () => {
  it("rejects package.json that still has workspace: specifiers", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-prepack-"));
    try {
      const pkg = {
        name: "@telorun/test-pkg",
        version: "1.0.0",
        dependencies: { "@telorun/sdk": "workspace:*" },
      };
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

      let exitCode = 0;
      let stdout = "";
      try {
        stdout = execFileSync("node", [prepackScript, tmp], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        exitCode = err.status ?? 1;
        stdout = String(err.stderr ?? err.stdout ?? "");
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("workspace:");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes overrides + pnpm.overrides for every direct dep of a rewritten package.json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-prepack-"));
    try {
      const pkg = {
        name: "@telorun/test-pkg",
        version: "1.2.3",
        dependencies: {
          "@telorun/sdk": "^0.7.0",
          "some-lib": "^1.0.0",
        },
      };
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

      execFileSync("node", [prepackScript, tmp], { encoding: "utf8" });

      const written = JSON.parse(await fs.readFile(path.join(tmp, "package.json"), "utf8"));
      expect(written.overrides).toEqual({
        "@telorun/sdk": "$@telorun/sdk",
        "some-lib": "$some-lib",
      });
      expect(written.pnpm.overrides).toEqual({
        "@telorun/sdk": "$@telorun/sdk",
        "some-lib": "$some-lib",
      });

      // The same script chains the runtime-deps regeneration. Confirm a
      // fresh runtime-deps.json was emitted.
      const runtimeDepsPath = path.join(tmp, "dist", "generated", "runtime-deps.json");
      const runtimeDeps = JSON.parse(await fs.readFile(runtimeDepsPath, "utf8"));
      expect(runtimeDeps.names).toBeInstanceOf(Array);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("generate-runtime-deps emits the realm-collapse name list independent of the manifest's deps", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-genrd-"));
    try {
      const pkg = { name: "@telorun/anything", version: "0.0.1", dependencies: {} };
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));
      execFileSync("node", [generateRuntimeDepsScript, tmp], { encoding: "utf8" });

      const out = JSON.parse(
        await fs.readFile(path.join(tmp, "dist", "generated", "runtime-deps.json"), "utf8"),
      );
      // The realm-collapse list is curated in the script, not derived from the
      // package's own deps. A consumer (or future kernel-only doc) can grep
      // for the list there; this test pins the existing entry.
      expect(out.names).toContain("@telorun/sdk");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
