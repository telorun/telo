import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildSemanticTokens } from "../src/semantic-tokens/build-semantic-tokens.js";
import type { SemanticToken } from "../src/types.js";

/**
 * Colouring the inside of a CEL body.
 *
 * The claim under test is that this is SCOPE-AWARE — a name the resolved scope
 * confirms is coloured and one it cannot is left alone, which no grammar can
 * decide. The syntactic fallback is tested too: with no scope query a CEL body
 * must still not read as a plain string.
 */

const HANDLER_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Handler", module: "test-app" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        "x-telo-eval": "runtime",
        "x-telo-context": {
          type: "object",
          properties: {
            request: {
              type: "object",
              properties: { method: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", module: "test-app" },
  variables: { greeting: { env: "GREETING", type: "string" } },
} as unknown as ResourceManifest;

function handlerManifest(body: string): ResourceManifest {
  return {
    kind: "Test.Handler",
    metadata: { name: "handler", module: "test-app" },
    url: { __cel: body },
  } as unknown as ResourceManifest;
}

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-app");
  r.registerImport("Test", "test-app", ["Handler"]);
  r.registerDefinition(HANDLER_DEF);
  return r;
}

const DOC = (body: string): string =>
  ["kind: Test.Handler", "metadata:", "  name: handler", `url: !cel "${body}"`].join("\n");

/** The token covering `needle`'s position on the `url:` line. */
function tokenFor(text: string, tokens: SemanticToken[], needle: string): SemanticToken | undefined {
  const lines = text.split("\n");
  const line = lines.findIndex((l) => l.startsWith("url:"));
  const character = lines[line].indexOf(needle);
  return tokens.find((t) => t.line === line && t.character === character);
}

function tokensFor(body: string, scoped: boolean): { text: string; tokens: SemanticToken[] } {
  const text = DOC(body);
  const r = registry();
  const query = scoped ? r.analysisOf([APP, handlerManifest(body)]) : undefined;
  return { text, tokens: buildSemanticTokens(text, r, undefined, query) };
}

describe("CEL semantic tokens", () => {
  it("colours a confirmed root as a namespace and its member as a property", () => {
    const { text, tokens } = tokensFor("request.method", true);
    expect(tokenFor(text, tokens, "request")?.type).toBe("namespace");
    expect(tokenFor(text, tokens, "method")?.type).toBe("property");
  });

  it("leaves a name the scope cannot confirm uncoloured", () => {
    const { text, tokens } = tokensFor("request.nope", true);
    expect(tokenFor(text, tokens, "request")?.type).toBe("namespace");
    expect(tokenFor(text, tokens, "nope")).toBeUndefined();
  });

  it("leaves an unknown root uncoloured", () => {
    const { text, tokens } = tokensFor("bogus.method", true);
    expect(tokenFor(text, tokens, "bogus")).toBeUndefined();
  });

  it("colours the module's declared variables", () => {
    const { text, tokens } = tokensFor("variables.greeting", true);
    expect(tokenFor(text, tokens, "variables")?.type).toBe("namespace");
    expect(tokenFor(text, tokens, "greeting")?.type).toBe("property");
  });

  it("colours literals, calls and operators regardless of scope", () => {
    const { text, tokens } = tokensFor("size(request.method) + 1", true);
    expect(tokenFor(text, tokens, "size")?.type).toBe("function");
    expect(tokenFor(text, tokens, "+")?.type).toBe("operator");
    expect(tokenFor(text, tokens, "1")?.type).toBe("number");
  });

  it("colours names syntactically when no scope query is supplied", () => {
    // The pre-analysis case: a CEL body must never read as a plain string.
    const { text, tokens } = tokensFor("bogus.whatever", false);
    expect(tokenFor(text, tokens, "bogus")?.type).toBe("namespace");
    expect(tokenFor(text, tokens, "whatever")?.type).toBe("property");
  });

  it("emits nothing for a body that does not parse", () => {
    const { text, tokens } = tokensFor("request.", true);
    expect(tokens.filter((t) => t.line === text.split("\n").length - 1)).toEqual([]);
  });
});
