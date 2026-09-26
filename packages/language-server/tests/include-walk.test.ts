import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { HarnessHost } from "./harness.js";

const root = mkdtempSync(join(tmpdir(), "telo-engine-include-"));
const module = join(root, "app");
const elsewhere = join(root, "elsewhere");
mkdirSync(join(module, "routes"), { recursive: true });
mkdirSync(join(elsewhere, "more"), { recursive: true });
writeFileSync(
  join(module, "telo.yaml"),
  'kind: Telo.Application\nmetadata:\n  name: IncludeAll\n  version: 1.0.0\ninclude:\n  - "**"\n  - "!telo.yaml"\n',
);
writeFileSync(join(module, "routes", "partial.yaml"), "kind: Nope.Thing\nmetadata:\n  name: routed\n");
writeFileSync(join(elsewhere, "linked.yaml"), "kind: Linked.Thing\nmetadata:\n  name: linked\n");
writeFileSync(join(elsewhere, "more", "deep.yaml"), "kind: Deep.Thing\nmetadata:\n  name: deep\n");
symlinkSync(join(elsewhere, "linked.yaml"), join(module, "routes", "linked.yaml"));
symlinkSync(join(elsewhere, "more"), join(module, "more"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

// The kernel's local source includes regular files only and does not descend
// through a link (`telo check` on Node reports exactly the partial below), so
// neither a linked partial nor a linked directory joins the module here.
it("expands include: over regular files and real directories only", async () => {
  const host = new HarnessHost();
  await host.start();
  const owner = join(module, "telo.yaml");
  host.open(owner);
  await host.until(
    () => host.notifications.some((n) => n.method === "telo/requirements"),
    "the owner's analysis",
  );
  const documents: string[] = host.notifications.find((n) => n.method === "telo/requirements")!.params.documents;
  expect(documents.map((d) => d.slice(d.indexOf("/app/")))).toEqual(["/app/telo.yaml", "/app/routes/partial.yaml"]);
  await host.published(join(module, "routes", "partial.yaml"));
  const reported = [...host.diagnostics()].filter(([, list]) => list.length > 0).map(([file]) => file);
  expect(reported).toEqual([join(module, "routes", "partial.yaml")]);
});
