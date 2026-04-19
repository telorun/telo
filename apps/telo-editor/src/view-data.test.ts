import { describe, expect, it } from "vitest";
import type { ModuleDocument, ParsedManifest, Workspace } from "./model";
import { parseModuleDocument } from "./yaml-document";
import { buildModuleViewData } from "./view-data";

function makeWorkspace(entries: Array<{ path: string; text: string; parseError?: string }>): Workspace {
  const documents = new Map<string, ModuleDocument>();
  for (const { path, text, parseError } of entries) {
    const base = parseModuleDocument(path, text);
    documents.set(path, parseError ? { ...base, parseError } : base);
  }
  return {
    rootDir: "/ws",
    modules: new Map(),
    importGraph: new Map(),
    importedBy: new Map(),
    documents,
    resourceDocIndex: new Map(),
  };
}

function makeManifest(
  filePath: string,
  resources: Array<{ kind: string; name: string; sourceFile?: string }> = [],
): ParsedManifest {
  return {
    filePath,
    kind: "Application",
    metadata: { name: "app" },
    targets: [],
    imports: [],
    resources: resources.map((r) => ({ ...r, fields: {} })),
  };
}

describe("buildModuleViewData.sourceFiles", () => {
  it("returns just the owner file for a single-file module", () => {
    const workspace = makeWorkspace([
      { path: "/ws/app/telo.yaml", text: "kind: Telo.Application\nmetadata:\n  name: app\n" },
    ]);
    const manifest = makeManifest("/ws/app/telo.yaml");
    const viewData = buildModuleViewData(workspace, manifest, undefined);

    expect(viewData.sourceFiles).toHaveLength(1);
    expect(viewData.sourceFiles[0]).toMatchObject({
      filePath: "/ws/app/telo.yaml",
    });
    expect(viewData.sourceFiles[0].text).toContain("kind: Telo.Application");
  });

  it("returns owner first, then partials in alphabetical order", () => {
    const workspace = makeWorkspace([
      { path: "/ws/app/telo.yaml", text: "kind: Telo.Application\nmetadata:\n  name: app\n" },
      { path: "/ws/app/routes.yaml", text: "kind: Http.Route\nmetadata:\n  name: home\n" },
      { path: "/ws/app/handlers.yaml", text: "kind: Http.Handler\nmetadata:\n  name: h\n" },
    ]);
    const manifest = makeManifest("/ws/app/telo.yaml", [
      { kind: "Http.Route", name: "home", sourceFile: "/ws/app/routes.yaml" },
      { kind: "Http.Handler", name: "h", sourceFile: "/ws/app/handlers.yaml" },
    ]);
    const viewData = buildModuleViewData(workspace, manifest, undefined);

    expect(viewData.sourceFiles.map((f) => f.filePath)).toEqual([
      "/ws/app/telo.yaml",
      "/ws/app/handlers.yaml",
      "/ws/app/routes.yaml",
    ]);
  });

  it("propagates parseError from ModuleDocument to sourceFiles entry", () => {
    const workspace = makeWorkspace([
      {
        path: "/ws/app/telo.yaml",
        text: "kind: Telo.Application\nmetadata:\n  name: app\n",
        parseError: "simulated",
      },
    ]);
    const manifest = makeManifest("/ws/app/telo.yaml");
    const viewData = buildModuleViewData(workspace, manifest, undefined);

    expect(viewData.sourceFiles[0].parseError).toBe("simulated");
  });

  it("skips partial files missing from workspace.documents (defensive)", () => {
    const workspace = makeWorkspace([
      { path: "/ws/app/telo.yaml", text: "kind: Telo.Application\nmetadata:\n  name: app\n" },
    ]);
    // Manifest references a partial that isn't in documents.
    const manifest = makeManifest("/ws/app/telo.yaml", [
      { kind: "Ghost", name: "g", sourceFile: "/ws/app/missing.yaml" },
    ]);
    const viewData = buildModuleViewData(workspace, manifest, undefined);

    expect(viewData.sourceFiles).toHaveLength(1);
    expect(viewData.sourceFiles[0].filePath).toBe("/ws/app/telo.yaml");
  });

  it("deduplicates partial sourceFile entries that match the owner", () => {
    const workspace = makeWorkspace([
      { path: "/ws/app/telo.yaml", text: "kind: Telo.Application\nmetadata:\n  name: app\n" },
    ]);
    // A resource whose sourceFile is the owner — should not double-insert.
    const manifest = makeManifest("/ws/app/telo.yaml", [
      { kind: "Http.Server", name: "main", sourceFile: "/ws/app/telo.yaml" },
    ]);
    const viewData = buildModuleViewData(workspace, manifest, undefined);

    expect(viewData.sourceFiles).toHaveLength(1);
  });
});
