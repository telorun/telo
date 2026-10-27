import { describe, expect, it } from "vitest";
import type { ParsedManifest, Workspace } from "../../model";
import { buildModuleForest, flattenModules } from "./module-tree";

function manifest(filePath: string, kind: "Application" | "Library"): ParsedManifest {
  const name = filePath.split("/").slice(-2, -1)[0];
  return kind === "Application"
    ? { filePath, kind, metadata: { name }, targets: [], imports: [], resources: [] }
    : { filePath, kind, metadata: { name }, imports: [], resources: [] };
}

function workspace(modules: ParsedManifest[]): Workspace {
  return {
    rootDir: "/ws",
    modules: new Map(modules.map((m) => [m.filePath, m])),
    importGraph: new Map(),
    importedBy: new Map(),
    documents: new Map(),
    resourceDocIndex: new Map(),
  };
}

describe("buildModuleForest", () => {
  it("splits roots by kind and keeps sibling directories with a shared prefix apart", () => {
    const forest = buildModuleForest(
      workspace([
        manifest("/ws/apps/todo/telo.yaml", "Application"),
        manifest("/ws/apps/todo-api/telo.yaml", "Application"),
        manifest("/ws/libs/core/telo.yaml", "Library"),
      ]),
    );
    expect(forest.applications.map((n) => n.relativeDir)).toEqual(["apps/todo", "apps/todo-api"]);
    expect(forest.applications.every((n) => n.children.length === 0)).toBe(true);
    expect(forest.libraries.map((n) => n.relativeDir)).toEqual(["libs/core"]);
  });

  it("nests a module under the nearest enclosing module at any depth", () => {
    const forest = buildModuleForest(
      workspace([
        manifest("/ws/apps/todo/telo.yaml", "Application"),
        manifest("/ws/apps/todo/tests/telo.yaml", "Application"),
        manifest("/ws/apps/todo/libs/db/telo.yaml", "Library"),
        manifest("/ws/apps/todo/libs/db/fixtures/telo.yaml", "Application"),
      ]),
    );
    const [todo] = forest.applications;
    expect(todo.children.map((n) => n.relativeDir)).toEqual([
      "apps/todo/libs/db",
      "apps/todo/tests",
    ]);
    const [db] = todo.children;
    expect(db.children.map((n) => n.relativeDir)).toEqual(["apps/todo/libs/db/fixtures"]);
    expect(flattenModules(forest.applications)).toHaveLength(4);
  });

  it("places a library nested in an application under that application, not in its own section", () => {
    const forest = buildModuleForest(
      workspace([
        manifest("/ws/apps/todo/telo.yaml", "Application"),
        manifest("/ws/apps/todo/libs/core/telo.yaml", "Library"),
      ]),
    );
    expect(forest.libraries).toEqual([]);
    expect(forest.applications[0].children[0].manifest.kind).toBe("Library");
  });

  it("treats a module at the workspace root as the root of every other module", () => {
    const forest = buildModuleForest(
      workspace([
        manifest("/ws/telo.yaml", "Application"),
        manifest("/ws/apps/todo/telo.yaml", "Application"),
      ]),
    );
    expect(forest.applications.map((n) => n.relativeDir)).toEqual([""]);
    expect(forest.applications[0].children.map((n) => n.relativeDir)).toEqual(["apps/todo"]);
  });
});
