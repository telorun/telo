import {
  buildDocumentPositions,
  NO_MIGRATIONS,
  parseToAst,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildDefinition } from "../src/definition/build-definition.js";

/** Minimal LoadedFile from source text + hand-written manifests (aligned to the
 *  `---`-separated documents). Positions come from the real analyzer builder, so
 *  ranges match what the extension sees. */
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

/** Line/character at the middle of the `occurrence`-th match of `needle`. */
function at(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let found = -1;
  for (let i = 0; i <= occurrence; i++) found = text.indexOf(needle, found + 1);
  const idx = found + Math.floor(needle.length / 2);
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
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
  '      store: !ref "stores[pick.index]"',
].join("\n");

describe("go-to-definition on an indexed !ref", () => {
  const file = loadedFile(APP, TEXT, [{ kind: "Telo.Definition", metadata: { name: "Fleet" } }]);
  const graph = {
    rootSource: APP,
    entry: mod(file),
    modules: new Map([[APP, mod(file)]]),
    importEdges: new Map(),
  } as unknown as LoadedGraph;
  const lineOf = (needle: string) => TEXT.slice(0, TEXT.indexOf(needle)).split("\n").length - 1;

  it("takes the head to the family's name and a binding to the loop's `as:`", () => {
    const head = at(TEXT, "stores[pick");
    expect(buildDefinition(TEXT, head.line, head.character - 1, graph, APP)?.range.start.line).toBe(lineOf("name: stores"));
    const binding = at(TEXT, "pick.index");
    expect(buildDefinition(TEXT, binding.line, binding.character, graph, APP)?.range.start.line).toBe(lineOf("as: pick"));
  });
});

