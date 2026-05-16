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
  it("rewrites workspace: specifiers using sibling versions from the monorepo", async () => {
    // pnpm normally rewrites `workspace:*` before pack; we observed that step
    // silently missing in CI. The script now does the rewrite itself by
    // scanning the workspace root for a sibling package.json that names the
    // dep.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-prepack-"));
    try {
      const workspaceRoot = path.join(tmp, "workspace");
      await fs.mkdir(path.join(workspaceRoot, "sibling-star"), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, "sibling-caret"), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, "sibling-tilde"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceRoot, "sibling-star", "package.json"),
        JSON.stringify({ name: "@telorun/sibling-star", version: "9.9.9" }, null, 2),
      );
      await fs.writeFile(
        path.join(workspaceRoot, "sibling-caret", "package.json"),
        JSON.stringify({ name: "@telorun/sibling-caret", version: "1.2.3" }, null, 2),
      );
      await fs.writeFile(
        path.join(workspaceRoot, "sibling-tilde", "package.json"),
        JSON.stringify({ name: "@telorun/sibling-tilde", version: "4.5.6" }, null, 2),
      );

      const consumer = path.join(tmp, "consumer");
      await fs.mkdir(consumer, { recursive: true });
      const pkg = {
        name: "@telorun/test-pkg",
        version: "1.0.0",
        dependencies: {
          "@telorun/sibling-star": "workspace:*",
          "@telorun/sibling-caret": "workspace:^",
          "@telorun/sibling-tilde": "workspace:~",
          "some-lib": "^1.0.0",
        },
      };
      await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify(pkg, null, 2));

      execFileSync("node", [prepackScript, consumer], {
        encoding: "utf8",
        env: { ...process.env, TELO_PREPACK_WORKSPACE_ROOT: workspaceRoot },
      });

      const written = JSON.parse(await fs.readFile(path.join(consumer, "package.json"), "utf8"));
      expect(written.dependencies).toEqual({
        "@telorun/sibling-star": "9.9.9",
        "@telorun/sibling-caret": "^1.2.3",
        "@telorun/sibling-tilde": "~4.5.6",
        "some-lib": "^1.0.0",
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("errors when a workspace: specifier cannot be resolved from the monorepo", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-prepack-"));
    try {
      const workspaceRoot = path.join(tmp, "workspace");
      await fs.mkdir(workspaceRoot, { recursive: true });
      const consumer = path.join(tmp, "consumer");
      await fs.mkdir(consumer, { recursive: true });
      const pkg = {
        name: "@telorun/test-pkg",
        version: "1.0.0",
        dependencies: { "@telorun/nonexistent": "workspace:*" },
      };
      await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify(pkg, null, 2));

      let exitCode = 0;
      let stderr = "";
      try {
        execFileSync("node", [prepackScript, consumer], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TELO_PREPACK_WORKSPACE_ROOT: workspaceRoot },
        });
      } catch (err: any) {
        exitCode = err.status ?? 1;
        stderr = String(err.stderr ?? err.stdout ?? "");
      }
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("@telorun/nonexistent");
      expect(stderr).toContain("workspace:");
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
