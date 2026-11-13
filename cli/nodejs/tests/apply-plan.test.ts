import type { ReleasePlan } from "@telorun/release";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strandedUnreleasedFloors, writeUnreleasedFloors } from "../src/release/unreleased-floors.js";
import { loadWorkspace } from "../src/release/workspace.js";

/** A workspace whose telo line is a group holding the analyzer's npm unit, and
 *  a module whose floor waits for that line's next release. */
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-apply-plan-"));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write(
    "telo-workspace.yaml",
    "release:\n  units:\n    - { path: analyzer, ecosystem: { npm: nodejs } }\n    - { path: cli, ecosystem: { npm: nodejs } }\n" +
      "    - { path: modules/*, ecosystem: telo }\n  groups:\n    telo: [analyzer, cli]\n",
  );
  write("analyzer/nodejs/package.json", '{ "name": "@telorun/analyzer", "version": "0.136.0" }\n');
  write("cli/nodejs/package.json", '{ "name": "@telorun/cli", "version": "0.136.0" }\n');
  write(
    "modules/console/telo.yaml",
    "kind: Telo.Library\nmetadata:\n  name: Console\n  version: 0.18.0\nrequires:\n  telo: '>=unreleased'\nrestrictions:\n" +
      "  - { versions: '<=0.18.0', requires: { telo: \">=unreleased\" }, reason: x }\n",
  );
  return root;
}

const moving = (key: string, to: string): ReleasePlan => ({
  units: [{ key, name: key, from: "0.136.0", to, level: "minor", reasons: [], changed: [], entries: [] }],
  fragments: [],
  diagnostics: [],
});

let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("apply's >=unreleased rewrite", () => {
  it("writes the surface of the telo line's planned version, a candidate's included, keeping quotes", () => {
    root = workspace();
    expect(writeUnreleasedFloors(loadWorkspace(root), moving("cli", "0.137.0-rc.1"))).toEqual(["modules/console/telo.yaml"]);
    const text = fs.readFileSync(path.join(root, "modules/console/telo.yaml"), "utf8");
    expect(text).toContain("telo: '>=0.137.0'");
    expect(text).toContain('requires: { telo: ">=0.137.0" }');
  });

  it("writes nothing when the plan does not move the line", () => {
    root = workspace();
    expect(writeUnreleasedFloors(loadWorkspace(root), moving("modules/console", "0.19.0"))).toEqual([]);
  });
});

describe("check's stranded >=unreleased floor", () => {
  it("refuses a >=unreleased floor in a plan that does not move the telo line, and none in one that does", () => {
    root = workspace();
    const ws = loadWorkspace(root);
    expect(strandedUnreleasedFloors(ws, moving("modules/console", "0.19.0")).map((f) => [f.module, f.code])).toEqual([
      ["modules/console", "REQUIRES_FLOOR_TOO_HIGH"],
    ]);
    expect(strandedUnreleasedFloors(ws, moving("cli", "0.137.0"))).toEqual([]);
  });
});
