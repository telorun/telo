import { describe, expect, it, vi } from "vitest";
import {
  createResourceViaAst,
  rebuildManifestFromDocuments,
  saveModuleFromDocuments,
  setResourceFields,
} from "./loader";
import type {
  ModuleDocument,
  ParsedImport,
  ParsedManifest,
  Workspace,
  WorkspaceAdapter,
} from "./model";
import { parseModuleDocument } from "./yaml-document";

function stubAdapter(): WorkspaceAdapter & { writeFile: ReturnType<typeof vi.fn> } {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
    createDir: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function makeManifest(
  filePath: string,
  resources: Array<{ kind: string; name: string; sourceFile?: string; fields?: Record<string, unknown> }> = [],
  imports: ParsedImport[] = [],
): ParsedManifest {
  return {
    filePath,
    kind: "Application",
    metadata: { name: "app" },
    targets: [],
    imports,
    resources: resources.map((r) => ({ fields: {}, ...r })),
  };
}

function makeWorkspace(entries: Array<{ path: string; text: string }>, manifests: ParsedManifest[]): Workspace {
  const documents = new Map<string, ModuleDocument>();
  for (const { path, text } of entries) {
    documents.set(path, parseModuleDocument(path, text));
  }
  const modules = new Map<string, ParsedManifest>();
  for (const m of manifests) modules.set(m.filePath, m);
  return {
    rootDir: "/ws",
    modules,
    importGraph: new Map(),
    importedBy: new Map(),
    documents,
    resourceDocIndex: new Map(),
  };
}

describe("saveModuleFromDocuments", () => {
  it("writes nothing when the AST matches the load-time snapshot", async () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [makeManifest("/ws/app/telo.yaml")],
    );
    const adapter = stubAdapter();

    const result = await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);

    expect(adapter.writeFile).not.toHaveBeenCalled();
    expect(result).toBe(workspace); // unchanged reference when nothing written
  });

  it("writes the owner file after an AST mutation and preserves unrelated comments", async () => {
    const text = [
      "# keep this comment",
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "port: 8080 # trailing",
      "",
    ].join("\n");
    const workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [makeManifest("/ws/app/telo.yaml")],
    );
    const adapter = stubAdapter();

    // Mutate the AST directly — simulates what Phase 3's applyEdit will do.
    const modDoc = workspace.documents.get("/ws/app/telo.yaml")!;
    modDoc.docs[0].setIn(["port"], 9090);

    const result = await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);

    expect(adapter.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenText] = adapter.writeFile.mock.calls[0]!;
    expect(writtenPath).toBe("/ws/app/telo.yaml");
    expect(writtenText).toContain("# keep this comment");
    expect(writtenText).toContain("# trailing");
    expect(writtenText).toContain("port: 9090");

    // Returned workspace has advanced loadedJson so a re-save is a no-op.
    const adapter2 = stubAdapter();
    await saveModuleFromDocuments(result, "/ws/app/telo.yaml", adapter2);
    expect(adapter2.writeFile).not.toHaveBeenCalled();
  });

  it("writes only the partial file when a resource in a partial is mutated", async () => {
    const ownerText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "include:",
      "  - ./routes.yaml",
      "",
    ].join("\n");
    const partialText = [
      "kind: Http.Route",
      "metadata:",
      "  name: home",
      "path: /",
      "",
    ].join("\n");
    const workspace = makeWorkspace(
      [
        { path: "/ws/app/telo.yaml", text: ownerText },
        { path: "/ws/app/routes.yaml", text: partialText },
      ],
      [
        makeManifest("/ws/app/telo.yaml", [
          { kind: "Http.Route", name: "home", sourceFile: "/ws/app/routes.yaml" },
        ]),
      ],
    );
    const adapter = stubAdapter();

    // Mutate only the partial file's AST.
    const partialDoc = workspace.documents.get("/ws/app/routes.yaml")!;
    partialDoc.docs[0].setIn(["path"], "/home");

    await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);

    expect(adapter.writeFile).toHaveBeenCalledTimes(1);
    expect(adapter.writeFile.mock.calls[0]![0]).toBe("/ws/app/routes.yaml");
  });

  it("skips files with a parseError — never destroys user edits-in-progress", async () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [makeManifest("/ws/app/telo.yaml")],
    );
    const adapter = stubAdapter();

    // Force parseError on the ModuleDocument even though docs are fine.
    const modDoc = workspace.documents.get("/ws/app/telo.yaml")!;
    workspace.documents.set("/ws/app/telo.yaml", { ...modDoc, parseError: "simulated" });

    // And mutate the AST so the equality guard wouldn't short-circuit.
    modDoc.docs[0].setIn(["metadata", "name"], "renamed");

    await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);
    expect(adapter.writeFile).not.toHaveBeenCalled();
  });
});

