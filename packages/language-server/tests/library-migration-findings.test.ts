import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { HarnessHost, canonical, uri } from "./harness.js";

const root = mkdtempSync(join(tmpdir(), "telo-engine-library-migration-"));
const shop = join(root, "shop");
mkdirSync(shop);
writeFileSync(
  join(shop, "telo.yaml"),
  `kind: Telo.Library
metadata: { name: Shop }
lang: en
migrations:
  SHOP_LABEL_RENAMED:
    severity: info
    reason: A box names what it holds as its value.
    rules:
      - rewrite: Self.Box
        match: { type: object, required: [label] }
        move: { /label: /value }
---
kind: Telo.Definition
metadata: { name: Box }
extends: Telo.Value
`,
);
writeFileSync(
  join(root, "telo.yaml"),
  `kind: Telo.Application
metadata: { name: Store }
lang: en
imports: { S: ./shop }
targets: []
---
kind: S.Box
metadata: { name: box }
label: old
`,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

// The engine analyzes the migrated graph: the legacy node reports its migration
// at its own severity, and nothing of the current schema it would otherwise fail.
it("publishes a library migration at its declared severity", async () => {
  const host = new HarnessHost();
  await host.start();
  host.open(join(root, "telo.yaml"));
  await host.published(join(root, "telo.yaml"));
  const found = host.diagnostics().get(join(root, "telo.yaml"))!;
  expect(found.map((d) => [d.code, d.severity])).toEqual([["SHOP_LABEL_RENAMED", 3]]);
});

// The edit `telo migrate` would write, offered whole as one quick fix.
it("offers the library migrations of the module as one quick fix", async () => {
  const host = new HarnessHost();
  await host.start();
  const file = join(root, "telo.yaml");
  host.open(file);
  await host.published(file);
  const diagnostic = host.diagnostics().get(file)![0]!;
  const actions = await host.request("textDocument/codeAction", {
    textDocument: { uri: uri(file) },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic] },
  });
  expect(actions).toHaveLength(1);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const edits = actions[0].edit.changes[canonical(file)] as Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    newText: string;
  }>;
  expect(edits).toHaveLength(1);
  const [edit] = edits;
  const start = lines.slice(0, edit!.range.start.line).join("\n").length + (edit!.range.start.line > 0 ? 1 : 0) + edit!.range.start.character;
  const end = lines.slice(0, edit!.range.end.line).join("\n").length + (edit!.range.end.line > 0 ? 1 : 0) + edit!.range.end.character;
  expect(text.slice(0, start) + edit!.newText + text.slice(end)).toContain("kind: S.Box\nmetadata: { name: box }\nvalue: old\n");
});
