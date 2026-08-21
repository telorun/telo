import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";
import { buildHover } from "../src/hover/build-hover.js";

/**
 * CEL language features, end to end through the shared scope rule.
 *
 * The load-bearing claim these guard is that completion, hover and the checker
 * answer from ONE resolution: every candidate and every tooltip below comes out
 * of `AnalysisRegistry.analysisOf`, the same `CelScopeResolver` the analysis
 * pass runs per expression.
 */

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", module: "test-app" },
  variables: {
    greeting: { env: "GREETING", type: "string" },
    retries: { env: "RETRIES", type: "integer" },
  },
} as unknown as ResourceManifest;

function handlerDef(): ResourceDefinition {
  return {
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
                properties: {
                  method: { type: "string", description: "The HTTP method." },
                  path: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ResourceDefinition;
}

function handler(url: string): ResourceManifest {
  return {
    kind: "Test.Handler",
    metadata: { name: "handler", module: "test-app" },
    url: { __cel: url },
  } as unknown as ResourceManifest;
}

function setup(url: string): {
  registry: AnalysisRegistry;
  manifests: ResourceManifest[];
} {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-app");
  registry.registerImport("Test", "test-app", ["Handler"]);
  registry.registerDefinition(handlerDef());
  return { registry, manifests: [APP, handler(url)] };
}

const DOC = (body: string): string =>
  `kind: Telo.Application
metadata:
  name: TestApp
---
kind: Test.Handler
metadata:
  name: handler
url: !cel "${body}"
`;

/** Line/character of the cursor, placed at `|` in the document. */
function cursorAt(text: string): { text: string; line: number; character: number } {
  const offset = text.indexOf("|");
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return {
    text: text.slice(0, offset) + text.slice(offset + 1),
    line: lines.length - 1,
    character: lines[lines.length - 1].length,
  };
}

describe("CEL completion", () => {
  it("offers the scope's root names, including the context's own bindings", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("re|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    const labels = results.map((r) => r.label);
    expect(labels).toContain("request");
    expect(labels).toContain("variables");
  });

  it("offers a context property's members after a dot", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("request.|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    expect(results.map((r) => r.label).sort()).toEqual(["method", "path"]);
    expect(results.find((r) => r.label === "method")?.detail).toBe("string");
  });

  it("offers the module's declared variables, typed", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("variables.|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    const labels = results.map((r) => r.label).sort();
    expect(labels).toEqual(["greeting", "retries"]);
    expect(results.find((r) => r.label === "retries")?.detail).toBe("integer");
  });

  it("offers nothing rather than a guess where the scope declares no shape", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("request.method.|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    expect(results).toEqual([]);
  });

  it("offers one candidate per function, not one per overload", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("do|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    // `double` is registered once per accepted argument list; four identical
    // labels are four things the author cannot choose between.
    const doubles = results.filter((r) => r.label === "double");
    expect(doubles).toHaveLength(1);
    // The overloads it folded in are reported, not dropped.
    expect(doubles[0].detail).toMatch(/\(\+\d+ overloads\)/);
    expect(doubles[0].documentation).toContain("double(");
  });

  it("offers a name that is both a CEL type and a conversion function once", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("do|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    // `double` is registered as a variable of type `type` AND as the conversion
    // function; the callable form wins the slot and records the other reading.
    expect(results.filter((r) => r.label === "double")).toHaveLength(1);
    expect(results.find((r) => r.label === "double")?.documentation).toContain("CEL type");
  });

  it("emits no duplicate labels at a root position", async () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("re|"));
    const results = await buildCompletions(
      text,
      line,
      character,
      registry,
      undefined,
      undefined,
      registry.analysisOf(manifests),
    );
    const labels = results.map((r) => r.label);
    expect(labels).toHaveLength(new Set(labels).size);
  });

  it("stays silent without a scope query — a candidate list must be a claim", async () => {
    const { registry } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("request.|"));
    const results = await buildCompletions(text, line, character, registry);
    expect(results).toEqual([]);
  });
});

describe("CEL hover", () => {
  it("reports the type of the identifier under the cursor", () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("request.met|hod"));
    const hover = buildHover(
      text,
      line,
      character,
      registry,
      undefined,
      registry.analysisOf(manifests),
    );
    expect(hover?.contents).toContain("method");
    expect(hover?.contents).toContain("string");
    expect(hover?.contents).toContain("The HTTP method.");
  });

  it("describes the chain PREFIX when the cursor is on it, not the tail", () => {
    const { registry, manifests } = setup("request.method");
    const { text, line, character } = cursorAt(DOC("requ|est.method"));
    const hover = buildHover(
      text,
      line,
      character,
      registry,
      undefined,
      registry.analysisOf(manifests),
    );
    expect(hover?.contents).toContain("request");
    expect(hover?.contents).not.toContain("The HTTP method.");
  });
});
