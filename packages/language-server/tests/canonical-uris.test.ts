import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { FIXTURES, HarnessHost, uri } from "./harness.js";

const workspace = mkdtempSync(join(tmpdir(), "telo-engine-uris-"));
const project = join(workspace, "My Project (copy)");
cpSync(join(FIXTURES, "billing"), join(project, "billing"), { recursive: true });
cpSync(join(FIXTURES, "ledger"), join(project, "ledger"), { recursive: true });

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

// The host opened the owner as `…/My%20Project%20(copy)/…` (parentheses left
// bare); everything the engine says names it in the one canonical spelling. The
// harness refuses any non-canonical `file:` URI the engine sends.
it("emits every file: URI canonically, whatever spelling the host used", async () => {
  const host = new HarnessHost();
  await host.start();
  const owner = join(project, "billing", "telo.yaml");
  expect(uri(owner)).toContain("(copy)");
  host.open(owner);
  await host.until(() => host.notifications.some((n) => n.method === "telo/requirements"), "telo/requirements");
  const requirements = host.notifications.find((n) => n.method === "telo/requirements")!.params;
  expect(requirements.owner).toBe(uri(owner).replace("(copy)", "%28copy%29"));
  expect(requirements.documents.every((d: string) => d.includes("%28copy%29"))).toBe(true);
});
