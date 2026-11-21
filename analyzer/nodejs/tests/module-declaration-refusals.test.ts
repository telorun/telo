import { describe, expect, it } from "vitest";
import { importResolutionDiagnostics } from "../src/import-resolution-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import { MODULE_DECLARATION_MISSING_MESSAGE } from "../src/module-declaration-refusals.js";
import { ManifestSourceFailure } from "../src/sources/source-failure.js";
import type { ManifestSource } from "../src/types.js";

/** A flat path → text source, with no glob expansion. A path it lacks fails as
 *  a source does: `not-found` at that path. */
function memorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new ManifestSourceFailure("not-found", `file://${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      const dir = base.slice(0, base.lastIndexOf("/") + 1);
      const joined = new URL(relative, `file://${dir}`).pathname;
      return /\.ya?ml$/.test(joined) ? joined : `${joined.replace(/\/$/, "")}/telo.yaml`;
    },
  };
}

async function graphOf(files: Record<string, string>, entry = "/ws/telo.yaml") {
  return new Loader([memorySource(files)]).loadGraph(entry, { desugarImports: true });
}

const at = (line: number, character: number, length: number) => ({
  start: { line, character },
  end: { line, character: character + length },
});

describe("the module-declaration rule", () => {
  it("refuses an empty file at its start", async () => {
    const graph = await graphOf({ "/ws/telo.yaml": "" });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "MODULE_DECLARATION_MISSING",
        message: MODULE_DECLARATION_MISSING_MESSAGE,
        range: at(0, 0, 0),
      }),
    ]);
  });

  it("refuses documents with no module document at the first one's kind", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": "kind: Telo.Definition\nmetadata: { name: Orphan }\ncapability: Telo.Type\n",
    });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({ code: "MODULE_DECLARATION_MISSING", range: at(0, 6, 15) }),
    ]);
  });

  it("refuses a second module document at its kind, naming every one", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml":
        "kind: Telo.Application\nmetadata: { name: A }\n---\nkind: Telo.Library\nmetadata: { name: B }\n",
    });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "MODULE_DECLARATION_DUPLICATE",
        message:
          "This file declares 2 module documents (Telo.Application, Telo.Library): a module's " +
          "telo.yaml declares exactly one Telo.Application or Telo.Library; keep one and move each other " +
          "module to a telo.yaml in a directory of its own.",
        range: at(3, 6, 12),
      }),
    ]);
  });

  it("leaves the built-in vocabulary archive to its own refusal", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": "kind: Telo.Builtins\nmetadata: { name: Telo, version: 0.119.0 }\n",
    });
    expect(graph.parseDiagnostics.map((d) => d.code)).toEqual(["UNDEFINED_KIND"]);
  });

  it("refuses an imported library's second module document at the library and the import", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ./lib }\n",
      "/ws/lib/telo.yaml":
        "kind: Telo.Library\nmetadata: { name: L }\n---\nkind: Telo.Library\nmetadata: { name: M }\n",
    });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "MODULE_DECLARATION_DUPLICATE",
        data: { filePath: "/ws/lib/telo.yaml" },
      }),
    ]);
    expect(graph.importEdges.get("/ws/telo.yaml")?.has("Lib")).toBeFalsy();
    expect(importResolutionDiagnostics(graph)).toEqual([
      expect.objectContaining({
        code: "INVALID_IMPORT_TARGET",
        message:
          "Cannot use import 'Lib' → './lib': it declares 2 module documents (Telo.Library, " +
          "Telo.Library); a library's telo.yaml declares exactly one Telo.Library.",
      }),
    ]);
  });

  it("refuses an imported target with no module document at its file as well as the import", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ./lib }\n",
      "/ws/lib/telo.yaml": "kind: Telo.Definition\nmetadata: { name: Orphan }\ncapability: Telo.Type\n",
    });
    expect(graph.parseDiagnostics.map((d) => [d.code, (d.data as { filePath: string }).filePath])).toEqual([
      ["MODULE_DECLARATION_MISSING", "/ws/lib/telo.yaml"],
    ]);
    expect(importResolutionDiagnostics(graph).map((d) => d.code)).toEqual(["INVALID_IMPORT_TARGET"]);
  });
});

