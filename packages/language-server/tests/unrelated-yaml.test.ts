import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { HarnessHost } from "./harness.js";

const root = mkdtempSync(join(tmpdir(), "telo-engine-unrelated-"));
const module = join(root, "app");
mkdirSync(join(module, "chart"), { recursive: true });
writeFileSync(
  join(module, "telo.yaml"),
  "kind: Telo.Application\nmetadata:\n  name: Unrelated\n  version: 1.0.0\n",
);
const kubernetes = join(module, "chart", "deployment.yaml");
writeFileSync(kubernetes, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n");
const stray = join(module, "stray.yaml");
writeFileSync(stray, "kind: Run.Sequence\nmetadata:\n  name: stray\nsteps: []\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

// A partial declares a module-qualified kind, so a file beside a module whose
// `kind:` is unqualified is some other tool's YAML and is left alone.
it("reports a stray partial, and nothing on YAML with an unqualified kind", async () => {
  const host = new HarnessHost();
  await host.start();
  host.open(kubernetes);
  host.open(stray);
  // Opened second, so its warning arrives after the first file was judged.
  await host.until(() => (host.diagnostics().get(stray) ?? []).length > 0, "the stray partial's warning");
  const reported = host.diagnostics();
  expect(reported.get(stray)!.map((d) => d.message)).toEqual([
    expect.stringContaining("not listed in the 'include' field"),
  ]);
  expect(reported.get(kubernetes) ?? []).toEqual([]);
});
