import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-catches-for: { slot, raises }` — the codes a kind raises into a catch
 * list itself: nameable and typed there and on every list above it on the scope
 * ladder, owed by no site.
 */

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

/** A catch list's schema at `indent` spaces, rendering what `catchesFor` names. */
const catchList = (indent: number, catchesFor: string) =>
  [
    "type: array",
    "x-telo-outcome-list: catches",
    `x-telo-catches-for: ${catchesFor}`,
    "x-telo-context:",
    "  type: object",
    "  additionalProperties: false",
    "  properties:",
    "    error:",
    "      type: object",
    "      additionalProperties: false",
    "      properties:",
    "        code: { type: string, x-telo-caught-member: code }",
    "        data: { type: object, additionalProperties: true, x-telo-caught-member: data }",
    "items:",
    "  type: object",
    "  additionalProperties: false",
    "  properties: { when: { type: boolean }, status: { type: integer }, body: {} }",
  ]
    .map((line) => " ".repeat(indent) + line)
    .join("\n");

const REFUSED = `throws:
  codes:
    ERR_REFUSED:
      description: The transport refused the request.
      data: { type: object, required: [reason], properties: { reason: { type: string } } }`;

const kinds = (routeRaises = "[ERR_REFUSED]", fieldRaises = "[ERR_REFUSED]") => `---
kind: Telo.Definition
metadata: { name: Server }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#Server]
${REFUSED}
schema:
  type: object
  properties:
    mounts:
      type: array
      items:
        type: object
        properties:
          mount: { x-telo-ref: { kind: Telo.Mount, use: dependency, throwsThrough: true } }
          guarded: { type: object, x-telo-raises: [ERR_REFUSED] }
    catches:
