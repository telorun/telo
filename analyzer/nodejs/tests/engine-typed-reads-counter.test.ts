import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The counter of "CEL reads are typed by the engine": no analyzer or
 * templating path reads a schema node beneath a binding handed to the engine
 * except through the engine's resolver or an origin's node — so none of the
 * host walks the engine replaced is left, and the templating analysis is
 * handed no schema of its own to walk.
 */

const ROOTS = ["../src/", "../../../templating/nodejs/src/"].map((dir) => new URL(dir, import.meta.url));

function sources(dir: URL): { path: string; text: string }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = `${entry.parentPath ?? (entry as unknown as { path: string }).path}/${entry.name}`;
      return { path, text: readFileSync(path, "utf8") };
    });
}

/** The host walks over a handed binding's schema that the engine's verdicts replaced. */
const REPLACED_WALKS = [
  "navigateDeclaredChain",
  "declaredChainSchemaAt",
  "explainSchema",
  "chainsRefusedAt",
  "findNullableAccessIssues",
  "nullableValueChain",
  "explainUnknownFields",
  "checkerRejects",
  "registerDeclaredSelf",
  "resultSchemaNode",
];

describe("a schema node beneath a handed binding", () => {
  it("is read by no host walk the engine replaced", () => {
    const found = ROOTS.flatMap(sources).flatMap(({ path, text }) =>
      REPLACED_WALKS.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  it("reaches the templating analysis only as the environment the engine reads", () => {
    const engine = readFileSync(new URL("../../../templating/nodejs/src/engine.ts", import.meta.url), "utf8");
    const analyzeEnv = engine.slice(engine.indexOf("export interface AnalyzeEnv"), engine.indexOf("export interface", engine.indexOf("export interface AnalyzeEnv") + 1));
    expect(analyzeEnv).not.toMatch(/\b(contextSchema|moduleCallResult|explainSchema)\b/);
  });
});
