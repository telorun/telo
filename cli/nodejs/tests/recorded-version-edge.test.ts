import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../src/release/workspace.js";
import { planWorkspace } from "../src/release/workspace-plan.js";

/**
 * A module whose bill of materials records a workspace package's version holds
 * that version: a release moving the package moves the module's payload once the
 * version is written, so the plan, made before, must already bump the module.
 */

const REGISTRY = "oci://registry.example/acme";
let root: string;

function write(relative: string, text: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function controllerModule(name: string, source: string): void {
  const dir = `modules/${name.toLowerCase()}`;
  write(
    `${dir}/telo.yaml`,
    [
      "kind: Telo.Library",
      "metadata:",
      `  name: ${name}`,
      "  version: 0.3.0",
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Store",
      "capability: Telo.Invocable",
      "controllers:",
      `  - pkg:telo/local/js?path=./nodejs/${name.toLowerCase()}.mjs&local_path=./nodejs/src/index.ts#Store`,
      "schema: { type: object }",
      "",
    ].join("\n"),
  );
  write(`${dir}/nodejs/package.json`, JSON.stringify({ name: `@acme/${name.toLowerCase()}-build`, version: "0.3.0" }));
  write(`${dir}/nodejs/src/index.ts`, source);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-recorded-version-edge-")));
  write(
    "telo-workspace.yaml",
    `release:\n  units:\n    - { path: packages/shared, ecosystem: { npm: nodejs } }\n` +
      `    - { path: modules/*, ecosystem: { telo: { ".": { registry: ${REGISTRY} } } } }\n`,
  );
  write("packages/shared/nodejs/package.json", JSON.stringify({ name: "@acme/shared", version: "1.0.0", packageManager: "pnpm@10.28.2" }));
  write("packages/shared/nodejs/index.js", "export const shared = 1;\n");
  write("packages/shared/CHANGELOG.md", "# Changelog\n");
  write(".changes/pending/shared.yaml", "units:\n  packages/shared: Fixed\nbody: Fixed the shared code.\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a module whose bill of materials records a workspace package", () => {
  it("is planned when only that package's unit moves, holding its version", async () => {
    controllerModule(
      "Vault",
      'import { shared } from "../../../../packages/shared/nodejs/index.js";\nexport const Store = { shared };\n',
    );
    const { plan } = await planWorkspace(loadWorkspace(root), { rungs: {}, baseRef: "HEAD" });
    const vault = plan.units.find((unit) => unit.key === "modules/vault");
    expect(vault?.reasons).toContainEqual({
      kind: "version-location",
      unit: "packages/shared",
      files: ["packages/shared/nodejs/package.json"],
    });
  });

  it("is not planned when its bundle puts no byte of the package in", async () => {
    controllerModule("Vault", "export const Store = { own: 1 };\n");
    const { plan } = await planWorkspace(loadWorkspace(root), { rungs: {}, baseRef: "HEAD" });
    expect(plan.units.map((unit) => unit.key)).toEqual(["packages/shared"]);
  });
});