${catchList(6, '{ slot: "", raises: [ERR_REFUSED] }')}
---
kind: Telo.Definition
metadata: { name: Router }
capability: Telo.Mount
controllers: [pkg:telo/local/js?path=./x.mjs#Router]
${REFUSED}
schema:
  type: object
  properties:
    catches:
${catchList(6, '""')}
    routes:
      type: array
      items:
        type: object
        properties:
          handler: { x-telo-ref: { kind: Telo.Invocable, use: trigger.inbound } }
          guarded: { type: object, x-telo-raises: ${fieldRaises} }
          catches:
${catchList(12, `{ slot: handler, raises: ${routeRaises} }`)}
---
kind: Telo.Definition
metadata: { name: Endpoint }
capability: Telo.Mount
controllers: [pkg:telo/local/js?path=./x.mjs#Endpoint]
throws:
  codes:
    ERR_ENDPOINT_REFUSED:
      description: The endpoint refused the call.
      data: { type: object, required: [reason], properties: { reason: { type: string } } }
schema:
  type: object
  properties:
    tools:
      type: array
      items:
        type: object
        properties:
          handler: { x-telo-ref: { kind: Telo.Invocable, use: trigger.inbound } }
          guarded: { type: object, x-telo-raises: [ERR_ENDPOINT_REFUSED] }
          catches:
${catchList(12, "{ slot: handler, raises: [ERR_ENDPOINT_REFUSED] }")}
---
kind: Telo.Definition
metadata: { name: Lookup }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#Lookup]
throws:
  codes:
    ORDER_NOT_FOUND:
      description: No such order.
      data: { type: object, required: [id], properties: { id: { type: string } } }
schema: { type: object, properties: {} }
---
kind: Shop.Lookup
metadata: { name: lookup }
`;

async function findings(body: string, definitions = kinds(), root = "kind: Telo.Application\nmetadata: { name: Shop }") {
  const url = "/app/telo.yaml";
  const text = `${root}
${definitions}${body}`;
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, (d.data as { path?: string }).path] as const);
}

const router = (routeCatches: string, routerCatches = "", route = "") => `---
kind: Shop.Router
metadata: { name: orders }
${routerCatches}routes:
  - handler: !ref lookup
${route}    catches:
${routeCatches}
`;

const server = (serverCatches: string) => `---
kind: Shop.Server
metadata: { name: server }
mounts: [{ mount: !ref orders }]
${serverCatches}`;

const entry = (when: string, body = "error.code") => `      - when: !cel "${when}"
        status: 401
        body: !cel "${body}"`;

const CATCH_ALL = `      - status: 500`;

describe("codes raised into a catch list", () => {
  it("may be named and are typed in the list they are raised into", async () => {
    expect(
      await findings(router(`${entry("error.code == 'ERR_REFUSED'", "error.data.reason")}\n${CATCH_ALL}`) + server("")),
    ).toEqual([]);
    expect(
      await findings(router(`${entry("error.code == 'ERR_REFUSED'", "error.data.reasn")}\n${CATCH_ALL}`) + server("")),
    ).toEqual([["CEL_UNKNOWN_FIELD", "routes[0].catches[0].body"]]);
  });

  it("are owed by no site", async () => {
    expect(await findings(router(entry("error.code == 'ORDER_NOT_FOUND'")) + server(""))).toEqual([]);
  });

  it("may be named on every list above the one they are raised into", async () => {
    const routerList = `catches:\n${entry("error.code == 'ERR_REFUSED'", "error.data.reason")}\n`;
    const serverList = `catches:\n${entry("error.code in ['ERR_REFUSED', 'ERR_ENDPOINT_REFUSED']")}\n`;
    const endpoint = `---
kind: Shop.Endpoint
metadata: { name: tools }
tools:
  - handler: !ref lookup
    catches: [{ status: 500 }]
`;
    expect(
      await findings(
        router(entry("error.code == 'ORDER_NOT_FOUND'"), routerList) +
          endpoint +
          `---
kind: Shop.Server
metadata: { name: server }
mounts: [{ mount: !ref orders }, { mount: !ref tools }]
${serverList}`,
      ),
    ).toEqual([]);
  });

  it("are not nameable where nothing raises them", async () => {
    expect(
      await findings(router(entry("error.code == 'ERR_ENDPOINT_REFUSED'")) + server("")),
    ).toEqual([
      ["UNDECLARED_THROW_CODE", "routes[0].catches[0].when"],
      ["UNCOVERED_THROW_CODE", "routes[0].catches"],
    ]);
  });
});

describe("the object form refused at the kind", () => {
  it("refuses a raised code the kind does not declare", async () => {
    expect(await findings("", kinds("[ERR_REFUSED, ERR_ELSEWHERE]"))).toEqual([
      [
        "CATCHES_FOR_INVALID",
        "schema.properties.routes.items.properties.catches.x-telo-catches-for.raises[1]",
      ],
    ]);
  });

  it("refuses the object form on a list that is not a catch list", async () => {
    const misplaced = kinds().replace(
      "    routes:\n      type: array\n",
      "    routes:\n      type: array\n      x-telo-catches-for: { slot: handler, raises: [ERR_REFUSED] }\n",
    );
    expect(await findings("", misplaced)).toEqual([
      ["CATCHES_FOR_INVALID", "schema.properties.routes.x-telo-catches-for"],
    ]);
  });
});

describe("where raised codes type a catch-all", () => {
  const catchAll = `      - status: 500\n        body: !cel "error.data.id"`;
  const named = `      - when: !cel "error.code == 'ORDER_NOT_FOUND'"\n        status: 404\n        body: !cel "error.data.id"`;
  const mounted = (mount: string) => `---
kind: Shop.Server
metadata: { name: server }
mounts: [{ mount: !ref orders${mount} }]
`;

  it("is typed by the handler alone where nothing raises", async () => {
    expect(await findings(router(catchAll) + mounted(""))).toEqual([]);
  });

  it("joins the codes a route's own field raises", async () => {
    expect(await findings(router(catchAll, "", "    guarded: {}\n") + mounted(""))).toEqual([
      ["CEL_UNKNOWN_FIELD", "routes[0].catches[0].body"],
    ]);
    expect(await findings(router(named, "", "    guarded: {}\n") + mounted(""))).toEqual([]);
  });

  it("joins the codes a mount entry raises into everything it mounts", async () => {
    expect(await findings(router(catchAll) + mounted(", guarded: {}"))).toEqual([
      ["CEL_UNKNOWN_FIELD", "routes[0].catches[0].body"],
    ]);
  });

  it("joins every code a list declares where an importer may mount it", async () => {
    const library = "kind: Telo.Library\nmetadata: { name: Shop }\nexports: { resources: [orders] }";
    expect(await findings(router(catchAll), kinds(), library)).toEqual([["CEL_UNKNOWN_FIELD", "routes[0].catches[0].body"]]);
  });

  it("types another module's mount kind by its two annotations alone", async () => {
    const endpoint = (tool: string) => `---
kind: Shop.Endpoint
metadata: { name: tools }
tools:
  - handler: !ref lookup
${tool}    catches:
${catchAll}
---
kind: Shop.Server
metadata: { name: server }
mounts: [{ mount: !ref tools }]
`;
    expect(await findings(endpoint(""))).toEqual([]);
    expect(await findings(endpoint("    guarded: {}\n"))).toEqual([["CEL_UNKNOWN_FIELD", "tools[0].catches[0].body"]]);
  });

  it("refuses a raised code that is no code or that the kind does not declare", async () => {
    expect(await findings("", kinds("[ERR_REFUSED]", "[ERR_REFUSED, ERR_ELSEWHERE, nope]"))).toEqual([
      ["RAISES_INVALID", "schema.properties.routes.items.properties.guarded.x-telo-raises[1]"],
      ["RAISES_INVALID", "schema.properties.routes.items.properties.guarded.x-telo-raises[2]"],
    ]);
  });
});
