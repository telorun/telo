import {
  AnalysisRegistry,
  buildDocumentPositions,
  NO_MIGRATIONS,
  parseToAst,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildDefinition } from "../src/definition/build-definition.js";

/**
 * Go-to-declaration for a CEL context binding.
 *
 * `request.query` is not reached through any reference slot — it exists because
 * an `x-telo-context-from` annotation merged the route's OWN `request.schema`
 * into scope. The claim under test is that the jump is driven by that
 * annotation and by nothing kind-specific, and that a binding the author never
 * declared resolves to nothing rather than to a guessed node.
 */

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

function mod(owner: LoadedFile): LoadedModule {
  return { owner, partials: [] };
}

/** Line/character inside `token`, located within the `occurrence`-th match of
 *  `context`. Two-part because these chains repeat their own identifiers — a
 *  cursor "somewhere in `query.lastEventId`" lands on whichever one the offset
 *  math happens to reach, which is not a test of anything. */
function at(
  text: string,
  context: string,
  token: string,
  occurrence = 0,
): { line: number; character: number } {
  let found = -1;
  for (let i = 0; i <= occurrence; i++) found = text.indexOf(context, found + 1);
  const idx = found + context.indexOf(token) + 1;
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
}

/** An `Http.Api`-shaped kind: routes[] whose `inputs` types `request` from the
 *  route's own `request/schema`, exactly as the standard library declares it. */
const API_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "test-http" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            request: { type: "object" },
            inputs: {
              type: "object",
              additionalProperties: true,
              "x-telo-eval": "runtime",
              "x-telo-context": {
                type: "object",
                properties: {
                  request: {
                    "x-telo-context-from": "request/schema",
                    type: "object",
                    properties: { query: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const TEXT = [
  "kind: Http.Api",
  "metadata:",
  "  name: api",
  "routes:",
  "  - request:",
  "      schema:",
  "        query:",
  "          type: object",
  "          properties:",
  "            lastEventId:",
  "              type: string",
  '    inputs:',
  '      fromId: !cel "request.query.lastEventId"',
].join("\n");

const MANIFEST: ResourceManifest = {
  kind: "Http.Api",
  metadata: { name: "api", module: "test-http" },
  routes: [
    {
      request: {
        schema: {
          query: {
            type: "object",
            properties: { lastEventId: { type: "string" } },
          },
        },
      },
      inputs: { fromId: { __cel: "request.query.lastEventId" } },
    },
  ],
} as unknown as ResourceManifest;

function setup(text = TEXT, manifest = MANIFEST) {
  const src = "/app/telo.yaml";
  const file = loadedFile(src, text, [manifest]);
  const graph = {
    rootSource: src,
    entry: mod(file),
    modules: new Map([[src, mod(file)]]),
    importEdges: new Map(),
  } as unknown as LoadedGraph;

  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-http");
  registry.registerImport("Http", "test-http", ["Api"]);
  registry.registerDefinition(API_DEF);
  return { src, text, graph, query: registry.analysisOf([manifest]) };
}

describe("CEL context binding navigation", () => {
  it("navigates request.query to the route's own request.schema.query", () => {
    const { src, text, graph, query } = setup();
    const pos = at(text, "request.query.lastEventId", "query");
    const def = buildDefinition(text, pos.line, pos.character, graph, src, undefined, query);
    expect(def?.uri).toBe(src);
    // `        query:` — the declaration inside the route's request schema.
    expect(def?.range.start.line).toBe(6);
  });

  it("navigates a deeper member to its own property declaration", () => {
    const { src, text, graph, query } = setup();
    const pos = at(text, "request.query.lastEventId", "lastEventId");
    const def = buildDefinition(text, pos.line, pos.character, graph, src, undefined, query);
    expect(def?.range.start.line).toBe(9); // `            lastEventId:`
  });

  it("resolves nothing for a binding the route never declared", () => {
    // `body` is one of the annotation's static fallback properties, so it types
    // but has no site in this file — jumping into the kind's own schema for a
    // name the author never wrote would be more surprising than a no-op.
    const text = TEXT.replace("request.query.lastEventId", "request.body");
    const manifest = JSON.parse(JSON.stringify(MANIFEST)) as ResourceManifest;
    (manifest as any).routes[0].inputs.fromId = { __cel: "request.body" };
    const { src, graph, query } = setup(text, manifest);
    const pos = at(text, "request.body", "body");
    expect(buildDefinition(text, pos.line, pos.character, graph, src, undefined, query)).toBeUndefined();
  });

  it("resolves nothing without a scope query", () => {
    const { src, text, graph } = setup();
    const pos = at(text, "request.query.lastEventId", "query");
    expect(buildDefinition(text, pos.line, pos.character, graph, src)).toBeUndefined();
  });
});
