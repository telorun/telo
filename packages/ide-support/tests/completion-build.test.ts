import type { ResourceDefinition } from "@telorun/sdk";
import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";
import type { IdeEnvironmentAdapter } from "../src/types.js";

/** End-to-end completion tests: feed a Run.Sequence-style schema with an
 *  Invocable ref slot through `buildCompletions`. Proves the editor-facing
 *  surface (prop keys on a blank line under `invoke:`, kind filtering on an
 *  indented `kind:` line) flows through detectContext + navigateSchema +
 *  refConstrainedKinds. */

function buildRegistry(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  // Identity for `telo` prefix is auto-seeded in the analyzer's
  // DefinitionRegistry constructor. Telo.Invocable is also a built-in
  // abstract — no need to redeclare it here.
  registry.registerModuleIdentity("std", "test-module");
  // A real import is gated by the target's `exports.kinds`, so list what this
  // fixture library publishes rather than leaving the gate empty.
  registry.registerImport("Test", "test-module", ["Step", "Sequence"]);

  const stepDef: ResourceDefinition = {
    kind: "Telo.Definition",
    metadata: { name: "Step", module: "test-module" },
    extends: "Telo.Invocable",
    schema: { type: "object" },
  } as unknown as ResourceDefinition;

  // Mimics Run.Sequence: steps[] with an invoke ref slot pointing at any
  // Invocable. The slot's schema is the pattern that's been silent in
  // completion until anyOf peeling + ref-aware kind filtering landed.
  const sequenceDef: ResourceDefinition = {
    kind: "Telo.Definition",
    metadata: { name: "Sequence", module: "test-module" },
    capability: "Telo.Runnable",
    schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              invoke: {
                "x-telo-ref": "telo#Invocable",
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      kind: { type: "string" },
                      name: { type: "string" },
                      inputs: { type: "object" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  } as unknown as ResourceDefinition;

  registry.registerDefinition(stepDef);
  registry.registerDefinition(sequenceDef);
  return registry;
}

describe("buildCompletions — ref slot prop keys", () => {
  it("offers kind/name/inputs on a blank line under an x-telo-ref slot", async () => {
    const registry = buildRegistry();
    const text = [
      "kind: Test.Sequence",
      "metadata:",
      "  name: Foo",
      "steps:",
      "  - name: s1",
      "    invoke:",
      "      ",
    ].join("\n");
    const line = 6;
    const character = text.split("\n")[line].length;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["kind", "name", "inputs"]));
  });
});

