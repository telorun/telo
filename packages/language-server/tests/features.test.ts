import { lastMatchIndex } from "@telorun/glob";
import {
  SEMANTIC_TOKEN_LEGEND,
  buildCompletions,
  buildDefinition,
  buildHover,
  buildImportUpgrades,
  buildRename,
  buildSemanticTokens,
  buildSignatureHelp,
  createVersionCompatibility,
  prepareRename,
  workspaceCompletions,
  workspaceDiagnostics,
} from "@telorun/ide-support";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, HarnessHost, pathOf, uri } from "./harness.js";
import { analyseInProcess } from "./in-process.js";

const OWNER = join(FIXTURES, "billing", "telo.yaml");
const PARTIAL = join(FIXTURES, "billing", "handlers.yaml");
const at = (path: string, line: number, character: number) => ({
  textDocument: { uri: uri(path) },
  position: { line, character },
});

/** A host with the billing module open and analysed. */
async function billing() {
  const host = new HarnessHost();
  await host.start();
  host.open(OWNER);
  host.open(PARTIAL);
  await host.published(PARTIAL);
  return host;
}

describe("language features answer as ide-support does in-process", () => {
  it("completion", async () => {
    const host = await billing();
    const local = await analyseInProcess(PARTIAL);
    // After `Self.` inside `!cel "Self.withVat(10.0)"`.
    const engine = await host.request("textDocument/completion", at(PARTIAL, 3, 19));
    const expected = await buildCompletions(
      local.text, 3, 19, local.registry, undefined, local.docs, local.analysis,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(engine.map((i: any) => [i.label, i.textEdit?.newText ?? i.insertText])).toEqual(
      expected.map((r) => [r.label, r.replaceRange ? (r.insertText ?? r.label) : r.insertText]),
    );
  });

  it("hover", async () => {
    const host = await billing();
    const local = await analyseInProcess(PARTIAL);
    const engine = await host.request("textDocument/hover", at(PARTIAL, 0, 8));
    const expected = buildHover(local.text, 0, 8, local.registry, local.docs, local.analysis)!;
    expect(engine.contents.value).toBe(expected.contents);
    expect(engine.range).toEqual(expected.range);
  });

  it("definition", async () => {
    const host = await billing();
    const local = await analyseInProcess(OWNER);
    // `- !ref charge` in the owner, declared in the partial.
    const engine = await host.request("textDocument/definition", at(OWNER, 11, 11));
    const expected = buildDefinition(
      local.text, 11, 11, local.graph, OWNER, local.docs, local.analysis,
    )!;
    expect({ ...engine, uri: pathOf(engine.uri) }).toEqual(expected);
  });

  it("prepareRename and rename", async () => {
    const host = await billing();
    const local = await analyseInProcess(OWNER);
    const prepared = await host.request("textDocument/prepareRename", at(OWNER, 11, 11));
    const expectedPrepared = prepareRename(local.text, 11, 11, local.graph, OWNER, local.docs);
    if (!expectedPrepared.ok) throw new Error(expectedPrepared.reason);
    expect(prepared).toEqual({
      range: expectedPrepared.symbol.range,
      placeholder: expectedPrepared.symbol.name,
    });

    const edit = await host.request("textDocument/rename", { ...at(OWNER, 11, 11), newName: "bill" });
    const expected = buildRename(
      local.text, 11, 11, "bill", local.graph, OWNER, local.docs, local.analysis,
    );
    if (!expected.ok) throw new Error(expected.reason);
    expect(
      Object.fromEntries(Object.entries(edit.changes).map(([u, edits]) => [pathOf(u), edits])),
    ).toEqual(Object.fromEntries(expected.files.map((f) => [f.uri, f.edits])));
  });

  it("signatureHelp", async () => {
    const host = await billing();
    const local = await analyseInProcess(PARTIAL);
    // Inside the parentheses of `Self.withVat(10.0)`.
    const engine = await host.request("textDocument/signatureHelp", at(PARTIAL, 3, 27));
    const expected = buildSignatureHelp(local.text, 3, 27, local.docs, local.analysis)!;
    expect(engine.activeParameter).toBe(expected.activeParameter);
    expect(
      engine.signatures.map((s: any) => [s.label, s.parameters.map((p: any) => p.label)]),
    ).toEqual(expected.signatures.map((s) => [s.label, s.parameters.map((p) => p.label)]));
  });

  it("semanticTokens/full", async () => {
    const host = await billing();
    const local = await analyseInProcess(PARTIAL);
    const engine = await host.request("textDocument/semanticTokens/full", {
      textDocument: { uri: uri(PARTIAL) },
    });
    const tokens = buildSemanticTokens(local.text, local.registry, local.docs, local.analysis).sort(
      (a, b) => a.line - b.line || a.character - b.character,
    );
    expect(tokens.length).toBeGreaterThan(0);
    const data: number[] = [];
    let line = 0;
    let character = 0;
    for (const t of tokens) {
      data.push(t.line - line, t.line === line ? t.character - character : t.character);
      data.push(t.length, SEMANTIC_TOKEN_LEGEND.indexOf(t.type), 0);
      line = t.line;
      character = t.character;
    }
    expect(engine.data).toEqual(data);
  });

  // The repair rides in `Diagnostic.data`, comes back in the code action's
  // context, and the edit it yields repairs the document.
  it("codeAction round-trips a quick fix through Diagnostic.data", async () => {
    const host = await billing();
    const typo = readFileSync(PARTIAL, "utf8").replace("kind: Ledger.Entry", "kind: Ledgr.Entry");
    host.change(PARTIAL, typo);
    await host.until(
      () => (host.diagnostics().get(PARTIAL) ?? []).some((d) => d.code === "UNDEFINED_KIND"),
      "the misspelt kind to be reported",
    );
    const diagnostic = host.diagnostics().get(PARTIAL)!.find((d) => d.code === "UNDEFINED_KIND");
    expect(diagnostic.data.fix).toEqual({ replacement: "Ledger.Entry" });

    const actions = await host.request("textDocument/codeAction", {
      textDocument: { uri: uri(PARTIAL) },
      range: diagnostic.range,
      context: { diagnostics: [diagnostic] },
    });
    expect(actions).toHaveLength(1);
    const [edit] = actions[0].edit.changes[uri(PARTIAL)];
    const lines = typo.split("\n");
    const line = lines[edit.range.start.line]!;
    lines[edit.range.start.line] =
      line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
    expect(lines.join("\n")).toBe(readFileSync(PARTIAL, "utf8"));
  });

  it("codeLens and executeCommand upgrade an import through workspace/applyEdit", async () => {
    const consumer = join(FIXTURES, "remote-consumer", "telo.yaml");
    const remote = readFileSync(join(FIXTURES, "remote", "telo.yaml"), "utf8");
    const base = "oci://registry.example.test/telo/remote";
    const pin = `sha256-${"A".repeat(43)}`;
    const modules = {
      [`${base}@1.0.0`]: remote,
      [`${base}@1.1.0`]: remote.replace("version: 1.0.0", "version: 1.1.0"),
    };
    const versions = [{ version: "1.1.0", integrity: pin }, { version: "1.0.0" }];
    const host = new HarnessHost({ remote: modules, versions: { [base]: versions } });
    await host.start();
    host.open(consumer);
    await host.published(consumer);

    const text = readFileSync(consumer, "utf8");
    const expected = (await buildImportUpgrades(text, {
      listVersions: async () => versions,
      isCompatible: createVersionCompatibility(async (b, v) => modules[`${b}@${v}`] ?? null),
    }))!;
    expect(expected.upgrades).toHaveLength(1);

    const lenses = await host.request("textDocument/codeLens", { textDocument: { uri: uri(consumer) } });
    const upgrade = lenses.find((l: any) => l.command.command === "telo.upgradeImport");
    expect(upgrade.range).toEqual(expected.upgrades[0]!.keyRange);
    expect(upgrade.command.title).toBe("↑ 1.0.0 → 1.1.0");

    await host.request("workspace/executeCommand", {
      command: upgrade.command.command,
      arguments: upgrade.command.arguments,
    });
    expect(host.appliedEdits).toHaveLength(1);
    expect(host.appliedEdits[0].edit.changes[uri(consumer)]).toEqual(
      expected.upgrades[0]!.edits.map((e) => ({ range: e.range, newText: e.newText })),
    );
  });
});

describe("telo-workspace.yaml", () => {
  // The marker is opened as a buffer only: a real one here would re-root every
  // module beneath it for the repository's own release tooling.
  const MARKER = join(FIXTURES, "marker", "telo-workspace.yaml");
  const TEXT = "release:\n  modules:\n    - apps/*\n    - tooling/*\n    - \n";
  const env = {
    match: lastMatchIndex,
    directories: () => ["apps", "apps/one"],
    moduleDirectories: () => ["apps/one"],
    enclosingMarkers: () => [join(FIXTURES, "..", "..", "..", "..")],
    recordedRegistries: () => [],
  };

  it("reports what the repository listing shows", async () => {
    const host = new HarnessHost();
    await host.start();
    host.open(MARKER, TEXT);
    await host.published(MARKER);
    const engine = host.diagnostics().get(MARKER)!;
    const expected = workspaceDiagnostics(TEXT, env);
    expect(expected.map((d) => d.code)).toContain("WORKSPACE_ENTRY_MATCHES_NOTHING");
    expect(engine.map((d) => [d.code, d.range, d.message])).toEqual(
      expected.map((d) => [d.code, d.range, d.message]),
    );
  });

  it("completes from the repository listing", async () => {
    const host = new HarnessHost();
    await host.start();
    host.open(MARKER, TEXT);
    await host.published(MARKER);
    const engine = await host.request("textDocument/completion", at(MARKER, 4, 6));
    const expected = workspaceCompletions(TEXT, { line: 4, character: 6 }, env);
    expect(expected.length).toBeGreaterThan(0);
    expect(engine.map((i: any) => i.label)).toEqual(expected.map((r) => r.label));
  });
});
