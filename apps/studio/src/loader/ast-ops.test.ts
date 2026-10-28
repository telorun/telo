import { describe, expect, it } from "vitest";
import type { ParsedManifest, Workspace } from "../model";
import { rebuildManifestFromDocuments } from "./ast-ops";
import { buildParsedManifest } from "./parse";
import { normalizePath } from "./paths";
import { parseModuleDocument } from "../yaml-document";

const parentPath = "/ws/apps/todo/telo.yaml";
const nestedPath = "/ws/apps/todo/tests/telo.yaml";

function application(filePath: string, name: string): ParsedManifest {
  return buildParsedManifest(filePath, [
    { kind: "Telo.Application", metadata: { name } } as never,
  ]);
}

function workspaceWithNestedApp(): Workspace {
  const documents = new Map([
    [normalizePath(parentPath), parseModuleDocument(parentPath, "kind: Telo.Application\nmetadata:\n  name: todo\n")],
    [normalizePath(nestedPath), parseModuleDocument(nestedPath, "kind: Telo.Application\nmetadata:\n  name: todo-tests\n")],
  ]);
  return {
    rootDir: "/ws",
    modules: new Map([
      [parentPath, application(parentPath, "todo")],
      [nestedPath, application(nestedPath, "todo-tests")],
    ]),
    importGraph: new Map(),
    importedBy: new Map(),
    documents,
    resourceDocIndex: new Map(),
  };
}

describe("rebuildManifestFromDocuments — nested module rename", () => {
  it("re-derives a nested module's name from its edited manifest, leaving its parent's name alone", () => {
    const workspace = workspaceWithNestedApp();
    const edited = parseModuleDocument(
      nestedPath,
      "kind: Telo.Application\nmetadata:\n  name: renamed-tests\n",
    );
    const documents = new Map(workspace.documents);
    documents.set(normalizePath(nestedPath), { ...edited, dirty: true });

    const next = rebuildManifestFromDocuments({ ...workspace, documents }, nestedPath);

    expect(next.modules.get(nestedPath)?.metadata.name).toBe("renamed-tests");
    expect(next.modules.get(parentPath)?.metadata.name).toBe("todo");
  });
});
