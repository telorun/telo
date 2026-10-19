import { describe, expect, it, vi } from "vitest";
import { DirectoryNotFoundError } from "../../loader/adapters/directory-not-found";
import type {
  DirEntry,
  ImportKind,
  ModuleKind,
  ParsedImport,
  ParsedManifest,
  Workspace,
} from "../../model";
import { buildRunBundle } from "../bundle";

function makeManifest(
  filePath: string,
  kind: ModuleKind,
  overrides: Partial<ParsedManifest> = {},
): ParsedManifest {
  return {
    filePath,
    kind,
    metadata: { name: filePath },
    targets: [],
    imports: [],
    resources: [],
    ...overrides,
  };
}

function makeImport(
  name: string,
  source: string,
  importKind: ImportKind,
  resolvedPath?: string,
): ParsedImport {
  return { name, source, importKind, resolvedPath };
}

function makeWorkspace(modules: ParsedManifest[]): Workspace {
  const modMap = new Map<string, ParsedManifest>();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const m of modules) {
    modMap.set(m.filePath, m);
    importGraph.set(m.filePath, new Set());
  }
  for (const m of modules) {
    for (const imp of m.imports) {
      if (imp.importKind !== "local" || !imp.resolvedPath) continue;
      importGraph.get(m.filePath)!.add(imp.resolvedPath);
      if (!importedBy.has(imp.resolvedPath)) importedBy.set(imp.resolvedPath, new Set());
      importedBy.get(imp.resolvedPath)!.add(m.filePath);
    }
  }
  return {
    rootDir: "/ws",
    modules: modMap,
    importGraph,
    importedBy,
    documents: new Map(),
    resourceDocIndex: new Map(),
  };
}

/** An in-memory workspace: a path with no entry reads as `# contents of <path>`. */
function memorySource(files: Record<string, string | Uint8Array> = {}) {
  const readBytes = vi.fn(async (p: string) => {
    const file = files[p] ?? `# contents of ${p}`;
    return typeof file === "string" ? new TextEncoder().encode(file) : file;
  });
  const listDir = vi.fn(async (dir: string): Promise<DirEntry[]> => {
    const entries = new Map<string, boolean>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue;
      const rest = path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    if (entries.size === 0) throw new DirectoryNotFoundError(dir);
    return [...entries].map(([name, isDirectory]) => ({
      name,
      isDirectory,
      kind: isDirectory ? "directory" : "file",
    }));
  });
  return { readBytes, listDir };
}

const text = (bundle: { files: Array<{ relativePath: string; contents: string }> }) =>
  Object.fromEntries(bundle.files.map((f) => [f.relativePath, f.contents]));

