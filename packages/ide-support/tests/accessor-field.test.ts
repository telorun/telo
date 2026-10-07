import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/**
 * What an editor offers at a field its kind marks `x-telo-eval: accessor`.
 *
 * Such a field names a value for the resource's consumer and is never
 * evaluated: `telo check` accepts one `!cel` plain chain rooted at a binding
 * the field's context declares, and refuses everything else there
 * (`ACCESSOR_NOT_PLAIN_CHAIN`). An offer is a claim the checker will accept it.
 */

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", module: "test-app" },
  variables: { greeting: { env: "GREETING", type: "string" } },
} as unknown as ResourceManifest;

const COLUMN: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Column", module: "test-app" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: {
      value: {
        "x-telo-eval": "accessor",
        "x-telo-context": {
          type: "object",
          properties: {
            row: {
              type: "object",
              properties: { title: { type: "string" }, isDone: { type: "boolean" } },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-app");
  r.registerImport("Test", "test-app", ["Column"]);
  r.registerDefinition(COLUMN);
  return r;
}

const HEAD = ["kind: Test.Column", "metadata:", "  name: column"];

/** Completion with the cursor at `|`. */
async function labelsAt(lines: string[], manifests?: ResourceManifest[]): Promise<string[]> {
  const reg = registry();
  const marked = lines.join("\n");
  const offset = marked.indexOf("|");
  const before = marked.slice(0, offset).split("\n");
  const results = await buildCompletions(
    marked.slice(0, offset) + marked.slice(offset + 1),
    before.length - 1,
    before[before.length - 1]!.length,
    reg,
    undefined,
    undefined,
    manifests ? reg.analysisOf(manifests) : undefined,
  );
  return results.map((r) => r.label);
}

const column = (value: unknown): ResourceManifest =>
  ({ kind: "Test.Column", metadata: { name: "column", module: "test-app" }, value }) as unknown as ResourceManifest;

describe("an accessor field", () => {
  it("takes !cel as its whole value, and no tag beneath it", async () => {
    expect(await labelsAt([...HEAD, "value: !|"])).toEqual(["!cel"]);
    expect(await labelsAt([...HEAD, "value:", "  label: !|"])).toEqual([]);
  });

  it("completes its bindings and their members, and nothing else in scope", async () => {
    const manifests = [APP, column({ __cel: "row.title" })];
    // No catalog function, no `variables`, no module name.
    expect(await labelsAt([...HEAD, 'value: !cel "|"'], manifests)).toEqual(["row"]);
    expect((await labelsAt([...HEAD, 'value: !cel "row.|"'], manifests)).sort()).toEqual([
      "isDone",
      "title",
    ]);
    expect(await labelsAt([...HEAD, 'value: !cel "variables.|"'], manifests)).toEqual([]);
  });
});
