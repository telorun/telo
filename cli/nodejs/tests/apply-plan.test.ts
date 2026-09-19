import type { ReleasePlan } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePlannedVersions } from "../src/release/apply-plan.js";
import { loadWorkspace } from "../src/release/workspace.js";

/** A workspace holding one module whose Rust half is a member of a cargo
 *  workspace at the same root — the standard-library layout. */
function workspaceWithCrate(lock: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-apply-plan-"));
  fs.writeFileSync(path.join(root, "telo-workspace.yaml"), "release:\n  modules:\n    - modules/*\n");
  fs.writeFileSync(path.join(root, "Cargo.lock"), lock);

  const dir = path.join(root, "modules", "console");
  fs.mkdirSync(path.join(dir, "rust"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "telo.yaml"),
    "kind: Telo.Library\nmetadata:\n  name: Console\n  version: 0.18.0\n",
  );
  fs.writeFileSync(
    path.join(dir, "rust", "Cargo.toml"),
    '[package]\nname = "telorun-console"\nversion = "0.18.0"\nedition = "2021"\n',
  );
  return root;
}

const plan = (): ReleasePlan => ({
  modules: [
    {
      key: "modules/console",
      name: "Console",
      from: "0.18.0",
      to: "0.18.1",
      level: "patch",
      reasons: [{ kind: "unattributed" }],
      changed: [],
      entries: [],
    },
  ],
  fragments: [],
  diagnostics: [],
});

const LOCK = [
  "version = 4",
  "",
  "[[package]]",
  'name = "telorun-console"',
  'version = "0.18.0"',
  "",
].join("\n");

describe("writePlannedVersions", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("moves the crate's version in the lockfile that records it", () => {
    root = workspaceWithCrate(LOCK);
    const applied = writePlannedVersions(loadWorkspace(root), plan(), "2026-09-19");

    expect(fs.readFileSync(path.join(root, "Cargo.lock"), "utf8")).toContain('version = "0.18.1"');
    expect(applied[0]!.files).toContain("Cargo.lock");
  });

  it("writes no lockfile when none records the crate", () => {
    root = workspaceWithCrate(LOCK);
    fs.rmSync(path.join(root, "Cargo.lock"));
    const applied = writePlannedVersions(loadWorkspace(root), plan(), "2026-09-19");

    expect(fs.existsSync(path.join(root, "Cargo.lock"))).toBe(false);
    expect(applied[0]!.files).toEqual(["telo.yaml", "rust/Cargo.toml"]);
  });
});