describe("rebuildManifestFromDocuments", () => {
  it("re-derives resource fields from the AST after a setResourceFields mutation", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "port: 8080",
      "",
    ].join("\n");
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [
          { kind: "Http.Server", name: "main", fields: { port: 8080 } },
        ]),
      ],
    );
    // resourceDocIndex is needed for setResourceFields; build it from scratch.
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Server",
      "main",
      { port: 8080 },
      { port: 9090 },
    );

    const manifest = workspace.modules.get("/ws/app/telo.yaml")!;
    const server = manifest.resources.find((r) => r.name === "main")!;
    expect(server.fields.port).toBe(9090);
  });

  it("preserves resolvedPath on unchanged imports across a rebuild", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Telo.Import",
      "metadata:",
      "  name: Lib",
      "source: ../lib",
      "",
    ].join("\n");
    const workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [], [
          { name: "Lib", source: "../lib", importKind: "local", resolvedPath: "/ws/lib/telo.yaml" },
        ]),
      ],
    );

    const rebuilt = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");
    const imp = rebuilt.modules.get("/ws/app/telo.yaml")!.imports.find((i) => i.name === "Lib")!;
    expect(imp.resolvedPath).toBe("/ws/lib/telo.yaml");
  });

  it("clears resolvedPath when an import's source changes", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Telo.Import",
      "metadata:",
      "  name: Lib",
      "source: ../other",
      "",
    ].join("\n");
    const workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        // Prev import resolvedPath points at old location; source in YAML differs.
        makeManifest("/ws/app/telo.yaml", [], [
          { name: "Lib", source: "../lib", importKind: "local", resolvedPath: "/ws/lib/telo.yaml" },
        ]),
      ],
    );

    const rebuilt = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");
    const imp = rebuilt.modules.get("/ws/app/telo.yaml")!.imports.find((i) => i.name === "Lib")!;
    expect(imp.source).toBe("../other");
    expect(imp.resolvedPath).toBeUndefined();
  });

  it("cleared text field (canvas emits \"\") persists as key: \"\" — not a delete", async () => {
    // Simulates the canvas contract: text-input clear → fields.host = "".
    // diffFields inside setResourceFields must emit `set value: ""` (not
    // `delete`), and the serialized YAML must retain `host: ""`.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "host: example.com",
      "",
    ].join("\n");
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [
          { kind: "Http.Server", name: "main", fields: { host: "example.com" } },
        ]),
      ],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Server",
      "main",
      { host: "example.com" },
      { host: "" },
    );

    const server = workspace.modules
      .get("/ws/app/telo.yaml")!
      .resources.find((r) => r.name === "main")!;
    expect(server.fields.host).toBe("");

    const adapter = stubAdapter();
    await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);
    const writtenText = adapter.writeFile.mock.calls[0]![1] as string;
    // Key survives as `host: ""` — must NOT have been deleted.
    expect(writtenText).toMatch(/host:\s*""/);
  });

  it("cleared number field (canvas emits null) persists as key: null — not a delete", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "port: 8080",
      "",
    ].join("\n");
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [
          { kind: "Http.Server", name: "main", fields: { port: 8080 } },
        ]),
      ],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Server",
      "main",
      { port: 8080 },
      { port: null },
    );

    const adapter = stubAdapter();
    await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);
    const writtenText = adapter.writeFile.mock.calls[0]![1] as string;
    expect(writtenText).toMatch(/port:\s*null/);
  });

  it("undefined field (explicit remove-field affordance) deletes the key", async () => {
    // Reserved for the future explicit "remove field" canvas action. The
    // diff convention is documented; this test locks it in so a later
    // canvas feature can rely on the `undefined → delete` path.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "host: example.com",
      "",
    ].join("\n");
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [
          { kind: "Http.Server", name: "main", fields: { host: "example.com" } },
        ]),
      ],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Server",
      "main",
      { host: "example.com" },
      {},
    );

    const adapter = stubAdapter();
    await saveModuleFromDocuments(workspace, "/ws/app/telo.yaml", adapter);
    const writtenText = adapter.writeFile.mock.calls[0]![1] as string;
    expect(writtenText).not.toMatch(/host:/);
  });

  it("handleSourceEdit-equivalent: non-canonical filePath stores under single canonical key", () => {
    // Regression: the prior `documents.set(rawPath, ...)` + defensive
    // dual-set created two entries when the caller passed `/foo/./bar`
    // while the map was keyed `/foo/bar`. The invariant is: one entry,
    // canonical key only.
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [makeManifest("/ws/app/telo.yaml")],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    // Simulate handleSourceEdit's canonical-set idiom.
    const rawPath = "/ws/app/./telo.yaml";
    const key = rawPath.replace("/./", "/"); // normalizePath equivalent
    const documents = new Map(workspace.documents);
    documents.set(key, parseModuleDocument(rawPath, text));

    expect(documents.has("/ws/app/telo.yaml")).toBe(true);
    expect(documents.has(rawPath)).toBe(false);
  });

  it("routes: add a new route via setResourceFields, then edit its path — the edit must be applied", () => {
    // Simulates RouterTopologyCanvas.handleAddRoute followed by
    // DetailPanel.applyPointerEdit.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Api",
      "metadata:",
      "  name: HelloApi",
      "routes:",
      "  - request:",
      "      path: /hello",
      "      method: GET",
      "",
    ].join("\n");
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [
        makeManifest("/ws/app/telo.yaml", [
          {
            kind: "Http.Api",
            name: "HelloApi",
            fields: {
              routes: [{ request: { path: "/hello", method: "GET" } }],
            },
          },
        ]),
      ],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    // Step 1 — simulate "+ Add route" with default matcher.
    let prev = workspace.modules.get("/ws/app/telo.yaml")!.resources.find(
      (r) => r.name === "HelloApi",
    )!;
    const afterAdd = {
      ...prev.fields,
      routes: [
        ...(prev.fields.routes as unknown[]),
        { request: { path: "/", method: "GET" } },
      ],
    };
    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Api",
      "HelloApi",
      prev.fields,
      afterAdd,
    );

    prev = workspace.modules.get("/ws/app/telo.yaml")!.resources.find(
      (r) => r.name === "HelloApi",
    )!;
    const routesAfterAdd = prev.fields.routes as Array<Record<string, unknown>>;
    expect(routesAfterAdd).toHaveLength(2);
    expect((routesAfterAdd[1].request as Record<string, unknown>).path).toBe("/");

    // Step 2 — simulate editing the new route's path via the detail panel.
    const afterEdit = {
      ...prev.fields,
      routes: (prev.fields.routes as Array<Record<string, unknown>>).map(
        (route, i) =>
          i === 1
            ? { ...route, request: { path: "/world", method: "GET" } }
            : route,
      ),
    };
    workspace = setResourceFields(
      workspace,
      "/ws/app/telo.yaml",
      "Http.Api",
      "HelloApi",
      prev.fields,
      afterEdit,
    );

    const finalRoutes = workspace.modules
      .get("/ws/app/telo.yaml")!
      .resources.find((r) => r.name === "HelloApi")!.fields.routes as Array<
      Record<string, unknown>
    >;
    expect(finalRoutes).toHaveLength(2);
    expect((finalRoutes[1].request as Record<string, unknown>).path).toBe("/world");
  });

  it("createResourceViaAst appends a new resource visible in the re-derived manifest", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    let workspace = makeWorkspace(
      [{ path: "/ws/app/telo.yaml", text }],
      [makeManifest("/ws/app/telo.yaml")],
    );
    workspace = rebuildManifestFromDocuments(workspace, "/ws/app/telo.yaml");

    workspace = createResourceViaAst(workspace, "/ws/app/telo.yaml", "Http.Server", "main", {
      port: 8080,
    });

    const manifest = workspace.modules.get("/ws/app/telo.yaml")!;
    const server = manifest.resources.find((r) => r.name === "main");
    expect(server).toBeDefined();
    expect(server!.fields.port).toBe(8080);

    // The new resource should be indexed under resourceDocIndex.
    const indexEntry = workspace.resourceDocIndex
      .get("/ws/app/telo.yaml")!
      .get("Http.Server::main");
    expect(indexEntry).toBeDefined();
  });
});
