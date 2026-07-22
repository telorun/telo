import {
  buildDocumentPositions,
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
  };
}

function mod(owner: LoadedFile, partials: LoadedFile[] = []): LoadedModule {
  return { owner, partials };
}

/** Line/character at the middle of the first occurrence of `needle`. */
function at(text: string, needle: string): { line: number; character: number } {
  const idx = text.indexOf(needle) + Math.floor(needle.length / 2);
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
}

describe("buildDefinition", () => {
  it("resolves a local ref to the same-file resource", () => {
    const src = "/app/telo.yaml";
    const text = [
      "kind: Crud.Resource",
      "metadata:",
      "  name: server",
      "connection: !ref Db",
      "---",
      "kind: Sql.Connection",
      "metadata:",
      "  name: Db",
    ].join("\n");
    const file = loadedFile(src, text, [
      { kind: "Crud.Resource", metadata: { name: "server" } },
      { kind: "Sql.Connection", metadata: { name: "Db" } },
    ]);
    const graph = {
      rootSource: src,
      entry: mod(file),
      modules: new Map([[src, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const pos = at(text, "!ref Db".slice("!ref ".length)); // the `Db` target
    const def = buildDefinition(text, pos.line, pos.character, graph, src);
    expect(def?.uri).toBe(src);
    expect(def?.range.start.line).toBe(7); // `  name: Db`
  });

  it("resolves a Self-qualified ref like a local one", () => {
    const src = "/app/telo.yaml";
    const text = ["kind: My.Thing", "metadata:", "  name: a", "peer: !ref Self.a"].join("\n");
    const file = loadedFile(src, text, [{ kind: "My.Thing", metadata: { name: "a" } }]);
    const graph = {
      rootSource: src,
      entry: mod(file),
      modules: new Map([[src, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const pos = at(text, "Self.a");
    const def = buildDefinition(text, pos.line, pos.character, graph, src);
    expect(def?.range.start.line).toBe(2);
  });

  it("resolves an aliased ref across modules via import edges", () => {
    const appSrc = "/app/telo.yaml";
    const storeSrc = "/store/telo.yaml";
    const appText = ["kind: My.App", "metadata:", "  name: app", "db: !ref Store.conn"].join("\n");
    const storeText = [
      "kind: Telo.Library",
      "metadata:",
      "  name: store",
      "---",
      "kind: Sql.Connection",
      "metadata:",
      "  name: conn",
    ].join("\n");
    const appFile = loadedFile(appSrc, appText, [{ kind: "My.App", metadata: { name: "app" } }]);
    const storeFile = loadedFile(storeSrc, storeText, [
      { kind: "Telo.Library", metadata: { name: "store" } },
      { kind: "Sql.Connection", metadata: { name: "conn" } },
    ]);
    const graph = {
      rootSource: appSrc,
      entry: mod(appFile),
      modules: new Map([
        [appSrc, mod(appFile)],
        [storeSrc, mod(storeFile)],
      ]),
      importEdges: new Map([
        [appSrc, new Map([["Store", { targetSource: storeSrc, targetModuleName: "store", targetNamespace: null }]])],
      ]),
    } as unknown as LoadedGraph;

    const pos = at(appText, "Store.conn");
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(6); // `  name: conn`
  });

  it("returns undefined off a ref (on a plain value)", () => {
    const src = "/app/telo.yaml";
    const text = ["kind: My.Thing", "metadata:", "  name: a"].join("\n");
    const file = loadedFile(src, text, [{ kind: "My.Thing", metadata: { name: "a" } }]);
    const graph = {
      rootSource: src,
      entry: mod(file),
      modules: new Map([[src, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const pos = at(text, "My.Thing");
    expect(buildDefinition(text, pos.line, pos.character, graph, src)).toBeUndefined();
  });
});
