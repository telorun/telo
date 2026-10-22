import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import {
  browserExportAnnotationProblems,
  browserExportProblems,
  browserExportSites,
} from "../src/browser-export-slot.js";
import { readBrowserEntries } from "../src/module-browser.js";
import { importReach } from "../src/reaching-import.js";
import { validateLibraryBrowserExports } from "../src/validate-library-browser-exports.js";

const kindSchema = (annotation: Record<string, unknown>) => ({
  type: "object",
  properties: {
    entry: { type: "string" },
    export: { type: "string", "x-telo-browser-export": annotation },
  },
});

const entries = readBrowserEntries({
  exports: {
    browser: [
      { specifier: "@acme/ui", path: "./ui.js", abi: "ui-1", external: ["react", "react-dom"], exports: ["Pill"] },
      { specifier: "@acme/bare", path: "./bare.js", exports: ["Pill"] },
    ],
  },
}).entries;

const problemsFor = (annotation: Record<string, unknown>, entry: string) =>
  browserExportProblems(browserExportSites(kindSchema(annotation), { entry, export: "Pill" }), entries).map(
    (problem) => [problem.code, problem.path],
  );

describe("a named browser entry, against what the annotated field accepts", () => {
  it("refuses an entry written against a generation the field does not accept, or none", () => {
    const annotation = { entry: "/entry", abi: ["ui_react_controls-1"] };
    expect(problemsFor(annotation, "@acme/ui")).toEqual([["BROWSER_ENTRY_ABI_UNSUPPORTED", "entry"]]);
    expect(problemsFor(annotation, "@acme/bare")).toEqual([["BROWSER_ENTRY_ABI_UNSUPPORTED", "entry"]]);
    expect(problemsFor({ entry: "/entry", abi: ["ui-1"] }, "@acme/ui")).toEqual([]);
  });

  it("refuses an entry leaving to its host a specifier the field does not supply", () => {
    const [problem] = browserExportProblems(
      browserExportSites(kindSchema({ entry: "/entry", external: ["react"] }), {
        entry: "@acme/ui",
        export: "Pill",
      }),
      entries,
    );
    expect(problem).toEqual({
      code: "BROWSER_ENTRY_IMPORT_UNSUPPLIED",
      path: "entry",
      message: expect.stringContaining(
        "names a browser entry that leaves 'react-dom' to its host (its 'external'), and this field supplies only 'react'",
      ),
    });
    expect(problemsFor({ entry: "/entry", external: ["react", "react-dom", "scheduler"] }, "@acme/ui")).toEqual([]);
  });
});

describe("several fields naming one entry", () => {
  it("report a problem with the entry once, at the field naming it", () => {
    const schema = {
      type: "object",
      properties: {
        entry: { type: "string" },
        implements: {
          type: "array",
          items: {
            type: "string",
            "x-telo-browser-export": { entry: "/entry", abi: ["ui_react_controls-1"], external: ["react"] },
          },
        },
      },
    };
    const problems = browserExportProblems(
      browserExportSites(schema, { entry: "@acme/ui", implements: ["Pill", "Menu", "Bogus"] }),
      entries,
    ).map((problem) => [problem.code, problem.path]);
    expect(problems).toEqual([
      ["BROWSER_ENTRY_ABI_UNSUPPORTED", "entry"],
      ["BROWSER_ENTRY_IMPORT_UNSUPPLIED", "entry"],
      ["BROWSER_EXPORT_UNKNOWN", "implements[1]"],
      ["BROWSER_EXPORT_UNKNOWN", "implements[2]"],
    ]);
  });
});

describe("the annotation's own shape", () => {
  it("refuses an entry that is no pointer, a malformed abi or external, and a key nothing reads", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", "x-telo-browser-export": { entry: "entry" } },
        b: { type: "string", "x-telo-browser-export": { entry: "/entry", abi: ["ui"] } },
        c: { type: "string", "x-telo-browser-export": { entry: "/entry", abi: [] } },
        d: { type: "string", "x-telo-browser-export": { entry: "/entry", external: [""] } },
        e: { type: "string", "x-telo-browser-export": { entry: "/entry", abis: ["ui-1"] } },
        f: { type: "string", "x-telo-browser-export": "/entry" },
      },
      $defs: {
        ok: { type: "string", "x-telo-browser-export": { entry: "/entry", abi: ["ui-1"], external: [] } },
      },
    };
    expect(browserExportAnnotationProblems("Component", schema).map((problem) => problem.path)).toEqual([
      "schema.properties.a.x-telo-browser-export.entry",
      "schema.properties.b.x-telo-browser-export.abi",
      "schema.properties.c.x-telo-browser-export.abi",
      "schema.properties.d.x-telo-browser-export.external",
      "schema.properties.e.x-telo-browser-export",
      "schema.properties.f.x-telo-browser-export",
    ]);
  });
});

describe("an imported library's resources", () => {
  const importDoc = (owner: string, alias: string, target: string, source: string) =>
    ({
      kind: "Telo.Import",
      metadata: { name: alias, module: owner, source: `file:///${owner}/telo.yaml`, resolvedModuleName: target, resolvedSource: source },
    }) as unknown as ResourceManifest;
  const libraryAt = (sourceId: string, specifier: string) => ({
    module: "Lib",
    sourceId,
    exportedNames: [],
    manifests: [
      {
        kind: "Telo.Library",
        metadata: { name: "Lib", module: "Lib" },
        exports: { browser: [{ specifier, path: "./own.js", exports: ["Own"] }] },
      },
      { kind: "Kinds.Widget", metadata: { name: "widget", module: "Lib" }, entry: "@lib/own", export: "Missing" },
    ] as unknown as ResourceManifest[],
  });

  it("are judged against the library's own entries, once, at the entry's import first reaching it", () => {
    const manifests = [
      { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest,
      importDoc("App", "First", "Wrap", "file:///wrap/telo.yaml"),
      importDoc("App", "Second", "Lib", "file:///lib-2/telo.yaml"),
      importDoc("Wrap", "Inner", "Lib", "file:///lib-2/telo.yaml"),
    ];
    const diagnostics = validateLibraryBrowserExports({
      // Lib 1 is a version reconciliation replaced: it declares no '@lib/own'.
      libraries: [libraryAt("file:///lib-1/telo.yaml", "@lib/other"), libraryAt("file:///lib-2/telo.yaml", "@lib/own")],
      rootModules: new Set(["App"]),
      reach: importReach(manifests, new Set(["App"])),
      declarationsOf: (library) => library.manifests,
      kindSchemaOf: () => kindSchema({ entry: "/entry" }),
    });
    expect(diagnostics.map((d) => [d.code, d.data?.path, d.message])).toEqual([
      [
        "BROWSER_EXPORT_UNKNOWN",
        "imports.First",
        "Imported library 'Lib', reached through import 'First': Kinds.Widget/widget: 'export: Missing' " +
          "is not an export the browser entry '@lib/own' declares. It declares 'Own'.",
      ],
    ]);
  });
});
