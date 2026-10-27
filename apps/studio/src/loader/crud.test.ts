import { describe, expect, it, vi } from "vitest";
import type { DirEntry, ParsedManifest, Workspace, WorkspaceAdapter } from "../model";
import { deleteModule, materializeModule, ModuleExistsError } from "./crud";
import type { StarterDescriptor } from "./starters";

// The starter path calls out to the network via `fetchStarterFiles`; stub it
// so the atomicity test can force a fetch failure deterministically.
vi.mock("./starters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./starters")>();
  return { ...actual, fetchStarterFiles: vi.fn(async () => { throw new Error("offline"); }) };
});

function memAdapter(existing: Record<string, DirEntry[]> = {}) {
  const writes: Record<string, string> = {};
  const deleted: string[] = [];
  const adapter: WorkspaceAdapter = {
    readFile: vi.fn(async () => ""),
    readBytes: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async (p: string, t: string) => {
      writes[p] = t;
    }),
    listDir: vi.fn(async (dir: string) => existing[dir] ?? []),
    createDir: vi.fn(async () => {}),
    delete: vi.fn(async (p: string) => {
      deleted.push(p);
    }),
    rename: vi.fn(async () => {}),
  };
  return { adapter, writes, deleted };
}

const CTX = { startersBaseUrl: "https://x.dev", manifestSources: [] };
const STARTER: StarterDescriptor = {
  id: "t",
  title: "T",
  description: "",
  category: "app",
  path: "apps/t/telo.yaml",
};

describe("materializeModule — blank", () => {
  it("writes telo.yaml under apps/<slug> with the picked name", async () => {
    const { adapter, writes } = memAdapter();
    const res = await materializeModule(adapter, "/ws", {
      kind: "Application",
      name: "Weather Api",
      selection: { type: "blank" },
      ...CTX,
    });
    expect(res.rootPath).toBe("/ws/apps/weather-api/telo.yaml");
    expect(writes["/ws/apps/weather-api/telo.yaml"]).toContain("name: Weather Api");
  });

  it("puts libraries under libs/<slug>", async () => {
    const { adapter } = memAdapter();
    const res = await materializeModule(adapter, "/ws", {
      kind: "Library",
      name: "Notes",
      selection: { type: "blank" },
      ...CTX,
    });
    expect(res.rootPath).toBe("/ws/libs/notes/telo.yaml");
  });
});

describe("materializeModule — overwrite", () => {
  it("throws ModuleExistsError naming the directory when occupied", async () => {
    const { adapter } = memAdapter({ "/ws/apps/notes": [{ name: "telo.yaml", isDirectory: false, kind: "file" }] });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "blank" },
        ...CTX,
      }),
    ).rejects.toBeInstanceOf(ModuleExistsError);
  });

  it("detects a directory with content even without a telo.yaml", async () => {
    const { adapter } = memAdapter({ "/ws/apps/notes": [{ name: "index.html", isDirectory: false, kind: "file" }] });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "blank" },
        ...CTX,
      }),
    ).rejects.toBeInstanceOf(ModuleExistsError);
  });

  it("deletes then writes when overwrite is set", async () => {
    const { adapter, deleted, writes } = memAdapter({
      "/ws/apps/notes": [{ name: "telo.yaml", isDirectory: false, kind: "file" }],
    });
    await materializeModule(adapter, "/ws", {
      kind: "Application",
      name: "Notes",
      selection: { type: "blank" },
      overwrite: true,
      ...CTX,
    });
    expect(deleted).toContain("/ws/apps/notes");
    expect(writes["/ws/apps/notes/telo.yaml"]).toBeDefined();
  });
});

describe("materializeModule — atomicity", () => {
  it("does not delete the existing directory when the starter fetch fails", async () => {
    const { adapter, deleted, writes } = memAdapter({
      "/ws/apps/notes": [{ name: "index.html", isDirectory: false, kind: "file" }],
    });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "starter", starter: STARTER },
        overwrite: true,
        ...CTX,
      }),
    ).rejects.toThrow(/offline/);
    // The file set is built before any delete — a fetch failure leaves the
    // user's directory untouched.
    expect(deleted).toEqual([]);
    expect(writes).toEqual({});
  });
});

