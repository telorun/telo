import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { pathTemplateParams } from "../src/context-from-path-template.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-context-from-path-template` — a page's `params` is the variables of
 * its own path, and a view a page places reads them through
 * `x-telo-context-from-referrer: params`.
 */

const KINDS = `kind: Telo.Definition
metadata:
  name: Page
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    path: { type: string }
    children:
      type: array
      x-telo-context:
        type: object
        properties:
          params: { x-telo-context-from-path-template: "0/path" }
      items:
        type: object
        additionalProperties: false
        properties:
          text: { x-telo-eval: runtime }
          view: { x-telo-ref: { kind: Self.View, use: dependency } }
---
kind: Telo.Definition
metadata:
  name: View
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    text:
      x-telo-eval: runtime
      x-telo-context:
        type: object
        properties:
          params: { x-telo-context-from-referrer: params, type: object, additionalProperties: { type: string } }
    inner:
      x-telo-ref: { kind: Self.View, use: dependency }
      x-telo-context:
        type: object
        properties:
          params: { x-telo-context-from-referrer: params, type: object, additionalProperties: { type: string } }
`;

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

async function findings(files: Record<string, string>, entry = "/app/telo.yaml") {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.resource?.name, d.data?.path, d.message] as const);
}

const app = (body: string) => ({
  "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS}${body}`,
});

const page = (name: string, path: string | undefined, child: string) => `---
kind: App.Page
metadata: { name: ${name} }
${path === undefined ? "" : `path: ${path}\n`}children:
  - ${child}
`;

describe("x-telo-context-from-path-template", () => {
  it("types the node as a closed object with one required string per variable", () => {
    const own = { description: "The page's variables.", "x-telo-context-from-path-template": "0/path" };
    expect(pathTemplateParams(own, "/plans/{id}/rev/{seq}")).toEqual({
      description: "The page's variables.",
      type: "object",
      properties: { id: { type: "string" }, seq: { type: "string" } },
      required: ["id", "seq"],
      additionalProperties: false,
    });
  });

  it("refuses a read of a variable the page's path lacks", async () => {
    const found = await findings(
      app(page("plan", "/plans/{id}", `text: !cel "params.id + params.idd"`)),
    );
    expect(found.map(([code, name, path]) => [code, name, path])).toEqual([["CEL_UNKNOWN_FIELD", "plan", "children[0].text"]]);
  });

  it("leaves params an open map of strings where the page holds no path", async () => {
    expect(await findings(app(page("plan", undefined, `text: !cel "params.anything + 'x'"`)))).toEqual([]);
  });

  it("types a view placed by two pages under each, naming the page lacking the variable", async () => {
    const found = await findings(
      app(`${page("plan", "/plans/{id}", "view: !ref shared")}${page("home", "/", "view: !ref shared")}---
kind: App.View
metadata: { name: shared }
text: !cel "params.id"
`),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.slice(0, 3)).toEqual(["CEL_UNKNOWN_FIELD", "shared", "text"]);
    expect(found[0]![3]).toContain("(as App.Page/home references it)");
  });

  it("follows a library's chain of exported views to the page placing it", async () => {
    const files = (path: string) => ({
      "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: Lib, version: 0.1.0 }
exports:
  kinds: [Page, View]
  resources: [outer, deep]
---
${KINDS}---
kind: Self.View
metadata: { name: outer }
inner: !ref deep
---
kind: Self.View
metadata: { name: deep }
text: !cel "params.id"
`,
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
imports:
  Lib: ../lib/telo.yaml
---
kind: Lib.Page
metadata: { name: plan }
path: ${path}
children:
  - view: !ref Lib.outer
`,
    });
    expect(await findings(files("/plans/{id}"))).toEqual([]);
    const found = await findings(files("/plans"));
    expect(found.map(([code, name, path]) => [code, name, path])).toEqual([["CEL_UNKNOWN_FIELD", "plan", "children[0].view"]]);
  });

  it("leaves params an open map of strings for a view no page places", async () => {
    expect(await findings(app(`---
kind: App.View
metadata: { name: lonely }
text: !cel "params.whatever + 'x'"
`))).toEqual([]);
  });

  it("refuses the annotation where it types nothing", async () => {
    const kind = (binding: string, extra = "") => ({
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.Definition
metadata: { name: Bad }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  properties:
    path: { type: integer }
    title: { type: string }
    children:
      type: array
      x-telo-context:
        type: object
        properties:
          params: ${binding}
      items: { x-telo-eval: runtime }${extra}
`,
    });
    const codes = async (binding: string, extra?: string) =>
      (await findings(kind(binding, extra))).map(([code, , path]) => [code, path]);
    const at = "schema.properties.children.x-telo-context.properties.params.x-telo-context-from-path-template";
    expect(await codes(`{ x-telo-context-from-path-template: path }`)).toEqual([["SCHEMA_VIOLATION", at]]);
    expect(await codes(`{ x-telo-context-from-path-template: "0/nope" }`)).toEqual([["CONTEXT_FROM_PATH_TEMPLATE_INVALID", at]]);
    expect(await codes(`{ x-telo-context-from-path-template: "0/path" }`)).toEqual([["CONTEXT_FROM_PATH_TEMPLATE_INVALID", at]]);
    expect(await codes(`{ x-telo-context-from-path-template: "0/title", x-telo-context-from-root: title }`)).toEqual([
      ["CONTEXT_FROM_PATH_TEMPLATE_INVALID", at],
    ]);
    expect(await codes(`{}`, `\n    loose: { type: object, x-telo-context-from-path-template: "0/title" }`)).toEqual([
      ["CONTEXT_FROM_PATH_TEMPLATE_INVALID", "schema.properties.loose.x-telo-context-from-path-template"],
    ]);
    expect(await codes(`{ x-telo-context-from-path-template: "0/title" }`)).toEqual([]);
  });
});