describe("the partials of a module", () => {
  const owner = (include: string) =>
    `kind: Telo.Application\nmetadata: { name: App }\ninclude: [${include}]\n`;

  it("refuses a module-only kind in a partial at that partial's kind", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": owner("./part.yaml"),
      "/ws/part.yaml": "kind: Telo.Import\nmetadata: { name: Lib }\nsource: ./lib\n",
    });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "PARTIAL_KIND_FORBIDDEN",
        message:
          "A partial may not declare a 'Telo.Import' document: Telo.Application, Telo.Library, " +
          "Telo.Import and Telo.Definition documents are declared only in the telo.yaml that includes it.",
        range: at(0, 6, 11),
        data: { filePath: "/ws/part.yaml" },
      }),
    ]);
  });

  it("refuses a partial its source cannot read at the include entry, in the source's words", async () => {
    const graph = await graphOf({ "/ws/telo.yaml": owner("./a.yaml, ./gone.yaml"), "/ws/a.yaml": "" });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "PARTIAL_NOT_FOUND",
        message: "The partial './gone.yaml' cannot be read: nothing exists at file:///ws/gone.yaml.",
        range: at(2, 20, 11),
        data: { filePath: "/ws/telo.yaml" },
      }),
    ]);
  });

  it("refuses a missing path entry beside a glob, reading no exclusion as a path", async () => {
    const files = {
      "/ws/telo.yaml": owner('./missing.yaml, "./parts/*.yaml", "!./parts/b.yaml"'),
      "/ws/parts/a.yaml": "",
    };
    const source = { ...memorySource(files), expandGlob: async () => ["/ws/parts/a.yaml"] };
    const module = await new Loader([source]).loadModule("/ws/telo.yaml");
    expect(module.owner.parseErrors).toEqual([
      expect.objectContaining({
        code: "PARTIAL_NOT_FOUND",
        message: "The partial './missing.yaml' cannot be read: nothing exists at file:///ws/missing.yaml.",
        range: at(2, 10, 14),
      }),
    ]);
    expect(module.partials.map((p) => p.source)).toEqual(["/ws/parts/a.yaml"]);
  });

  it("says a partial naming a directory is not a file, never that it is not a module", async () => {
    const files = { "/ws/telo.yaml": owner("./parts") };
    const source = memorySource(files);
    const read = source.read.bind(source);
    source.read = async (url: string) => {
      if (url === "/ws/parts/telo.yaml") throw new ManifestSourceFailure("not-a-module", "file:///ws/parts");
      return read(url);
    };
    const graph = await new Loader([source]).loadGraph("/ws/telo.yaml", { desugarImports: true });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "PARTIAL_NOT_FOUND",
        message:
          "The partial './parts' cannot be read: file:///ws/parts is not a file: an include: entry " +
          "names one YAML file, or a glob over several.",
      }),
    ]);
  });

  it("refuses a glob its source cannot expand at the include entry", async () => {
    const graph = await graphOf({ "/ws/telo.yaml": owner("./parts/*.yaml") });
    expect(graph.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "PARTIAL_GLOB_UNSUPPORTED",
        message:
          "'./parts/*.yaml' is a glob, and the source this module is read from cannot list files " +
          "to expand it; name each partial by its path instead.",
        range: at(2, 10, 14),
      }),
    ]);
  });
});

describe("an import whose source failed", () => {
  it("is IMPORT_UNRESOLVED in the source failure's sentence, carrying its kind", async () => {
    const graph = await graphOf({
      "/ws/telo.yaml": "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ./lib }\n",
    });
    expect(importResolutionDiagnostics(graph)).toEqual([
      expect.objectContaining({
        code: "IMPORT_UNRESOLVED",
        message: "Cannot resolve import 'Lib' → './lib': nothing exists at file:///ws/lib/telo.yaml.",
        data: expect.objectContaining({ path: "imports.Lib", sourceFailure: "not-found" }),
      }),
    ]);
  });
});
