import * as fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { loadReleaseWorkspace } from "../../src/node/workspace.js";
import { npmEvidence } from "../../src/node/adapters/npm-evidence.js";
import { EMPTY_LEDGER, SHIPPED_ADAPTERS } from "../../src/index.js";
import { has, read, tempRepo, write } from "./fixture.js";
import { readTarGz } from "../../src/node/tar.js";

/** Each manager's fixture: its lockfile or `packageManager`, and how `app`
 *  names its sibling. */
const MANAGERS = [
  { name: "npm", files: { "package-lock.json": "{}\n" }, range: "^1.0.0", workspaces: true },
  {
    name: "pnpm",
    files: { "pnpm-workspace.yaml": "packages: [packages/*]\n" },
    range: "workspace:^",
    workspaces: false,
    install: ["pnpm", ["install", "--offline"]],
  },
  { name: "yarn-classic", files: { "yarn.lock": "# yarn lockfile v1\n" }, range: "^1.0.0", workspaces: true },
  {
    name: "yarn-berry",
    files: { ".yarnrc.yml": "nodeLinker: node-modules\n" },
    range: "workspace:^",
    workspaces: true,
    install: ["yarn", ["install"]],
  },
  { name: "bun", files: {}, range: "workspace:^", workspaces: true, install: ["bun", ["install"]] },
] as const satisfies readonly { name: string; install?: readonly [string, readonly string[]] }[];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function available(manager: (typeof MANAGERS)[number]["name"], cwd: string): string | undefined {
  switch (manager) {
    case "npm":
      return has("npm") ? undefined : "npm is not installed";
    case "pnpm":
      return has("pnpm") ? undefined : "pnpm is not installed";
    case "yarn-classic":
      return has("yarn", ["--version"], cwd)?.startsWith("1.") ? undefined : "yarn classic (1.x) is not on PATH";
    case "yarn-berry": {
      const version = has("yarn", ["--version"], cwd);
      return version && !version.startsWith("1.") ? undefined : `yarn on PATH is ${version ?? "absent"}, not berry (corepack's yarn 2+)`;
    }
    case "bun":
      return has("bun") ? undefined : "bun is not installed";
  }
}

describe.each(MANAGERS)("the npm adapter under $name", (manager) => {
  const root = tempRepo({
    "telo-workspace.yaml": "release:\n  units:\n    - { path: packages/*, ecosystem: npm }\n",
    "package.json":
      JSON.stringify({ name: "root", private: true, ...(manager.workspaces ? { workspaces: ["packages/*"] } : {}) }) + "\n",
    ...manager.files,
    "packages/lib/package.json": JSON.stringify({ name: "fx-lib", version: "1.0.0" }, null, 2) + "\n",
    "packages/lib/index.js": "export {};\n",
    "packages/app/package.json":
      JSON.stringify({ name: "fx-app", version: "1.0.0", dependencies: { "fx-lib": manager.range } }, null, 2) + "\n",
  });
  roots.push(root);
  let skip = available(manager.name, root);
  if (skip === undefined && "install" in manager) {
    const [command, args] = manager.install;
    if (has(command, [...args], root) === undefined) skip = `\`${command} ${args.join(" ")}\` failed in the fixture`;
  }

  it.skipIf(skip !== undefined)(`packs concrete versions, and a sibling bump moves the dependent (skip: ${skip ?? "none"})`, async () => {
    const digest = async () => {
      const workspace = loadReleaseWorkspace(root, { adapters: SHIPPED_ADAPTERS });
      const session = await npmEvidence.open(workspace, { ledger: EMPTY_LEDGER, argv: {} });
      const unit = workspace.units.find((u) => u.key === "packages/app")!;
      return session.collect({ unit, anchor: unit.anchors[0]! });
    };
    const before = await digest();
    expect(before.imports).toEqual(["packages/lib"]);
    expect(before.files).toContain("packages/app/package.json");

    write(root, { "packages/lib/package.json": JSON.stringify({ name: "fx-lib", version: "1.1.0" }, null, 2) + "\n" });
    if (!manager.range.startsWith("workspace:")) {
      const workspace = loadReleaseWorkspace(root, { adapters: SHIPPED_ADAPTERS });
      const session = await npmEvidence.open(workspace, { ledger: EMPTY_LEDGER, argv: {} });
      const lib = workspace.units.find((u) => u.key === "packages/lib")!;
      expect(await session.afterStamp!({ unit: lib, anchor: lib.anchors[0]! }, "1.1.0", { units: [], fragments: [], diagnostics: [] })).toEqual([
        "packages/app/package.json",
      ]);
      expect(JSON.parse(read(root, "packages/app/package.json")).dependencies["fx-lib"]).toBe("^1.1.0");
    }
    // A manager reading sibling versions from its lockfile (bun) sees the bump
    // once the lockfile is refreshed, as after any version change.
    if ("install" in manager) has(manager.install[0], [...manager.install[1]], root);
    const after = await digest();
    expect(after.layer).not.toBe(before.layer);
  }, 120_000);
});

describe("a packed manifest", () => {
  it("reads a tarball's file set", () => {
    expect(() => readTarGz(new Uint8Array([1, 2, 3]), "x.tgz")).toThrow(/not a gzip archive/);
  });
});
