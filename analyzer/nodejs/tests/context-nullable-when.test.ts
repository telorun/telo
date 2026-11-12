import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * An evaluated binding member typed from its referrers
 * (`x-telo-context-from-referrer: request/principal`), and
 * `x-telo-context-nullable-when` deciding where a node may be null: a server's
 * mounts type `request.principal` by their own `authentication`, a router's
 * routes take it and add null where they allow anonymous callers.
 */

const KINDS = `kind: Telo.JsonSchema
metadata: { name: Principal }
schema:
  type: object
  additionalProperties: false
  required: [subject]
  properties: { subject: { type: string } }
---
kind: Telo.Definition
metadata: { name: Server }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  properties:
    mounts:
      type: array
      items:
        type: object
        additionalProperties: false
        x-telo-context:
          type: object
          properties:
            request:
              type: object
              properties:
                principal:
                  $ref: "telo://Self/Principal"
                  x-telo-context-nullable-when: { at: "0/authentication/anonymous", equals: [allow], absent: true }
        properties:
          mount: { x-telo-ref: { kind: Self.Router, use: dependency } }
          authentication:
            type: object
            additionalProperties: false
            properties:
              anonymous: { type: string, enum: [allow, deny], default: deny }
          action: { type: string, x-telo-eval: runtime }
---
kind: Telo.Definition
metadata: { name: Router }
capability: Telo.Mount
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  properties:
    routes:
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          request: { type: object }
          authentication:
            type: object
            additionalProperties: false
            properties:
              anonymous: { type: string, enum: [allow, deny] }
          inputs:
            type: object
            additionalProperties: { x-telo-eval: runtime }
            x-telo-context:
              type: object
              properties:
                request:
                  x-telo-context-from: request/schema
                  type: object
                  properties:
                    path: { type: string }
                    principal:
                      x-telo-context-from-referrer: request/principal
                      type: [object, "null"]
                      x-telo-context-nullable-when: { at: "0/authentication/anonymous", equals: [allow], absent: false }
`;

const ROUTER = (route = "", read = "request.principal.subject") => `---
kind: App.Router
metadata: { name: api }
routes:
  - ${route}inputs: { who: !cel "${read}" }
`;

const SERVER = (name: string, authentication: string | undefined) => `---
kind: App.Server
metadata: { name: ${name} }
mounts:
  - mount: !ref api${authentication === undefined ? "" : `\n    authentication: ${authentication}`}
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

async function diagnostics(body: string, application = "kind: Telo.Application\nmetadata: { name: App }\n", kinds = KINDS) {
  const files = { "/app/telo.yaml": `${application}---\n${kinds}${body}` };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .map((d) => ({ code: d.code, severity: d.severity, name: d.data?.resource?.name, path: d.data?.path, message: d.message }));
}

async function nullableReads(body: string, application?: string) {
  return (await diagnostics(body, application))
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.name, d.path]);
}

const REFUSED = [["CEL_NULLABLE_ACCESS", "api", "routes[0].inputs.who"]];
const ALLOW = "authentication: { anonymous: allow }\n    ";

describe("a member typed from its referrers, nullable where a rule says", () => {
  it("is nullable under a mount without authentication, whatever the route says", async () => {
    expect(await nullableReads(ROUTER() + SERVER("server", undefined))).toEqual(REFUSED);
    expect(await nullableReads(ROUTER(ALLOW) + SERVER("server", undefined))).toEqual(REFUSED);
  });

  it("is non-null under a mount whose anonymous takes its default deny, until the route allows", async () => {
    expect(await nullableReads(ROUTER() + SERVER("server", "{}"))).toEqual([]);
    expect(await nullableReads(ROUTER(ALLOW) + SERVER("server", "{}"))).toEqual(REFUSED);
  });

  it("takes its type from what the referrer's scope holds", async () => {
    expect(await nullableReads(ROUTER("", "request.principal.subjct") + SERVER("server", "{}"))).toEqual([
      ["CEL_UNKNOWN_FIELD", "api", "routes[0].inputs.who"],
    ]);
  });

  it("is non-null under a mount denying anonymous, until the route allows", async () => {
    expect(await nullableReads(ROUTER() + SERVER("server", "{ anonymous: deny }"))).toEqual([]);
    expect(await nullableReads(ROUTER(ALLOW) + SERVER("server", "{ anonymous: deny }"))).toEqual(REFUSED);
  });

  it("is nullable under a mount allowing anonymous", async () => {
    expect(await nullableReads(ROUTER() + SERVER("server", "{ anonymous: allow }"))).toEqual(REFUSED);
    expect(await nullableReads(ROUTER(ALLOW) + SERVER("server", "{ anonymous: allow }"))).toEqual(REFUSED);
  });

  it("reads a computed value as a match", async () => {
    const application = `kind: Telo.Application
metadata: { name: App }
variables:
  mode: { env: MODE, type: string, default: deny }
`;
    const mount = `{ anonymous: !cel "variables.mode" }`;
    expect(await nullableReads(ROUTER() + SERVER("server", mount), application)).toEqual(REFUSED);
  });

  it("is nullable in the configuration a choice allows anonymous in", async () => {
    const application = `kind: Telo.Application
metadata: { name: App }
variables:
  open: { env: OPEN, type: boolean, default: false }