describe("deleteModule — cascade", () => {
  const app = (filePath: string, imports: Array<[string, string]> = []): ParsedManifest => ({
    filePath,
    kind: "Application",
    metadata: { name: filePath.split("/").slice(-2, -1)[0] },
    targets: [],
    imports: imports.map(([name, resolvedPath]) => ({
      name,
      source: resolvedPath,
      importKind: "local",
      resolvedPath,
    })),
    resources: [],
  });
  const lib = (filePath: string): ParsedManifest => ({
    filePath,
    kind: "Library",
    metadata: { name: filePath.split("/").slice(-2, -1)[0] },
    imports: [],
    resources: [],
  });

  function workspaceOf(modules: ParsedManifest[]): Workspace {
    const importedBy = new Map<string, Set<string>>();
    for (const m of modules) {
      for (const imp of m.imports) {
        if (!imp.resolvedPath) continue;
        if (!importedBy.has(imp.resolvedPath)) importedBy.set(imp.resolvedPath, new Set());
        importedBy.get(imp.resolvedPath)!.add(m.filePath);
      }
    }
    return {
      rootDir: "/ws",
      modules: new Map(modules.map((m) => [m.filePath, m])),
      importGraph: new Map(),
      importedBy,
      documents: new Map(),
      resourceDocIndex: new Map(),
    };
  }

  it("deletes the module's directory and drops every module nested in it", async () => {
    const workspace = workspaceOf([
      app("/ws/apps/todo/telo.yaml", [["Db", "/ws/apps/todo/libs/db/telo.yaml"]]),
      lib("/ws/apps/todo/libs/db/telo.yaml"),
      app("/ws/apps/todo/tests/telo.yaml", [["Todo", "/ws/apps/todo/telo.yaml"]]),
      app("/ws/apps/other/telo.yaml", [
        ["Db", "/ws/apps/todo/libs/db/telo.yaml"],
        ["Shared", "/ws/libs/shared/telo.yaml"],
      ]),
      lib("/ws/libs/shared/telo.yaml"),
    ]);
    const { adapter, deleted } = memAdapter();

    const next = await deleteModule(workspace, "/ws/apps/todo/telo.yaml", adapter);

    expect(deleted).toEqual(["/ws/apps/todo"]);
    expect([...next.modules.keys()].sort()).toEqual([
      "/ws/apps/other/telo.yaml",
      "/ws/libs/shared/telo.yaml",
    ]);
  });

  it("prunes imports of the deleted subtree from importers outside it, and keeps the rest", async () => {
    const workspace = workspaceOf([
      app("/ws/apps/todo/telo.yaml"),
      lib("/ws/apps/todo/libs/db/telo.yaml"),
      app("/ws/apps/other/telo.yaml", [
        ["Db", "/ws/apps/todo/libs/db/telo.yaml"],
        ["Shared", "/ws/libs/shared/telo.yaml"],
      ]),
      lib("/ws/libs/shared/telo.yaml"),
    ]);
    const { adapter } = memAdapter();

    const next = await deleteModule(workspace, "/ws/apps/todo/telo.yaml", adapter);

    expect(next.modules.get("/ws/apps/other/telo.yaml")?.imports.map((i) => i.name)).toEqual([
      "Shared",
    ]);
    expect(next.importedBy.get("/ws/libs/shared/telo.yaml")).toEqual(
      new Set(["/ws/apps/other/telo.yaml"]),
    );
  });

  it("refuses to delete the module whose directory is the whole workspace", async () => {
    const workspace = workspaceOf([app("/ws/telo.yaml"), app("/ws/apps/todo/telo.yaml")]);
    const { adapter, deleted } = memAdapter();

    await expect(deleteModule(workspace, "/ws/telo.yaml", adapter)).rejects.toThrow(
      "root module",
    );
    expect(deleted).toEqual([]);
  });
});
