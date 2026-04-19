import { describe, expect, it, vi } from "vitest";
import type {
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

function stubReadFile(contents: Record<string, string> = {}) {
  return vi.fn(async (p: string) => contents[p] ?? `# contents of ${p}`);
}

describe("buildRunBundle", () => {
  it("bundles a single Application with no imports", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application");
    const ws = makeWorkspace([app]);
    const readFile = stubReadFile();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", readFile);

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.relativePath).toBe("telo.yaml");
    expect(bundle.files[0]!.contents).toBe("# contents of /ws/app/telo.yaml");
    expect(bundle.entryRelativePath).toBe("telo.yaml");
    expect(readFile).toHaveBeenCalledTimes(1);
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
    const readFile = stubReadFile();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", readFile);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["app/telo.yaml", "libs/b/telo.yaml", "libs/c/telo.yaml"]);
    expect(bundle.entryRelativePath).toBe("app/telo.yaml");
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("excludes registry and remote imports from the bundle", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      imports: [
        makeImport("Registry", "pkg:npm:@foo/bar", "registry"),
        makeImport("Remote", "https://example.com/mod.yaml", "remote"),
      ],
    });
    const ws = makeWorkspace([app]);
    const readFile = stubReadFile();

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", readFile);

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.relativePath).toBe("telo.yaml");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("terminates and emits each file once on circular local imports", async () => {
    const app = makeManifest("/ws/a/telo.yaml", "Application", {
      imports: [makeImport("B", "../b", "local", "/ws/b/telo.yaml")],
    });
    const libB = makeManifest("/ws/b/telo.yaml", "Library", {
      imports: [makeImport("A", "../a", "local", "/ws/a/telo.yaml")],
    });
    const ws = makeWorkspace([app, libB]);
    const readFile = stubReadFile();

    const bundle = await buildRunBundle(ws, "/ws/a/telo.yaml", readFile);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["a/telo.yaml", "b/telo.yaml"]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("includes include:-reachable partial files with their on-disk contents", async () => {
    const app = makeManifest("/ws/app/telo.yaml", "Application", {
      include: ["./sub.yaml", "./nested/deep.yaml"],
    });
    const ws = makeWorkspace([app]);
    const readFile = stubReadFile({
      "/ws/app/telo.yaml": "# main",
      "/ws/app/sub.yaml": "# sub",
      "/ws/app/nested/deep.yaml": "# deep",
    });

    const bundle = await buildRunBundle(ws, "/ws/app/telo.yaml", readFile);

    const byPath = Object.fromEntries(
      bundle.files.map((f) => [f.relativePath, f.contents]),
    );
    expect(byPath).toEqual({
      "telo.yaml": "# main",
      "sub.yaml": "# sub",
      "nested/deep.yaml": "# deep",
    });
    expect(readFile).toHaveBeenCalledWith("/ws/app/sub.yaml");
    expect(readFile).toHaveBeenCalledWith("/ws/app/nested/deep.yaml");
  });

  it("rejects when the entry module is a Library", async () => {
    const lib = makeManifest("/ws/lib/telo.yaml", "Library");
    const ws = makeWorkspace([lib]);
    const readFile = stubReadFile();

    await expect(
      buildRunBundle(ws, "/ws/lib/telo.yaml", readFile),
    ).rejects.toThrow(/must be an Application/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects when the entry module is missing from the workspace", async () => {
    const ws = makeWorkspace([]);
    const readFile = stubReadFile();

    await expect(
      buildRunBundle(ws, "/ws/missing/telo.yaml", readFile),
    ).rejects.toThrow(/not found/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("handles Windows-style backslash paths by normalising to POSIX", async () => {
    const app = makeManifest("C:\\ws\\app\\telo.yaml", "Application", {
      include: [".\\sub.yaml"],
    });
    const ws = makeWorkspace([app]);
    const readFile = stubReadFile({
      "C:/ws/app/telo.yaml": "# main",
      "C:/ws/app/sub.yaml": "# sub",
    });

    const bundle = await buildRunBundle(ws, "C:\\ws\\app\\telo.yaml", readFile);

    const paths = bundle.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(["sub.yaml", "telo.yaml"]);
    expect(bundle.entryRelativePath).toBe("telo.yaml");
  });
});
