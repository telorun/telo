import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { npmEvidence } from "../../src/node/adapters/npm-evidence.js";
import type { EvidenceAdapter } from "../../src/node/evidence.js";
import { teloRelease } from "../../src/node/bin.js";
import type { ReleaseOutput } from "../../src/node/host.js";
import { SHIPPED_EVIDENCE } from "../../src/node/index.js";
import { commit, git, has, host, read, run, tempRepo, write } from "./fixture.js";

const npm = has("npm");

/** An npm workspace of two packages, `b` naming `a` by a plain range. */
function npmRepo(): string {
  return tempRepo({
    "telo-workspace.yaml": "release:\n  units:\n    - { path: packages/*, ecosystem: npm }\n",
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2) + "\n",
    "package-lock.json": "{}\n",
    "packages/a/package.json": JSON.stringify({ name: "@fx/a", version: "1.0.0" }, null, 2) + "\n",
    "packages/a/index.js": "export const a = 1;\n",
    "packages/b/package.json":
      JSON.stringify({ name: "@fx/b", version: "1.0.0", dependencies: { "@fx/a": "^1.0.0" } }, null, 2) + "\n",
    "packages/b/index.js": "export const b = 2;\n",
  });
}

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe.skipIf(!npm)("telo-release over a repo of package.json files", () => {
  it("adds, plans, orders, checks, applies a candidate and a final, and tags", async () => {
    const root = npmRepo();
    roots.push(root);
    const { host: h, recorded } = host();

    const added = await run(h, recorded, root, ["add", "--unit", "packages/a", "--kind", "Added", "--body", "A new export."]);
    expect(added.payload).toMatchObject({ ok: true, units: ["packages/a"] });
    expect(await run(h, recorded, root, ["add", "--unit", "packages", "--body", "x"])).toMatchObject({ exitCode: 1 });

    const status = await run(h, recorded, root, ["status", "--base", "HEAD"]);
    expect((status.payload.units as { key: string; from: string; to: string; reasons: string[] }[]).map((u) => [u.key, u.from, u.to, u.reasons])).toEqual([
      ["packages/a", "1.0.0", "1.1.0", ["declared"]],
      ["packages/b", "1.0.0", "1.1.0", ["imports packages/a"]],
    ]);
    expect(recorded.stdout.some((line) => line.includes("packages/b") && line.includes("imports packages/a"))).toBe(true);

    const order = await run(h, recorded, root, ["order"]);
    expect(order.payload.order).toEqual([
      { key: "packages/a", ecosystem: "npm", path: "packages/a", version: "1.0.0", imports: [] },
      { key: "packages/b", ecosystem: "npm", path: "packages/b", version: "1.0.0", imports: ["packages/a"] },
    ]);
    expect((await run(h, recorded, root, ["check", "--base", "HEAD"])).exitCode).toBe(0);

    const candidate = await run(h, recorded, root, ["apply", "--candidate", "--base", "HEAD", "--date", "2026-01-02"]);
    expect(candidate.exitCode).toBe(0);
    expect(JSON.parse(read(root, "packages/a/package.json")).version).toBe("1.1.0-rc.1");
    expect(JSON.parse(read(root, "packages/b/package.json")).dependencies["@fx/a"]).toBe("^1.1.0-rc.1");
    expect(fs.readdirSync(path.join(root, ".changes/pending"))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "packages/a/CHANGELOG.md"))).toBe(false);
    commit(root, "candidate");
    const candidateTags = await run(h, recorded, root, ["tag"]);
    expect(candidateTags.payload.tags).toEqual(["packages/a@1.1.0-rc.1", "packages/b@1.1.0-rc.1"]);

    const final = await run(h, recorded, root, ["apply", "--base", "HEAD", "--date", "2026-01-03"]);
    expect(final.exitCode).toBe(0);
    expect(final.payload.written).toEqual(
      expect.arrayContaining(["packages/a/package.json", "packages/a/CHANGELOG.md", "packages/b/package.json", ".changes/ledger.yaml"]),
    );
    expect(JSON.parse(read(root, "packages/a/package.json")).version).toBe("1.1.0");
    expect(read(root, "packages/a/CHANGELOG.md")).toContain("A new export.");
    expect(fs.readdirSync(path.join(root, ".changes/pending"))).toEqual([]);
    expect(read(root, ".changes/ledger.yaml")).not.toContain("candidate:");
    expect((await run(h, recorded, root, ["tag"])).exitCode).toBe(1);
    commit(root, "final");
    const tags = await run(h, recorded, root, ["tag"]);
    expect(tags.payload.tags).toEqual(["packages/a@1.1.0", "packages/b@1.1.0"]);
    expect(git(root, "tag", "--points-at", "HEAD").split("\n").filter(Boolean).sort()).toEqual(["packages/a@1.1.0", "packages/b@1.1.0"]);

    // The ledger now matches; a payload-only change ships as an unattributed patch.
    expect((await run(h, recorded, root, ["status", "--base", "HEAD"])).payload.units).toEqual([]);
    write(root, { "packages/a/index.js": "export const a = 3;\n" });
    const drifted = await run(h, recorded, root, ["status", "--base", "HEAD"]);
    expect((drifted.payload.units as { key: string; reasons: string[] }[]).map((u) => [u.key, u.reasons])).toEqual([
      ["packages/a", ["payload changed, unattributed"]],
      ["packages/b", ["imports packages/a"]],
    ]);
  }, 120_000);

  it("undoes an apply whose reading after the stamp fails, recording no ledger", async () => {
    const root = npmRepo();
    roots.push(root);
    // The npm layer of `@fx/a` cannot be read once it carries the planned version.
    const failing: EvidenceAdapter = {
      ecosystem: "npm",
      async open(workspace, options) {
        const session = await npmEvidence.open(workspace, options);
        return {
          ...session,
          collect: async (ref) => {
            if (JSON.parse(read(root, `${ref.anchor.dir}/package.json`)).version === "1.1.0") throw new Error("pack failed");
            return session.collect(ref);
          },
        };
      },
    };
    const { host: h, recorded } = host({ evidence: [failing, ...SHIPPED_EVIDENCE.filter((e) => e.ecosystem !== "npm")] });
    await run(h, recorded, root, ["add", "--unit", "packages/a", "--kind", "Added", "--body", "A new export."]);
    commit(root, "fragment");

    const applied = await run(h, recorded, root, ["apply", "--base", "HEAD", "--date", "2026-01-02"]);
    expect(applied.exitCode).toBe(1);
    expect(recorded.stderr.join("\n")).toContain("The apply was undone");
    expect(git(root, "status", "--porcelain")).toBe("");
  }, 120_000);

  it("refuses a hand-moved version location with UNIT_VERSION_MISMATCH", async () => {
    const root = tempRepo({
      "telo-workspace.yaml":
        "release:\n  units:\n    - path: tool\n      ecosystem: npm\n      versionFiles: [{ path: meta.json, pointer: /version }]\n",
      "package-lock.json": "{}\n",
      "tool/package.json": JSON.stringify({ name: "tool", version: "1.0.0" }) + "\n",
      "tool/meta.json": '{ "version": "1.0.1" }\n',
    });
    roots.push(root);
    const { host: h, recorded } = host();
    const check = await run(h, recorded, root, ["check", "--base", "HEAD"]);
    expect(check.exitCode).toBe(1);
    expect((check.payload.diagnostics as { code: string }[]).map((d) => d.code)).toContain("UNIT_VERSION_MISMATCH");
  }, 60_000);

  it("plans a dependent through another unit's version location inside its payload", async () => {
    const root = tempRepo({
      "telo-workspace.yaml": [
        "release:",
        "  units:",
        "    - { path: lib, ecosystem: npm }",
        "    - path: img",
        "      version: VERSION",
        "      payload: { command: printf 'VERSION\\n../lib/package.json\\n' }",
      ].join("\n"),
      "package-lock.json": "{}\n",
      "lib/package.json": JSON.stringify({ name: "lib", version: "1.0.0" }) + "\n",
      "img/VERSION": "0.1.0\n",
    });
    roots.push(root);
    const { host: h, recorded } = host();
    await run(h, recorded, root, ["add", "--unit", "lib", "--body", "Fix."]);
    const status = await run(h, recorded, root, ["status", "--base", "HEAD"]);
    expect((status.payload.units as { key: string; reasons: string[] }[]).map((u) => [u.key, u.reasons])).toEqual([
      ["lib", ["declared"]],
      ["img", ["holds the version of lib"]],
    ]);
  }, 60_000);
});

