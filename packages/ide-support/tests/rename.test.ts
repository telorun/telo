import {
  buildDocumentPositions,
  NO_MIGRATIONS,
  parseToAst,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import { describe, expect, it } from "vitest";

import { buildRename, prepareRename } from "../src/rename/index.js";

function loadedFile(source: string, text: string, manifests: unknown[]): LoadedFile {
  const astDocuments = parseToAst(text);
  return {
    source,
    requestedUrl: source,
    text,
    documents: [],
    astDocuments,
    manifests: manifests as LoadedFile["manifests"],
    positions: buildDocumentPositions(text, astDocuments),
    parseErrors: [],
    migrations: NO_MIGRATIONS,
  };
}

function mod(owner: LoadedFile, partials: LoadedFile[] = []): LoadedModule {
  return { owner, partials };
}

/** Line/character at the LAST character of the `occurrence`-th match of
 *  `needle` — so every needle here ends with the identifier being targeted and
 *  the cursor lands inside it rather than on a `.` or `:` delimiter. */
function at(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let found = -1;
  for (let i = 0; i <= occurrence; i++) found = text.indexOf(needle, found + 1);
  if (found < 0) throw new Error(`needle not found: ${needle}`);
  const idx = found + needle.length - 1;
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
}

/** Apply an edit set to text, so a test asserts the RESULTING document rather
 *  than a list of coordinates — which is what actually has to be correct, and
 *  what an off-by-one in a span silently passes. */
function apply(text: string, edits: Array<{ range: any; newText: string }>): string {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const flat = edits
    .map((e) => ({
      start: offsets[e.range.start.line] + e.range.start.character,
      end: offsets[e.range.end.line] + e.range.end.character,
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of flat) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

const APP = "/app/telo.yaml";

/** One application with a resource, a step that reads it, a `!ref` and a
 *  declared variable — every value-level surface in one file. */
function singleModule(extra: { exports?: string[]; libraryKind?: boolean } = {}) {
  const text = [
    extra.libraryKind ? "kind: Telo.Library" : "kind: Telo.Application",
    "metadata:",
    "  name: App",
    "variables:",
    "  apiUrl:",
    "    env: API_URL",
    "    type: string",
    ...(extra.exports ? ["exports:", "  resources:", ...extra.exports.map((e) => `    - ${e}`)] : []),
    "targets:",
    "  - !ref mySeq",
    "---",
    "kind: Run.Value",
    "metadata:",
    "  name: greeting",
    'value: !cel "variables.apiUrl"',
    "---",
    "kind: Run.Sequence",
    "metadata:",
    "  name: mySeq",
    "steps:",
    "  - name: build",
    "    invoke: !ref greeting",
    "  - name: emit",
    "    inputs:",
    '      text: !cel "steps.build.result + resources.greeting.value"',
  ].join("\n");

  const manifests: unknown[] = [
    {
      kind: extra.libraryKind ? "Telo.Library" : "Telo.Application",
      metadata: { name: "App" },
      variables: { apiUrl: { env: "API_URL", type: "string" } },
      ...(extra.exports ? { exports: { resources: extra.exports } } : {}),
    },
    { kind: "Run.Value", metadata: { name: "greeting" } },
    { kind: "Run.Sequence", metadata: { name: "mySeq" } },
  ];

  const file = loadedFile(APP, text, manifests);
  const graph = {
    rootSource: APP,
    entry: mod(file),
    modules: new Map([[APP, mod(file)]]),
    importEdges: new Map(),
  } as unknown as LoadedGraph;
  return { text, graph };
}

function rename(text: string, graph: LoadedGraph, needle: string, newName: string, occurrence = 0) {
  const pos = at(text, needle, occurrence);
  return buildRename(text, pos.line, pos.character, newName, graph, APP);
}

describe("prepareRename", () => {
  it("identifies a resource from its declaration, a !ref, and a CEL read alike", () => {
    const { text, graph } = singleModule();
    for (const [needle, occurrence] of [
      ["name: greeting", 0],
      ["!ref greeting", 0],
      ["resources.greeting", 0],
    ] as const) {
      const pos = at(text, needle as string, occurrence);
      const prepared = prepareRename(text, pos.line, pos.character, graph, APP);
      expect(prepared, needle as string).toMatchObject({
        ok: true,
        symbol: { kind: "resource", name: "greeting" },
      });
    }
  });

  it("identifies a step and a declared variable", () => {
    const { text, graph } = singleModule();
    const step = at(text, "steps.build");
    expect(prepareRename(text, step.line, step.character, graph, APP)).toMatchObject({
      ok: true,
      symbol: { kind: "step", name: "build" },
    });

    const variable = at(text, "apiUrl");
    expect(prepareRename(text, variable.line, variable.character, graph, APP)).toMatchObject({
      ok: true,
      symbol: { kind: "declaration", name: "apiUrl", block: "variables" },
    });
  });

  it("refuses the type-level surfaces, naming what makes each one bigger", () => {
    const { text, graph } = singleModule();
    const moduleName = at(text, "name: App");
    const prepared = prepareRename(text, moduleName.line, moduleName.character, graph, APP);
    expect(prepared.ok).toBe(false);
    expect((prepared as { reason: string }).reason).toMatch(/canonical kind prefix/);
  });
});

describe("buildRename", () => {
  it("moves a resource's declaration, its !ref and its CEL read together", () => {
    const { text, graph } = singleModule();
    const result = rename(text, graph, "name: greeting", "welcomeMessage");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);

    const after = apply(text, result.files[0].edits);
    expect(after).toContain("  name: welcomeMessage");
    expect(after).toContain("invoke: !ref welcomeMessage");
    expect(after).toContain('text: !cel "steps.build.result + resources.welcomeMessage.value"');
    // Nothing else moved.
    expect(after).toContain("  name: mySeq");
    expect(after).not.toContain("greeting");
  });

  it("rewrites only the identifier inside a CEL expression, not the scalar", () => {
    const { text, graph } = singleModule();
    const result = rename(text, graph, "steps.build", "buildText");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = apply(text, result.files[0].edits);
    expect(after).toContain('text: !cel "steps.buildText.result + resources.greeting.value"');
    expect(after).toContain("  - name: buildText");
  });

  it("renames a declared variable at its key and every CEL read", () => {
    const { text, graph } = singleModule();
    const result = rename(text, graph, "apiUrl", "serviceUrl");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = apply(text, result.files[0].edits);
    expect(after).toContain("  serviceUrl:");
    expect(after).toContain('value: !cel "variables.serviceUrl"');
    expect(after).toContain("env: API_URL");
  });

  it("reaches a partial file, since a resource name is module-scoped", () => {
    const ownerText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "include:",
      "  - ./more.yaml",
      "---",
      "kind: Run.Value",
      "metadata:",
      "  name: greeting",
    ].join("\n");
    const partialText = [
      "kind: Run.Sequence",
      "metadata:",
      "  name: seq",
      "steps:",
      "  - name: say",
      "    invoke: !ref greeting",
    ].join("\n");
    const owner = loadedFile(APP, ownerText, [
      { kind: "Telo.Application", metadata: { name: "App" } },
      { kind: "Run.Value", metadata: { name: "greeting" } },
    ]);
    const partial = loadedFile("/app/more.yaml", partialText, [
      { kind: "Run.Sequence", metadata: { name: "seq" } },
    ]);
    const graph = {
      rootSource: APP,
      entry: mod(owner, [partial]),
      modules: new Map([[APP, mod(owner, [partial])]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const pos = at(ownerText, "name: greeting");
    const result = buildRename(ownerText, pos.line, pos.character, "welcome", graph, APP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.uri).sort()).toEqual(["/app/more.yaml", APP]);
    const partialAfter = apply(
      partialText,
      result.files.find((f) => f.uri === "/app/more.yaml")!.edits,
    );
    expect(partialAfter).toContain("invoke: !ref welcome");
  });

  it("refuses an exported instance, because consumers reference it from files this workspace may not hold", () => {
    const { text, graph } = singleModule({ exports: ["greeting"], libraryKind: true });
    const result = rename(text, graph, "name: greeting", "welcome");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/exports\.resources/);
    expect((result as { reason: string }).reason).toMatch(/breaking change/);
  });

  it("refuses a library's declared variable for the same reason", () => {
    const { text, graph } = singleModule({ libraryKind: true });
    const result = rename(text, graph, "apiUrl", "serviceUrl");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/importers pass/);
  });

  it("refuses when the spelling is declared twice, rather than guessing which one references mean", () => {
    // A `with:`-scoped declaration shadows the module-level one inside its
    // scope, so no single edit set is right for both.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "---",
      "kind: Run.Value",
      "metadata:",
      "  name: conn",
      "---",
      "kind: Run.Sequence",
      "metadata:",
      "  name: seq",
      "with:",
      "  - kind: Sql.Connection",
      "    metadata:",
      "      name: conn",
      "steps:",
      "  - name: go",
      "    invoke: !ref conn",
    ].join("\n");
    const file = loadedFile(APP, text, [
      { kind: "Telo.Application", metadata: { name: "App" } },
      { kind: "Run.Value", metadata: { name: "conn" } },
      { kind: "Run.Sequence", metadata: { name: "seq" } },
    ]);
    const graph = {
      rootSource: APP,
      entry: mod(file),
      modules: new Map([[APP, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const result = rename(text, graph, "name: conn", "connection");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/declared 2 times/);
  });

  it("refuses a new name the analyzer would reject, quoting the rule", () => {
    const { text, graph } = singleModule();
    const hyphen = rename(text, graph, "name: greeting", "my-greeting");
    expect(hyphen.ok).toBe(false);
    expect((hyphen as { reason: string }).reason).toMatch(/subtraction/);

    const keyword = rename(text, graph, "name: greeting", "in");
    expect((keyword as { reason: string }).reason).toMatch(/CEL keyword/);
  });

  it("warns through the same rule when the new name is miscased", () => {
    const { text, graph } = singleModule();
    const result = rename(text, graph, "name: greeting", "Greeting");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/lowercase/);
  });

  it("is a no-op when the name is unchanged", () => {
    const { text, graph } = singleModule();
    const result = rename(text, graph, "name: greeting", "greeting");
    expect(result).toMatchObject({ ok: true, files: [] });
  });

  it("refuses a cross-module ref, whose declaration is not this module's", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Store: ../store",
      "---",
      "kind: Run.Sequence",
      "metadata:",
      "  name: seq",
      "steps:",
      "  - name: go",
      "    invoke: !ref Store.conn",
    ].join("\n");
    const file = loadedFile(APP, text, [
      { kind: "Telo.Application", metadata: { name: "App" }, imports: { Store: "../store" } },
      { kind: "Run.Sequence", metadata: { name: "seq" } },
    ]);
    const graph = {
      rootSource: APP,
      entry: mod(file),
      modules: new Map([[APP, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const result = rename(text, graph, "Store.conn", "connection");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/imported module/);
  });
});