`;
    const choice = `!if
      if: !cel "variables.open"
      then: { anonymous: allow }
      else: { anonymous: deny }`;
    const choiceFree = `!if
      if: !cel "variables.open"
      then: { anonymous: deny }
      else: {}`;
    expect(await nullableReads(ROUTER() + SERVER("server", choice), application)).toEqual(REFUSED);
    expect(await nullableReads(ROUTER() + SERVER("server", choiceFree), application)).toEqual([]);
  });

  it("names the one referrer making it nullable", async () => {
    const found = (await diagnostics(ROUTER() + SERVER("closed", "{}") + SERVER("open", "{ anonymous: allow }"))).filter(
      (d) => d.severity === 1,
    );
    expect(found.map((d) => [d.code, d.name, d.path])).toEqual(REFUSED);
    expect(found[0]!.message).toContain("(as App.Server/open references it)");
  });

  it("keeps the node's own keywords when nothing references the router", async () => {
    expect(await nullableReads(ROUTER())).toEqual(REFUSED);
  });

  it("types the referrer's own expressions from the same region", async () => {
    const server = (authentication: string) => `---
kind: App.Server
metadata: { name: server }
mounts:
  - mount: !ref api
    authentication: ${authentication}
    action: !cel "request.principal.subject"
`;
    expect(await nullableReads(ROUTER() + server("{}"))).toEqual([]);
    expect(await nullableReads(ROUTER() + server("{ anonymous: allow }"))).toEqual([
      ...REFUSED,
      ["CEL_NULLABLE_ACCESS", "server", "mounts[0].action"],
    ]);
  });

  it("keeps a member typed by its own annotation over the map its parent merges", async () => {
    const router = `---
kind: App.Router
metadata: { name: api }
routes:
  - request: { schema: { principal: { type: string } } }
    inputs: { who: !cel "request.principal.subject" }
`;
    expect(await nullableReads(router + SERVER("server", "{}"))).toEqual([]);
  });
});

const BAD_KIND = (context: string, extra = "") => `---
kind: Telo.Definition
metadata: { name: Bad }
capability: Telo.Provider
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  properties:
    mode: { type: string, enum: [a, b] }${extra}
    shown:
      type: object
      x-telo-context:
        type: object
        properties:
${context}
      properties:
        at: { x-telo-eval: runtime }
`;

async function misuse(context: string, extra?: string) {
  return (await diagnostics("", undefined, BAD_KIND(context, extra))).map((d) => [d.code, d.severity, d.path]);
}

describe("misplaced and malformed annotations", () => {
  const where = (node: string, annotation: string) => `schema.properties.shown.x-telo-context.properties.${node}.${annotation}`;

  it("refuses x-telo-context-from-referrer outside a binding's subtree or beside another typing", async () => {
    expect(await misuse("          values: { x-telo-context-from-root: mode, x-telo-context-from-referrer: values }")).toEqual([
      ["CONTEXT_FROM_REFERRER_INVALID", 1, where("values", "x-telo-context-from-referrer")],
    ]);
    expect(await misuse("          values: { type: string }", "\n    loose: { x-telo-context-from-referrer: values }")).toEqual([
      ["CONTEXT_FROM_REFERRER_INVALID", 1, "schema.properties.loose.x-telo-context-from-referrer"],
    ]);
    expect(await misuse("          values: { x-telo-context-from-referrer: values//x }")).toEqual([
      ["SCHEMA_VIOLATION", 1, where("values", "x-telo-context-from-referrer")],
    ]);
  });

  it("accepts it on a member of a binding", async () => {
    expect(
      await misuse("          request:\n            type: object\n            properties:\n              principal: { x-telo-context-from-referrer: request/principal }"),
    ).toEqual([]);
  });

  it("refuses x-telo-context-nullable-when where it decides nothing", async () => {
    const rule = (value: string) => `          values: { type: string, x-telo-context-nullable-when: ${value} }`;
    const nullable = where("values", "x-telo-context-nullable-when");
    expect(await misuse(rule("{ at: '0/mode', equals: [a] }"))).toEqual([["SCHEMA_VIOLATION", 1, nullable]]);
    expect(await misuse(rule("{ at: '0/mode', equals: [], absent: false }"))).toEqual([["SCHEMA_VIOLATION", 1, nullable]]);
    expect(await misuse(rule("{ at: '1/mode', equals: [a], absent: false }"))).toEqual([["CONTEXT_NULLABLE_WHEN_INVALID", 1, nullable]]);
    expect(await misuse(rule("{ at: '0/mood', equals: [a], absent: false }"))).toEqual([["CONTEXT_NULLABLE_WHEN_INVALID", 1, nullable]]);
    expect(await misuse(rule("{ at: '0/mode', equals: [c], absent: false }"))).toEqual([["CONTEXT_NULLABLE_WHEN_INVALID", 1, nullable]]);
    expect(await misuse(rule("{ at: '0/mode', equals: [a], absent: true }"))).toEqual([]);
    expect(
      await misuse("          values: { type: string }", "\n    loose: { x-telo-context-nullable-when: { at: '0/mode', equals: [a], absent: true } }"),
    ).toEqual([["CONTEXT_NULLABLE_WHEN_INVALID", 1, "schema.properties.loose.x-telo-context-nullable-when"]]);
  });
});
