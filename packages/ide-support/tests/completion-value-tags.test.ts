import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";
import type { IdeEnvironmentAdapter, ModuleEntry } from "../src/types.js";

/**
 * Tag completion at a value (`field: !|`) and path completion under a tag
 * naming a module location (`!module-path ./|`).
 *
 * Which tags a field takes is the rule studio's schema form applies: a tag's
 * produced type must fit the field, and a tag deciding what evaluation does
 * needs a field that is evaluated.
 */

const THING: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Thing", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      greeting: { type: "string", "x-telo-eval": "runtime" },
      when: { type: "boolean", "x-telo-eval": "runtime" },
      key: { "x-telo-type": "Telo.Bytes" },
      root: { type: "string", "x-telo-type": "Telo.HostPath" },
      size: { anyOf: [{ type: "integer" }, { "x-telo-type": "Telo.Bytes" }] },
      keys: { type: "array", items: { "x-telo-type": "Telo.Bytes" } },
      handler: { "x-telo-ref": { kind: "Telo.Invocable", use: "call" } },
    },
  },
} as unknown as ResourceDefinition;

const HOLDER: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Holder", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { inner: { "x-telo-ref": { kind: "Self.Thing", use: "call" } } },
  },
} as unknown as ResourceDefinition;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test");
  r.registerImport("Test", "test", ["Thing", "Holder"]);
  r.registerDefinition(THING);
  r.registerDefinition(HOLDER);
  return r;
}

const HEAD = ["kind: Test.Thing", "metadata:", "  name: thing"];

/** Completion with the cursor at the end of the last line. */
async function complete(lines: string[], reg = registry(), adapter?: IdeEnvironmentAdapter) {
  const last = lines.length - 1;
  return buildCompletions(lines.join("\n"), last, lines[last]!.length, reg, adapter);
}

async function tagsAt(line: string): Promise<string[]> {
  return (await complete([...HEAD, line])).map((r) => r.label);
}

describe("tag completion", () => {
  it("offers only the embeds and the path at a field that is not evaluated", async () => {
    expect(await tagsAt("text: !")).toEqual(["!include-text", "!module-path"]);
  });

  it("offers the expression tags at an evaluated string field", async () => {
    expect(await tagsAt("greeting: !")).toEqual([
      "!cel",
      "!include-text",
      "!interpolate",
      "!literal",
      "!module-path",
    ]);
  });

  it("keeps a string-producing tag off an evaluated boolean", async () => {
    expect(await tagsAt("when: !")).toEqual(["!cel"]);
  });

  it("offers the byte embed alone at a bytes field", async () => {
    expect(await tagsAt("key: !")).toEqual(["!include-bytes"]);
  });

  it("offers !module-path alone where a host path is required", async () => {
    expect(await tagsAt("root: !")).toEqual(["!module-path"]);
  });

  it("compares against a union field's branches, not their merge", async () => {
    expect(await tagsAt("size: !")).toEqual(["!include-bytes"]);
  });

  it("reads a sequence item's schema from the field's items", async () => {
    expect(await complete([...HEAD, "keys:", "  - !"])).toMatchObject([
      { label: "!include-bytes" },
    ]);
  });

  it("offers !ref alone at a reference slot", async () => {
    expect(await tagsAt("handler: !")).toEqual(["!ref"]);
  });

  it("resolves a field of an inline resource against its own kind", async () => {
    const results = await complete([
      "kind: Test.Holder",
      "metadata:",
      "  name: holder",
      "inner:",
      "  kind: Test.Thing",
      "  greeting: !",
    ]);
    expect(results.map((r) => r.label)).toContain("!interpolate");
  });

  it("offers every tag where the kind is unknown", async () => {
    const labels = (await complete(["kind: Nope.Thing", "field: !"])).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["!cel", "!interpolate", "!module-path", "!ref"]));
  });

  it("replaces the typed tag, and leads into a path when nothing follows", async () => {
    const results = await complete([...HEAD, "root: !mo"]);
    expect(results.find((r) => r.label === "!module-path")).toMatchObject({
      insertText: "!module-path ",
      retrigger: true,
      replaceRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 9 } },
    });
  });

  it("inserts the tag alone in front of an existing value", async () => {
    const text = [...HEAD, "root: !mo ./public"].join("\n");
    const results = await buildCompletions(text, 3, "root: !mo".length, registry());
    expect(results.find((r) => r.label === "!module-path")).toMatchObject({
      insertText: "!module-path",
      retrigger: false,
    });
  });
});

describe("module path completion", () => {
  function adapter(listing: Record<string, ModuleEntry[]>, asked: string[] = []): IdeEnvironmentAdapter {
    return {
      listDirectories: async () => [],
      hasManifest: async () => false,
      searchRefs: async () => [],
      listVersionsForRef: async () => [],
      listModuleEntries: async (relPath) => {
        asked.push(relPath);
        return listing[relPath] ?? [];
      },
    };
  }

  const ROOT: ModuleEntry[] = [
    { name: "telo.yaml", directory: false },
    { name: "public", directory: true },
    { name: ".env", directory: false },
  ];

  it("lists the module root, directories first, dot-entries hidden", async () => {
    const asked: string[] = [];
    const results = await complete([...HEAD, "root: !module-path "], registry(), adapter({ ".": ROOT }, asked));
    expect(asked).toEqual(["."]);
    expect(results.map((r) => [r.label, r.insertText])).toEqual([
      ["public/", "public"],
      ["telo.yaml", "telo.yaml"],
    ]);
  });

  it("keeps the typed directory on every insertion", async () => {
    const results = await complete([...HEAD, "root: !module-path ./pu"], registry(), adapter({ "./": ROOT }));
    expect(results.map((r) => r.insertText)).toEqual(["./public"]);
  });

  it("descends through a directory where the tag names a file", async () => {
    const results = await complete([...HEAD, "text: !include-text pu"], registry(), adapter({ ".": ROOT }));
    expect(results).toMatchObject([{ insertText: "public/", retrigger: true }]);
  });

  it("lists dot-entries once the typed name starts with a dot", async () => {
    const results = await complete([...HEAD, "text: !include-text ."], registry(), adapter({ ".": ROOT }));
    expect(results.map((r) => r.label)).toEqual([".env"]);
  });

  it("offers nothing above the module root or for an absolute path", async () => {
    const asked: string[] = [];
    const a = adapter({}, asked);
    expect(await complete([...HEAD, "root: !module-path ../"], registry(), a)).toEqual([]);
    expect(await complete([...HEAD, "root: !module-path /etc/"], registry(), a)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