describe("buildRunBundle", () => {
  it("bundles a single Application with no imports", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application");
    const ws = makeWorkspace([app]);
    const source = memorySource();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(bundle.files).toHaveLength(1);
    // Where the editor holds it under the workspace root — the layout the
    // agent's sync writes into the same session workspace.
    expect(bundle.files[0]!.relativePath).toBe("app/telo.yaml");
    expect(bundle.files[0]!.contents).toBe("# contents of /ws/app/telo.yaml");
    expect(bundle.entryRelativePath).toBe("app/telo.yaml");
    expect(source.readBytes).toHaveBeenCalledTimes(1);
  });

  it("walks a chain of transitively-imported local Libraries", async () => {
    const libC = makeManifest("/ws/libs/c/telo.yaml", "Library");
    const libB = makeManifest("/ws/libs/b/telo.yaml", "Library", {
      imports: [makeImport("C", "../c", "local", "/ws/libs/c/telo.yaml")],
    });
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      imports: [makeImport("B", "../libs/b", "local", "/ws/libs/b/telo.yaml")],
    });
    const ws = makeWorkspace([app, libB, libC]);
    const source = memorySource();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["app/telo.yaml", "libs/b/telo.yaml", "libs/c/telo.yaml"]);
    expect(bundle.entryRelativePath).toBe("app/telo.yaml");
    expect(source.readBytes).toHaveBeenCalledTimes(3);
  });

  it("excludes registry and remote imports from the bundle", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      imports: [
        makeImport("Remote", "pkg:npm:@foo/bar", "remote"),
        makeImport("Remote", "https://example.com/mod.yaml", "remote"),
      ],
    });
    const ws = makeWorkspace([app]);
    const source = memorySource();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.relativePath).toBe("app/telo.yaml");
    expect(source.readBytes).toHaveBeenCalledTimes(1);
  });

  it("terminates and emits each file once on circular local imports", async () => {
    const app = makeManifest("/ws/a/telo.yaml", "Application", {
      imports: [makeImport("B", "../b", "local", "/ws/b/telo.yaml")],
    });
    const libB = makeManifest("/ws/b/telo.yaml", "Library", {
      imports: [makeImport("A", "../a", "local", "/ws/a/telo.yaml")],
    });
    const ws = makeWorkspace([app, libB]);
    const source = memorySource();

    const bundle = await buildRunBundle(ws, "/ws/a/telo.yaml", source);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["a/telo.yaml", "b/telo.yaml"]);
    expect(source.readBytes).toHaveBeenCalledTimes(2);
  });

  it("includes include:-reachable partial files with their on-disk contents", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      include: ["./sub.yaml", "./nested/deep.yaml"],
    });
    const ws = makeWorkspace([app]);
    const source = memorySource({
      "/ws/app/telo.yaml": "# main",
      "/ws/app/sub.yaml": "# sub",
      "/ws/app/nested/deep.yaml": "# deep",
    });

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(text(bundle)).toEqual({
      "app/telo.yaml": "# main",
      "app/sub.yaml": "# sub",
      "app/nested/deep.yaml": "# deep",
    });
  });

  it("selects files: assets and ships them with their contents", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      files: ["public/app.js", "public/**"],
    });
    const ws = makeWorkspace([app]);
    const source = memorySource({
      "/ws/app/telo.yaml": "# main",
      "/ws/app/public/app.js": "// app",
      "/ws/app/public/index.html": "<html>",
    });

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(text(bundle)).toEqual({
      "app/telo.yaml": "# main",
      "app/public/app.js": "// app",
      "app/public/index.html": "<html>",
    });
  });

  it("ships what !module-path and !include-text claim, in the entry and in an imported library", async () => {
    const lib = makeManifest("/ws/libs/reports/telo.yaml", "Library");
    const app = makeManifest("/ws/apps/console/telo.yaml", "Application", {
      imports: [makeImport("Reports", "../../libs/reports", "local", "/ws/libs/reports/telo.yaml")],
    });
    const ws = makeWorkspace([app, lib]);
    const source = memorySource({
      "/ws/apps/console/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: Console }",
        "---",
        "kind: Http.Static",
        "metadata: { name: page }",
        "root: !module-path ./public",
      ].join("\n"),
      "/ws/apps/console/public/index.html": "<html>",
      "/ws/apps/console/public/js/app.js": "// app",
      "/ws/libs/reports/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: Reports }",
        "---",
        "kind: Pdf.Document",
        "metadata: { name: doc }",
        "background: !include-text assets/page-background.svg",
        "logo: !include-text assets/missing.svg",
      ].join("\n"),
      "/ws/libs/reports/assets/page-background.svg": "<svg/>",
      "/ws/libs/reports/assets/unclaimed.svg": "<svg/>",
    });

    const bundle = await buildRunBundle(ws, "/ws/apps/console/telo.yaml", source);

    // A claim naming nothing ships nothing — the kernel refuses it at load.
    expect(bundle.files.map((f) => f.relativePath).sort()).toEqual([
      "apps/console/public/index.html",
      "apps/console/public/js/app.js",
      "apps/console/telo.yaml",
      "libs/reports/assets/page-background.svg",
      "libs/reports/telo.yaml",
    ]);
  });

  it("expands a directory only where !module-path names it", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application");
    const ws = makeWorkspace([app]);
    const source = memorySource({
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: App }",
        "---",
        "kind: Pdf.Document",
        "metadata: { name: doc }",
        "background: !include-text assets",
      ].join("\n"),
      "/ws/app/assets/page-background.svg": "<svg/>",
    });

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(bundle.files.map((f) => f.relativePath)).toEqual(["app/telo.yaml"]);
  });

  it("ships a file whose bytes are not UTF-8 as base64", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", { files: ["logo.png"] });
    const ws = makeWorkspace([app]);
    const source = memorySource({
      "/ws/app/telo.yaml": "# main",
      "/ws/app/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    });

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", source);

    expect(bundle.files).toContainEqual({ relativePath: "app/telo.yaml", contents: "# main" });
    expect(bundle.files).toContainEqual({
      relativePath: "app/logo.png",
      contents: "iVBOR/8A",
      encoding: "base64",
    });
  });

  it("falls back to what it ships when an import climbs above the workspace root", async () => {
    const shared = makeManifest("/elsewhere/shared/telo.yaml", "Library");
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      imports: [makeImport("Shared", "../../elsewhere/shared", "local", "/elsewhere/shared/telo.yaml")],
    });
    const ws = makeWorkspace([app, shared]);

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", memorySource());

    // Nothing under the workspace root can hold a file outside it, so the
    // bundle is rooted at the common ancestor of the two.
    expect(bundle.files.map((f) => f.relativePath).sort()).toEqual([
      "elsewhere/shared/telo.yaml",
      "ws/app/telo.yaml",
    ]);
    expect(bundle.entryRelativePath).toBe("ws/app/telo.yaml");
  });

  it("rejects when the entry module is a Library", async () => {
    const lib = makeManifest("/ws/lib/telo.yaml", "Library");
    const ws = makeWorkspace([lib]);
    const source = memorySource();

    await expect(buildRunBundle(ws, "/ws/lib/telo.yaml", source)).rejects.toThrow(
      /must be an Application/,
    );
    expect(source.readBytes).not.toHaveBeenCalled();
  });

  it("rejects when the entry module is missing from the workspace", async () => {
    const ws = makeWorkspace([]);
    const source = memorySource();

    await expect(buildRunBundle(ws, "/ws/missing/telo.yaml", source)).rejects.toThrow(/not found/);
    expect(source.readBytes).not.toHaveBeenCalled();
  });

  it("handles Windows-style backslash paths by normalising to POSIX", async () => {
    const app = makeManifest("C:\\ws\\app\\telo.yaml", "Application", {
      include: [".\\sub.yaml"],
    });
    const ws = makeWorkspace([app]);
    const source = memorySource({
      "C:/ws/app/telo.yaml": "# main",
      "C:/ws/app/sub.yaml": "# sub",
    });

    const bundle = await buildRunBundle(ws, "C:\\ws\\app\\telo.yaml", source);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["sub.yaml", "telo.yaml"]);
    expect(bundle.entryRelativePath).toBe("telo.yaml");
  });
});