describe("the telo-release command line", () => {
  it("refuses a usage error with exit status 2 before any command runs", async () => {
    const root = tempRepo({
      "telo-workspace.yaml": "release:\n  units:\n    - { path: app, version: VERSION, payload: [VERSION] }\n",
      "app/VERSION": "1.0.0\n",
      ".changes/pending/fixed-a-fix.yaml": "units: { app: Fixed }\nbody: A fix.\n",
    });
    roots.push(root);
    const stderr: string[] = [];
    const plain = { ok: (t: string) => t, dim: (t: string) => t, error: (t: string) => t, warn: (t: string) => t };
    const output: ReleaseOutput = {
      line: () => {},
      errLine: (text) => stderr.push(text),
      emit: () => {},
      progress: () => {},
      style: plain,
      errStyle: plain,
    };
    const cwd = process.cwd();
    process.chdir(root);
    try {
      for (const args of [["apply", "--output", "yaml", "--base", "HEAD"], ["publish"]]) {
        process.exitCode = 0;
        stderr.length = 0;
        await teloRelease(args, output);
        expect([args, process.exitCode, stderr.length]).toEqual([args, 2, 1]);
      }
    } finally {
      process.exitCode = 0;
      process.chdir(cwd);
    }
    expect(git(root, "status", "--porcelain")).toBe("");
  }, 60_000);
});
