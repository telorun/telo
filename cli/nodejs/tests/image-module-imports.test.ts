import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordLedger } from "../src/release/apply-plan.js";
import { writeLedger } from "../src/release/ledger-store.js";
import { loadWorkspace } from "../src/release/workspace.js";
import { planWorkspace } from "../src/release/workspace-plan.js";

/** An image module imports a module by relative path and is planned along that
 *  edge like any module, though its own digest is its Docker-ignored file set. */
let root: string;

function write(relative: string, text: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const lib = (extra = "") =>
  `kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n${extra}`;

const plan = async () =>
  (await planWorkspace(loadWorkspace(root), { rungs: {}, baseRef: "HEAD" })).plan;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-image-imports-"));
  write(
    "telo-workspace.yaml",
    "release:\n  ecosystems: { telo: { registry: oci://registry.example/acme }, docker: { registry: registry.example/acme } }\n  units:\n    - { path: modules/*, ecosystem: telo }\n    - { path: apps/*, ecosystem: [telo, docker] }\n",
  );
  write("modules/lib/telo.yaml", lib());
  write(
    "apps/site/telo.yaml",
    "kind: Telo.Application\nmetadata:\n  name: Site\n  version: 0.1.0\nimports:\n  Lib: ../../modules/lib\n",
  );
  write("apps/site/Dockerfile", "FROM scratch\n");

  const workspace = loadWorkspace(root);
  const planned = await planWorkspace(workspace, { rungs: {}, baseRef: "HEAD" });
  writeLedger(
    root,
    await recordLedger(root, {
      ...planned.plan,
      units: workspace.modules.map((module) => ({
        key: module.key,
        name: module.name,
        from: module.version,
        to: module.version,
        level: "patch" as const,
        reasons: [],
        changed: [],
        entries: [],
      })),
    }),
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("an image module's import edges", () => {
  it("plans nothing when nothing changed", async () => {
    expect((await plan()).units).toEqual([]);
  });

  it("bumps the image module, naming the sibling, when only the sibling's payload changed", async () => {
    write("modules/lib/telo.yaml", lib("  description: changed\n"));
    const modules = (await plan()).units;

    expect(modules.map((module) => module.key).sort()).toEqual(["apps/site", "modules/lib"]);
    // Its own module artifact pins the sibling, so its manifest layer moved too.
    expect(modules.find((module) => module.key === "apps/site")?.reasons).toContainEqual({
      kind: "imports",
      unit: "modules/lib",
    });
  });
});