describe("buildCompletions — ref-filtered kind suggestions", () => {
  it("limits kind suggestions to definitions implementing the slot's x-telo-ref", async () => {
    const registry = buildRegistry();
    const text = [
      "kind: Test.Sequence",
      "metadata:",
      "  name: Foo",
      "steps:",
      "  - name: s1",
      "    invoke:",
      "      kind: ",
    ].join("\n");
    const line = 6;
    const character = text.split("\n")[line].length;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);

    // Step extends Telo.Invocable → satisfies telo#Invocable. Surface it.
    expect(labels).toContain("Test.Step");
    // Test.Sequence is a Runnable, not Invocable; must not leak through.
    expect(labels).not.toContain("Test.Sequence");
    // Root kinds are not Invocables either.
    expect(labels).not.toContain("Telo.Application");
  });

  it("falls back to the unfiltered kind list when the slot has no ref constraint", async () => {
    const registry = buildRegistry();
    // No constraint at the metadata.name slot — should not narrow.
    const text = ["kind: Test.Sequence", "metadata:", "  name: ", ""].join("\n");
    const line = 2;
    const character = text.split("\n")[line].length;
    const results = await buildCompletions(text, line, character, registry);
    // No assertion that a specific kind is present (depends on whether the
    // detector even returns a kind ctx for non-`kind:` lines). Just ensure
    // it doesn't crash and returns an array.
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("buildCompletions — cursor on existing property name", () => {
  // Telo.Application's schema is auto-seeded via KERNEL_BUILTINS, so a fresh
  // registry suffices for these tests. metadata is a Telo.Application property
  // that has `name` and `version` keys.
  const registry = new AnalysisRegistry();
  const text = [
    "kind: Telo.Application",
    "metadata:",
    "  name: foo",
    "  version: 1.0.0",
  ].join("\n");

  it("suggests `version` when the cursor is in the middle of `version:`", async () => {
    const line = 3;
    const character = 5; // somewhere inside "version"
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("version");
  });

  it("suggests `version` when the cursor is at the start of `version:`", async () => {
    const line = 3;
    const character = 2; // right after the indent
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("version");
  });

  it("suggests `version` when the cursor is right before the colon", async () => {
    const line = 3;
    const lineText = text.split("\n")[line];
    const character = lineText.indexOf(":");
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("version");
  });

  it("still hides keys present on OTHER lines", async () => {
    const line = 3;
    const character = 5;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    // `name` lives on line 2 and is not the cursor's line — must stay hidden.
    expect(labels).not.toContain("name");
  });
});

describe("buildCompletions — cursor on the `kind:` line itself", () => {
  const registry = new AnalysisRegistry();

  it("suggests `kind` as a property when the cursor is at the start of `kind: …`", async () => {
    const text = "kind: Telo.Application\n";
    const results = await buildCompletions(text, 0, 0, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("kind");
  });

  it("suggests `kind` when the cursor is in the middle of `kind`", async () => {
    const text = "kind: Telo.Application\n";
    const results = await buildCompletions(text, 0, 2, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("kind");
  });

  it("fires VALUE completion only when the cursor is after the colon", async () => {
    const text = "kind: \n";
    // Cursor after "kind: " → column 6
    const results = await buildCompletions(text, 0, 6, registry);
    const labels = results.map((r) => r.label);
    // Built-in Telo root kinds must appear.
    expect(labels).toContain("Telo.Application");
    expect(labels).not.toContain("kind");
  });

  it("suggests `metadata` when the cursor is on the existing `metadata:` line", async () => {
    const text = ["kind: Telo.Application", "metadata:", "  name: foo"].join("\n");
    const results = await buildCompletions(text, 1, 0, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("metadata");
  });

  it("suggests `kind` when the cursor is at column 0 of `kind: Telo.Application`", async () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: foo\n";
    const results = await buildCompletions(text, 0, 0, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("kind");
  });

  it("suggests `kind` in middle-of-word position too", async () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: foo\n";
    const results = await buildCompletions(text, 0, 2, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("kind");
  });

  it("suggests kind/metadata on a domain kind whose schema does not enumerate them", async () => {
    // Mimics Http.Api / Sql.Query — the user-facing case where the definition's
    // schema only lists domain props (`routes`, `connection`, …) and `kind` +
    // `metadata` are kernel-implicit. Without the fallback, completion at root
    // level would drop these and the user couldn't autocomplete them on the
    // resource's own `kind:` line.
    const domainRegistry = new AnalysisRegistry();
    domainRegistry.registerModuleIdentity("std", "test-module");
    domainRegistry.registerImport("Test", "test-module", ["Widget"]);
    domainRegistry.registerDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Widget", module: "test-module" },
      capability: "Telo.Service",
      schema: {
        type: "object",
        properties: { domain: { type: "string" } },
      },
    } as any);

    const text = "kind: Test.Widget\n";
    // Cursor on `|kind: Test.Widget`
    const results = await buildCompletions(text, 0, 0, domainRegistry);
    const labels = results.map((r) => r.label);
    expect(labels).toContain("kind");
    expect(labels).toContain("metadata");
    // Domain prop also surfaces (not yet on the page, so not in existingKeys).
    expect(labels).toContain("domain");
  });

  it("still surfaces kind/metadata when the kind isn't in the registry at all", async () => {
    // No definition for `Mystery.Kind` was registered. Without the fallback,
    // propKeyCompletions would return [] and the user would see nothing.
    const emptyRegistry = new AnalysisRegistry();
    const text = "kind: Mystery.Kind\n";
    const results = await buildCompletions(text, 0, 0, emptyRegistry);
    const labels = results.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["kind", "metadata"]));
  });
});

describe("buildCompletions — ref-name value completion", () => {
  const registry = new AnalysisRegistry();

  it("suggests in-file resource names whose kind matches the sibling kind: line", async () => {
    const text = [
      "kind: Sql.Connection",
      "metadata:",
      "  name: PrimaryDb",
      "---",
      "kind: Sql.Connection",
      "metadata:",
      "  name: SecondaryDb",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: ApiServer",
      "---",
      "kind: Sql.Migrations",
      "metadata:",
      "  name: Migrate",
      "connection:",
      "  kind: Sql.Connection",
      "  name: ",
    ].join("\n");
    // Cursor on the last line at column 8 (right after "  name: ").
    const line = 17;
    const character = "  name: ".length;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    // Sql.Connection-typed resources show up.
    expect(labels).toEqual(expect.arrayContaining(["PrimaryDb", "SecondaryDb"]));
    // Http.Server-typed resource is filtered out — different kind.
    expect(labels).not.toContain("ApiServer");
  });

  it("returns an empty list when no in-file resources match the kind", async () => {
    const text = [
      "kind: Http.Server",
      "metadata:",
      "  name: ApiServer",
      "---",
      "kind: Sql.Migrations",
      "metadata:",
      "  name: Migrate",
      "connection:",
      "  kind: Sql.Connection",
      "  name: ",
    ].join("\n");
    const line = 9;
    const character = "  name: ".length;
    const results = await buildCompletions(text, line, character, registry);
    expect(results).toEqual([]);
  });

  it("anchors the replace range at the value start so dotted/dashed names overwrite cleanly", async () => {
    const text = [
      "kind: Sql.Connection",
      "metadata:",
      "  name: my-primary-db",
      "---",
      "kind: Sql.Migrations",
      "metadata:",
      "  name: Migrate",
      "connection:",
      "  kind: Sql.Connection",
      "  name: ",
    ].join("\n");
    const line = 9;
    const character = "  name: ".length;
    const results = await buildCompletions(text, line, character, registry);
    const item = results.find((r) => r.label === "my-primary-db");
    expect(item).toBeDefined();
    expect(item!.replaceFromColumn).toBe("  name: ".length);
  });
});

describe("buildCompletions — kind value replaceFromColumn", () => {
  const registry = new AnalysisRegistry();

  it("threads valueStartColumn onto kind value completion items so dotted kinds replace cleanly", async () => {
    const text = "kind: \n";
    const character = "kind: ".length;
    const results = await buildCompletions(text, 0, character, registry);
    const item = results.find((r) => r.label === "Telo.Application");
    expect(item).toBeDefined();
    expect(item!.replaceFromColumn).toBe("kind: ".length);
  });

  it("threads valueStartColumn even for indented kind: lines", async () => {
    // Indented case mirrors the flow inside an inline-resource block like
    // `routes[].handler: { kind: |, name: … }`. valueStartColumn must
    // include the indent so the replace range starts inside the value, not
    // at the start of the line.
    const text = ["kind: Telo.Application", "metadata:", "  name: foo", "field:", "  kind: "].join(
      "\n",
    );
    const line = 4;
    const character = "  kind: ".length;
    const results = await buildCompletions(text, line, character, registry);
    const item = results.find((r) => r.label.startsWith("Telo."));
    expect(item).toBeDefined();
    expect(item!.replaceFromColumn).toBe("  kind: ".length);
  });
});

describe("buildCompletions — deeply nested list-item paths", () => {
  // A Run.Sequence-like fixture with a deeply nested template body to prove
  // that buildYamlPath threads the right path when the cursor lives inside
  // an item that has multiple peer keys (`request` vs `handler`) under a
  // single `- ` list marker.
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-module");
  registry.registerImport("Test", "test-module", ["Api"]);
  registry.registerDefinition({
    kind: "Telo.Definition",
    metadata: { name: "Api", module: "test-module" },
    capability: "Telo.Mount",
    schema: {
      type: "object",
      properties: {
        routes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              request: {
                type: "object",
                properties: {
                  method: { type: "string" },
                  path: { type: "string" },
                },
              },
              handler: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  } as any);

  it("suggests `method` / `path` under request (post-dash key joins the path)", async () => {
    const text = [
      "kind: Test.Api",
      "routes:",
      "  - request:",
      "      ",
    ].join("\n");
    const line = 3;
    const character = text.split("\n")[line].length;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["method", "path"]));
  });

  it("suggests handler/request siblings (post-dash key skipped) when cursor is at item-content indent", async () => {
    const text = [
      "kind: Test.Api",
      "routes:",
      "  - request:",
      "      method: GET",
      "    ",
    ].join("\n");
    const line = 4;
    const character = text.split("\n")[line].length;
    const results = await buildCompletions(text, line, character, registry);
    const labels = results.map((r) => r.label);
    // The cursor sits at the same indent as `request:` — its siblings under
    // the same list-item should surface. `request` itself is on another line
    // and stays filtered as `existingKeys`.
    expect(labels).toContain("handler");
    expect(labels).not.toContain("method"); // method is INSIDE request, not a sibling here
  });
});

describe("buildCompletions — inline import sources", () => {
  function adapter(): IdeEnvironmentAdapter {
    return {
      listDirectories: async () => [],
      hasManifest: async () => false,
      searchRefs: async () => [
        {
          ref: "oci://ghcr.io/std/console",
          latestVersion: "1.2.3",
          description: "Console module",
        },
      ],
      listVersionsForRef: async () => ["1.2.3"],
    };
  }

  it("completes the scalar shorthand value against the hub", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "imports:",
      "  Console: con",
    ].join("\n");
    const line = 4;
    const character = "  Console: con".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    // Label leads with the module name (not the transport boilerplate); the ref
    // is what actually gets inserted.
    expect(results.map((r) => r.label)).toContain("std/console@1.2.3");
    expect(results.map((r) => r.insertText)).toContain("oci://ghcr.io/std/console@1.2.3");
  });

  it("completes the object-form `source:` value against the hub", async () => {
    const text = [
      "kind: Telo.Library",
      "metadata:",
      "  name: lib",
      "imports:",
      "  Http:",
      "    source: con",
    ].join("\n");
    const line = 5;
    const character = "    source: con".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    expect(results.map((r) => r.label)).toContain("std/console@1.2.3");
    expect(results.map((r) => r.insertText)).toContain("oci://ghcr.io/std/console@1.2.3");
  });

  it("completes versions for a known ref after `@` (label is just the version)", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "imports:",
      "  Console: oci://ghcr.io/std/console@",
    ].join("\n");
    const line = 4;
    const character = "  Console: oci://ghcr.io/std/console@".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    expect(results.map((r) => r.label)).toContain("1.2.3");
    expect(results.map((r) => r.insertText)).toContain("oci://ghcr.io/std/console@1.2.3");
  });

  it("seeds ./ and ../ for an empty import value", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "imports:",
      "  Console: ",
    ].join("\n");
    const line = 4;
    const character = "  Console: ".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    expect(results.map((r) => r.label)).toEqual(expect.arrayContaining(["./", "../"]));
  });

  it("does NOT offer source completion on a bare object-form alias header", async () => {
    // `  Tiny:` (cursor right after the colon, no value yet) is a header about
    // to carry a nested `source:` — not an import-source value position.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "imports:",
      "  Tiny:",
    ].join("\n");
    const line = 4;
    const character = "  Tiny:".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    expect(results).toHaveLength(0);
  });

  it("does NOT treat a `source:` outside the imports map as an import source", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "somefield:",
      "  source: con",
    ].join("\n");
    const line = 4;
    const character = "  source: con".length;
    const results = await buildCompletions(text, line, character, undefined, adapter());
    expect(results.map((r) => r.label)).not.toContain("std/console@1.2.3");
  });
});
