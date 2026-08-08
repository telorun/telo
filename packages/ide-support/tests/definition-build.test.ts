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

/** Line/character at the middle of the `occurrence`-th match of `needle`. */
function at(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let found = -1;
  for (let i = 0; i <= occurrence; i++) found = text.indexOf(needle, found + 1);
  const idx = found + Math.floor(needle.length / 2);
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
}

/** The store's `exports:` block, as both source lines and the parsed value the
 *  manifest projection carries. Parameterized because the gate's three states —
 *  listed, empty, absent — are what navigation has to agree with the kernel
 *  about, and they are not interchangeable. */
interface StoreExports {
  lines: string[];
  value?: Record<string, unknown>;
}

const LISTED_EXPORTS: StoreExports = {
  lines: ["exports:", "  kinds:", "    - Thing", "  resources:", "    - conn"],
  value: { kinds: ["Thing"], resources: ["conn"] },
};

/** An app importing a library that exports one kind and one instance — the
 *  shape every cross-module jump (ref, kind, CEL) is resolved against. */
function twoModuleGraph(storeExports: StoreExports = LISTED_EXPORTS) {
  const appSrc = "/app/telo.yaml";
  const storeSrc = "/store/telo.yaml";
  const appText = [
    "kind: Telo.Application",
    "metadata:",
    "  name: App",
    "imports:",
    "  Store: ../store",
    "variables:",
    "  greeting:",
    "    env: GREETING",
    "    type: string",
    "---",
    "kind: Store.Thing",
    "metadata:",
    "  name: app",
    "db: !ref Store.conn",
    'message: !cel "variables.greeting"',
    'peer: !cel "resources.Store.conn"',
  ].join("\n");
  const storeText = [
    "kind: Telo.Library",
    "metadata:",
    "  name: store",
    ...storeExports.lines,
    "---",
    "kind: Telo.Definition",
    "metadata:",
    "  name: Thing",
    "capability: Telo.Service",
    "---",
    "kind: Sql.Connection",
    "metadata:",
    "  name: conn",
  ].join("\n");

  const appFile = loadedFile(appSrc, appText, [
    { kind: "Telo.Application", metadata: { name: "App" }, imports: { Store: "../store" } },
    { kind: "Store.Thing", metadata: { name: "app" } },
  ]);
  const storeFile = loadedFile(storeSrc, storeText, [
    {
      kind: "Telo.Library",
      metadata: { name: "store" },
      ...(storeExports.value ? { exports: storeExports.value } : {}),
    },
    { kind: "Telo.Definition", metadata: { name: "Thing" }, capability: "Telo.Service" },
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
      [
        appSrc,
        new Map([
          [
            "Store",
            {
              targetSource: storeSrc,
              targetRef: "../store",
              targetModuleName: "store",
              targetNamespace: null,
            },
          ],
        ]),
      ],
    ]),
  } as unknown as LoadedGraph;

  return { appSrc, appText, storeSrc, storeText, graph };
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
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph();

    const pos = at(appText, "conn");
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(16); // `  name: conn`
  });

  it("resolves a ref's alias half to the import that declares it", () => {
    const { appSrc, appText, graph } = twoModuleGraph();

    const pos = at(appText, "Store.conn"); // mid-token → the alias half
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(appSrc);
    expect(def?.range.start.line).toBe(4); // `  Store: ../store`
  });

  it("resolves a kind suffix to the Telo.Definition that registers it", () => {
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph();

    const pos = at(appText, "Thing"); // `kind: Store.Thing`
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(11); // `  name: Thing`
  });

  it("resolves a kind's alias half to the import that declares it", () => {
    const { appSrc, appText, graph } = twoModuleGraph();

    const pos = at(appText, "Store.Thing"); // mid-token → the alias half
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(appSrc);
    expect(def?.range.start.line).toBe(4); // `  Store: ../store`
  });

  it("skips a Telo built-in kind, which has no manifest", () => {
    const { appSrc, appText, graph } = twoModuleGraph();

    const pos = at(appText, "Application"); // `kind: Telo.Application`
    expect(buildDefinition(appText, pos.line, pos.character, graph, appSrc)).toBeUndefined();
  });

  it("resolves a CEL scope root to its declaration block", () => {
    const { appSrc, appText, graph } = twoModuleGraph();

    const pos = at(appText, "variables", 1); // inside the `!cel`, not the block
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(appSrc);
    expect(def?.range.start.line).toBe(5); // `variables:`
  });

  it("resolves a CEL scope member to its declared entry", () => {
    const { appSrc, appText, graph } = twoModuleGraph();

    const pos = at(appText, "greeting", 1); // inside the `!cel`
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(appSrc);
    expect(def?.range.start.line).toBe(6); // `  greeting:`
  });

  it("resolves a CEL scope root nested inside a call", () => {
    const { appSrc, appText, graph } = twoModuleGraph();
    // A chain that isn't the expression root — the walk has to descend past the
    // call before it finds one it can flatten.
    const text = appText.replace(
      '!cel "variables.greeting"',
      '!cel "string(variables.greeting)"',
    );

    const pos = at(text, "variables", 1);
    const def = buildDefinition(text, pos.line, pos.character, graph, appSrc);
    expect(def?.range.start.line).toBe(5); // `variables:`
  });

  it("resolves a CEL resources chain across an import", () => {
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph();

    const pos = at(appText, "conn", 1); // `resources.Store.conn`
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(16); // `  name: conn`
  });

  it("treats an empty exports.kinds as a gate that exports nothing", () => {
    // `[]` and an absent block are NOT the same: the kernel gates on the former
    // and is permissive for the latter, so navigating here would claim a wiring
    // `telo check` rejects.
    const { appSrc, appText, graph } = twoModuleGraph({
      lines: ["exports:", "  kinds: []", "  resources: []"],
      value: { kinds: [], resources: [] },
    });

    const pos = at(appText, "Thing");
    expect(buildDefinition(appText, pos.line, pos.character, graph, appSrc)).toBeUndefined();
  });

  it("leaves kinds ungated when the module declares no exports block", () => {
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph({ lines: [] });

    const pos = at(appText, "Thing");
    expect(buildDefinition(appText, pos.line, pos.character, graph, appSrc)?.uri).toBe(storeSrc);
  });

  it("exports no instance when the module declares no exports.resources", () => {
    // Unlike kinds, `exports.resources` has no permissive default — the kernel
    // reads `?? []`, so an absent block exports nothing.
    const { appSrc, appText, graph } = twoModuleGraph({
      lines: ["exports:", "  kinds:", "    - Thing"],
      value: { kinds: ["Thing"] },
    });

    const pos = at(appText, "conn");
    expect(buildDefinition(appText, pos.line, pos.character, graph, appSrc)).toBeUndefined();
  });

  it("resolves a quoted x-telo-ref value without its quotes", () => {
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph();
    const text = [
      appText,
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Wrapper",
      "schema:",
      "  properties:",
      "    target:",
      '      x-telo-ref: "Store.Thing"',
    ].join("\n");

    const pos = at(text, "Thing", 1); // inside the quoted annotation value
    const def = buildDefinition(text, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(11); // `  name: Thing`
  });

  it("resolves the kind inside a structured x-telo-ref annotation", () => {
    const { appSrc, appText, storeSrc, graph } = twoModuleGraph();
    const text = [
      appText,
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Wrapper",
      "schema:",
      "  properties:",
      "    target:",
      "      x-telo-ref:",
      "        kind: Store.Thing",
      "        use: dependency",
    ].join("\n");

    const pos = at(text, "Thing", 1); // the kind NAME inside the structured form
    const def = buildDefinition(text, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(storeSrc);
    expect(def?.range.start.line).toBe(11); // `  name: Thing`
  });

  it("ignores extends outside a definition doc's top level", () => {
    const { appSrc, appText, graph } = twoModuleGraph();
    // A data field that happens to be named `extends` is not a kind slot.
    const text = appText.replace("db: !ref Store.conn", "config:\n  extends: Store.Thing");

    const pos = at(text, "Thing", 1); // occurrence 0 is the doc's own `kind:`
    expect(buildDefinition(text, pos.line, pos.character, graph, appSrc)).toBeUndefined();
  });

  it("follows a kind re-exported from an ungated module", () => {
    // A gated wrapper over an already-published, ungated module: `wrap` lists
    // `Inner.Thing`, and `inner` declares no `exports.kinds` at all. The kernel
    // allows it, so navigation has to land on `inner`'s definition.
    const appSrc = "/app/telo.yaml";
    const wrapSrc = "/wrap/telo.yaml";
    const innerSrc = "/inner/telo.yaml";
    const appText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Wrap: ../wrap",
      "---",
      "kind: Wrap.Thing",
      "metadata:",
      "  name: app",
    ].join("\n");
    const wrapText = [
      "kind: Telo.Library",
      "metadata:",
      "  name: wrap",
      "imports:",
      "  Inner: ../inner",
      "exports:",
      "  kinds:",
      "    - Inner.Thing",
    ].join("\n");
    const innerText = [
      "kind: Telo.Library",
      "metadata:",
      "  name: inner",
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Thing",
      "capability: Telo.Service",
    ].join("\n");

    const appFile = loadedFile(appSrc, appText, [
      { kind: "Telo.Application", metadata: { name: "App" }, imports: { Wrap: "../wrap" } },
      { kind: "Wrap.Thing", metadata: { name: "app" } },
    ]);
    const wrapFile = loadedFile(wrapSrc, wrapText, [
      {
        kind: "Telo.Library",
        metadata: { name: "wrap" },
        imports: { Inner: "../inner" },
        exports: { kinds: ["Inner.Thing"] },
      },
    ]);
    const innerFile = loadedFile(innerSrc, innerText, [
      { kind: "Telo.Library", metadata: { name: "inner" } },
      { kind: "Telo.Definition", metadata: { name: "Thing" }, capability: "Telo.Service" },
    ]);
    const edge = (targetSource: string, targetModuleName: string) => ({
      targetSource,
      targetRef: targetSource,
      targetModuleName,
      targetNamespace: null,
    });
    const graph = {
      rootSource: appSrc,
      entry: mod(appFile),
      modules: new Map([
        [appSrc, mod(appFile)],
        [wrapSrc, mod(wrapFile)],
        [innerSrc, mod(innerFile)],
      ]),
      importEdges: new Map([
        [appSrc, new Map([["Wrap", edge(wrapSrc, "wrap")]])],
        [wrapSrc, new Map([["Inner", edge(innerSrc, "inner")]])],
      ]),
    } as unknown as LoadedGraph;

    const pos = at(appText, "Thing");
    const def = buildDefinition(appText, pos.line, pos.character, graph, appSrc);
    expect(def?.uri).toBe(innerSrc);
    expect(def?.range.start.line).toBe(6); // `  name: Thing`
  });

  it("returns undefined off a navigable symbol (on a resource name)", () => {
    const src = "/app/telo.yaml";
    const text = ["kind: My.Thing", "metadata:", "  name: a"].join("\n");
    const file = loadedFile(src, text, [{ kind: "My.Thing", metadata: { name: "a" } }]);
    const graph = {
      rootSource: src,
      entry: mod(file),
      modules: new Map([[src, mod(file)]]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const pos = at(text, "name: a");
    expect(buildDefinition(text, pos.line, pos.character, graph, src)).toBeUndefined();
  });
});
