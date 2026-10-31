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

const TEXT = [
  "kind: Telo.Definition",
  "metadata:",
  "  name: Fleet",
  "capability: Telo.Service",
  "schema: { type: object }",
  "resources:",
  "  - !for-each",
  "    metadata: { name: stores }",
  '    in: !cel "self.names"',
  "    as: store",
  "    emit: { kind: Self.Store }",
  "  - !for-each",
  '    in: !cel "self.names"',
  "    as: pick",
  "    emit:",
  "      kind: Self.User",
  '      label: !cel "pick.value"',
  '      store: !ref "stores[pick.index]"',
].join("\n");

function graphOf(text: string): LoadedGraph {
  const file = loadedFile(APP, text, [{ kind: "Telo.Definition", metadata: { name: "Fleet" } }]);
  return {
    rootSource: APP,
    entry: mod(file),
    modules: new Map([[APP, mod(file)]]),
    importEdges: new Map(),
  } as unknown as LoadedGraph;
}

function rename(needle: string, newName: string, occurrence = 0) {
  const pos = at(TEXT, needle, occurrence);
  return buildRename(TEXT, pos.line, pos.character, newName, graphOf(TEXT), APP);
}

describe("rename in a template body", () => {
  it("renames a family's name and the head of every indexed reference to it", () => {
    const result = rename("name: stores", "shops");
    if (!result.ok) throw new Error(result.reason);
    const out = apply(TEXT, result.files[0]!.edits);
    expect(out).toContain("metadata: { name: shops }");
    expect(out).toContain('store: !ref "shops[pick.index]"');
  });

  it("renames the family from the head of an indexed reference", () => {
    const result = rename("!ref \"stores", "shops");
    if (!result.ok) throw new Error(result.reason);
    expect(apply(TEXT, result.files[0]!.edits)).toContain("metadata: { name: shops }");
  });

  it("renames an `as:` and every index and CEL read of it, leaving other loops alone", () => {
    const result = rename("as: pick", "chosen");
    if (!result.ok) throw new Error(result.reason);
    const out = apply(TEXT, result.files[0]!.edits);
    expect(out).toContain("as: chosen");
    expect(out).toContain('label: !cel "chosen.value"');
    expect(out).toContain('store: !ref "stores[chosen.index]"');
    expect(out).toContain("as: store");
  });

  it("renames an `as:` from an index naming it", () => {
    const result = rename("[pick", "chosen");
    if (!result.ok) throw new Error(result.reason);
    expect(apply(TEXT, result.files[0]!.edits)).toContain("as: chosen");
  });
});
