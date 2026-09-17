import {
  AnalysisRegistry,
  buildDocumentPositions,
  NO_MIGRATIONS,
  parseToAst,
  type LoadedFile,
  type LoadedGraph,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { celSegmentTokens } from "../src/cel/tokens.js";
import { buildCompletions } from "../src/completions/build.js";
import { buildDefinition } from "../src/definition/build-definition.js";
import { buildHover } from "../src/hover/build-hover.js";
import { buildRename } from "../src/rename/index.js";
import { buildSignatureHelp } from "../src/signature-help/index.js";

/**
 * Module calls as first-class editor symbols: every answer below is the
 * analyzer's resolution of the call — the callable `telo check` binds it to.
 */

const SRC = "/app/telo.yaml";

const HANDLER_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Handler", module: "Billing" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { price: { type: "number", "x-telo-eval": "runtime" } },
  },
} as unknown as ResourceDefinition;

function manifests(): ResourceManifest[] {
  return [
    { kind: "Telo.Application", metadata: { name: "Billing", module: "Billing" } },
    {
      kind: "Telo.Function",
      metadata: { name: "withVat", module: "Billing", description: "Adds VAT to a net price." },
      params: [
        { name: "net", schema: { type: "number" } },
        { name: "rate", schema: { type: "number" }, optional: true },
      ],
      returns: { schema: { type: "number" } },
      body: 1,
    },
    {
      kind: "Self.Handler",
      metadata: { name: "handler", module: "Billing" },
      price: { __cel: "Self.withVat(10.0)" },
    },
  ] as unknown as ResourceManifest[];
}

function setup(price: string) {
  const text = [
    "kind: Telo.Application",
    "metadata:",
    "  name: Billing",
    "---",
    "kind: Telo.Function",
    "metadata:",
    "  name: withVat",
    "params:",
    "  - name: net",
    "    schema: { type: number }",
    "returns:",
    "  schema: { type: number }",
    "body: 1",
    "---",
    "kind: Self.Handler",
    "metadata:",
    "  name: handler",
    `price: !cel "${price}"`,
  ].join("\n");
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "Billing");
  registry.registerImport("Self", "Billing", undefined);
  registry.registerDefinition(HANDLER_DEF);
  const all = manifests();
  const astDocuments = parseToAst(text);
  const file: LoadedFile = {
    source: SRC,
    requestedUrl: SRC,
    text,
    documents: [],
    astDocuments,
    manifests: all as LoadedFile["manifests"],
    positions: buildDocumentPositions(text, astDocuments),
    parseErrors: [],
    migrations: NO_MIGRATIONS,
  };
  const graph = {
    rootSource: SRC,
    entry: { owner: file, partials: [] },
    modules: new Map([[SRC, { owner: file, partials: [] }]]),
    importEdges: new Map(),
  } as unknown as LoadedGraph;
  return { text, registry, graph, analysis: registry.analysisOf(all) };
}

/** Line and character of the offset just after the last match of `needle`, or
 *  `back` characters before that. */
function after(text: string, needle: string, back = 0): { line: number; character: number } {
  const idx = text.lastIndexOf(needle) + needle.length - back;
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
}

describe("module calls in the editor", () => {
  it("offers a module's callables after its name, with their signatures", async () => {
    const { text, registry, analysis } = setup("Self.");
    const pos = after(text, 'price: !cel "Self.');
    const results = await buildCompletions(text, pos.line, pos.character, registry, undefined, undefined, analysis);
    const withVat = results.find((r) => r.label === "withVat");
    expect(withVat?.detail).toBe("Self.withVat(net: number, rate?: number) → number");
  });

  it("hovers a call as its function's signature and what it promises", () => {
    const { text, registry, analysis } = setup("Self.withVat(10.0)");
    const pos = after(text, "Self.withVat", 2);
    const hover = buildHover(text, pos.line, pos.character, registry, undefined, analysis);
    expect(hover?.contents).toContain("Self.withVat(net: number, rate?: number) → number");
    expect(hover?.contents).toContain("Adds VAT to a net price.");
    expect(hover?.contents).toMatch(/(^|\n)deterministic$/);
  });

  it("gives signature help with the argument under the cursor active", () => {
    const { text, analysis } = setup("Self.withVat(10.0, ");
    const pos = after(text, "Self.withVat(10.0, ");
    const help = buildSignatureHelp(text, pos.line, pos.character, undefined, analysis);
    expect(help?.signatures[0]?.label).toBe("Self.withVat(net: number, rate?: number) → number");
    expect(help?.activeParameter).toBe(1);
    // A receiver that is a member of something is a method call, not a module call.
    const member = setup("x.Self.withVat(10.0, ");
    const at = after(member.text, "x.Self.withVat(10.0, ");
    expect(buildSignatureHelp(member.text, at.line, at.character, undefined, member.analysis)).toBeUndefined();
  });

  it("navigates a call to the function it binds to", () => {
    const { text, graph, analysis } = setup("Self.withVat(10.0)");
    const pos = after(text, "Self.withVat", 2);
    const def = buildDefinition(text, pos.line, pos.character, graph, SRC, undefined, analysis);
    expect(def?.range.start.line).toBe(6); // `  name: withVat`
  });

  it("renames a function together with its calls", () => {
    const { text, graph } = setup("Self.withVat(10.0) + Billing.withVat(1.0)");
    const pos = after(text, "  name: withVat", 1);
    const result = buildRename(text, pos.line, pos.character, "grossOf", graph, SRC);
    expect(result.ok).toBe(true);
    const edits = result.ok ? result.files[0]!.edits : [];
    expect(edits.map((e) => [e.range.start.line, e.range.start.character])).toEqual([
      [6, 8],
      [17, 18],
      [17, 42],
    ]);
  });

  it("renames a shape together with every reference inside a signature", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: Billing",
      "---",
      "kind: Telo.JsonSchema",
      "metadata:",
      "  name: Money",
      "schema: { type: number }",
      "---",
      "kind: Telo.Function",
      "metadata:",
      "  name: withVat",
      "params:",
      "  - name: net",
      "    schema: !ref Money",
      "returns:",
      "  schema:",
      "    type: object",
      "    properties:",
      "      gross: !ref Money",
      "body: 1",
    ].join("\n");
    const { graph, registry } = setup("1.0");
    const file = graph.entry.owner;
    Object.assign(file, { text, astDocuments: parseToAst(text) });
    const money = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Money", module: "Billing", source: SRC },
      schema: { type: "number" },
    } as unknown as ResourceManifest;
    const analysis = registry.analysisOf([manifests()[0]!, money]);
    const pos = after(text, "  name: Money", 1);
    const result = buildRename(text, pos.line, pos.character, "Amount", graph, SRC, undefined, analysis);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    const edits = result.ok ? result.files[0]!.edits : [];
    expect(edits.map((e) => e.range.start.line)).toEqual([6, 14, 19]);
  });

  it("colours a call's receiver as a namespace and its name as a function", () => {
    const { text, analysis } = setup("Self.withVat(10.0)");
    const docs = parseToAst(text);
    const resource = analysis.celScope.resourceFor("Self.Handler", "handler")!;
    const scope = analysis.celScope.scopeAt(resource, "price");
    const scalar = (docs[2]!.root as any).entries.find((e: any) => e.key.value === "price").value;
    const tokens = celSegmentTokens(text, scalar.celSegments()[0], scope).map((t) => [
      text.slice(t.range[0], t.range[1]),
      t.type,
    ]);
    expect(tokens).toContainEqual(["Self", "namespace"]);
    expect(tokens).toContainEqual(["withVat", "function"]);
  });
});
