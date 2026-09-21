import type { GraphNode, GraphRow, ModuleGraph } from "@telorun/analyzer";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it, vi } from "vitest";
import { moduleRootResource } from "../../../application-adapter";
import {
  moveResourceFieldItem,
  rebuildManifestFromDocuments,
  removeResourceFieldItem,
  saveModuleFromDocuments,
  setModuleRootFields,
} from "../../../loader";
import type { ParsedManifest, Workspace, WorkspaceAdapter } from "../../../model";
import { parseModuleDocument } from "../../../yaml-document";
import type { RefResolver } from "../../resource-schema-form/ref-candidates";
import {
  BOOT_FIELD,
  bootEntries,
  bootEntryLabel,
  bootEntryPointer,
  bootMarkers,
  bootToggleAction,
  canStartAtBoot,
  withBootTarget,
  withoutBootEntries,
} from "./boot-targets";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind: "x.Kind", name: id, ownership: "named", ports: [], rows: [], rowArrays: [], ...over }) as GraphNode;

const targetRow = (index: number, target: string, targetNode?: string): GraphRow =>
  ({
    id: `row${index}`,
    kind: "target",
    path: `targets[${index}]`,
    array: "targets",
    index,
    depth: 0,
    target,
    ...(targetNode ? { targetNode } : {}),
  }) as GraphRow;

function graphOf(root: GraphNode, nodes: GraphNode[]): ModuleGraph {
  const all = [root, ...nodes];
  return {
    root,
    nodes: all,
    edges: [],
    regions: [],
    kinds: [],
    nodeById: (id: string) => all.find((n) => n.id === id),
    edgesFrom: () => [],
    edgesTo: () => [],
  } as ModuleGraph;
}

const applicationRoot = (rows: GraphRow[] = []): GraphNode =>
  node("app", {
    root: true,
    ownership: "root",
    kind: "Telo.Application",
    rows,
    rowArrays: [{ field: "targets", kind: "target" }],
    ports: [
      {
        slot: "targets[]",
        refs: ["Telo.Runnable", "Telo.Service"],
        capabilities: [],
        array: true,
        class: "flow",
        slots: [],
        rowOwned: true,
      },
    ],
  });

const ref = (name: string) => makeTaggedSentinel("ref", name);
const cel = (source: string) => makeTaggedSentinel("cel", source);

describe("the boot sequence's entries", () => {
  it("lists all three spellings in order, with what each runs and its guard", () => {
    const entries = bootEntries([
      ref("server"),
      { ref: ref("migrate"), when: cel("variables.migrate") },
      { name: "seed", invoke: ref("seeder"), inputs: { count: 3 } },
    ]);
    expect(entries).toEqual([
      { index: 0, form: "ref", target: "server" },
      { index: 1, form: "gated", target: "migrate", when: "variables.migrate" },
      { index: 2, form: "step", target: "seeder", name: "seed" },
    ]);
    expect(entries.map(bootEntryLabel)).toEqual(["server", "migrate", "seed"]);
  });
});

describe("the boot marker on a resource", () => {
  it("carries its position, marks a gated entry conditional, and marks a step's target as invoked", () => {
    const graph = graphOf(
      applicationRoot([
        targetRow(0, "server", "server"),
        targetRow(1, "migrate", "migrate"),
        targetRow(2, "seeder", "seeder"),
      ]),
      [node("server"), node("migrate"), node("seeder")],
    );
    const markers = bootMarkers(
      bootEntries([
        ref("server"),
        { ref: ref("migrate"), when: cel("variables.migrate") },
        { name: "seed", invoke: ref("seeder"), when: cel("variables.seed") },
      ]),
      graph,
    );
    expect(Object.fromEntries(markers)).toEqual({
      server: [{ index: 0, position: 1, variant: "started" }],
      migrate: [{ index: 1, position: 2, variant: "started", when: "variables.migrate" }],
      seeder: [
        { index: 2, position: 3, variant: "invoked", name: "seed", when: "variables.seed" },
      ],
    });
  });
});

describe("which resources may be started at boot", () => {
  const resolver: RefResolver = {
    acceptedKindsForRef: (target) =>
      target === "Telo.Runnable"
        ? new Set(["x.Job"])
        : target === "Telo.Service"
          ? new Set(["x.Server"])
          : undefined,
    resolveKind: (kind) => kind,
  };

  it("offers what the `targets` slot accepts and nothing else, and nothing in a Library", () => {
    const job = node("job", { kind: "x.Job" });
    const server = node("server", { kind: "x.Server" });
    const handler = node("handler", { kind: "x.Handler" });
    const app = graphOf(applicationRoot(), [job, server, handler]);
    expect([job, server, handler].map((n) => canStartAtBoot(n, app, resolver))).toEqual([
      true,
      true,
      false,
    ]);

    const library = graphOf(
      node("lib", {
        root: true,
        ownership: "root",
        kind: "Telo.Library",
        rowArrays: [{ field: "exports.resources", kind: "export" }],
      }),
      [job],
    );
    expect(canStartAtBoot(job, library, resolver)).toBe(false);
  });

  it("toggles a resource the sequence only invokes OFF rather than starting it again", () => {
    const handler = node("handler", { kind: "x.Handler" });
    const job = node("job", { kind: "x.Job" });
    const graph = graphOf(applicationRoot([targetRow(0, "handler", "handler")]), [handler, job]);
    const markers = bootMarkers(bootEntries([{ invoke: ref("handler") }]), graph);
    expect(bootToggleAction(handler, graph, resolver, markers.get("handler"))).toBe("stop");
    expect(bootToggleAction(job, graph, resolver, markers.get("job"))).toBe("start");
  });
});

function applicationWorkspace(text: string): Workspace {
  const path = "/ws/app/telo.yaml";
  const manifest: ParsedManifest = {
    filePath: path,
    kind: "Application",
    metadata: { name: "app" },
    targets: [],
    imports: [],
    resources: [],
  };
  return rebuildManifestFromDocuments(
    {
      rootDir: "/ws",
      modules: new Map([[path, manifest]]),
      importGraph: new Map(),
      importedBy: new Map(),
      documents: new Map([[path, parseModuleDocument(path, text)]]),
      resourceDocIndex: new Map(),
    },
    path,
  );
}

const PATH = "/ws/app/telo.yaml";
const rootOf = (workspace: Workspace) => moduleRootResource(workspace.modules.get(PATH)!);
const textOf = (workspace: Workspace) =>
  workspace.documents.get(PATH)!.loaded.documents[0].toString();

const APP = [
  "kind: Telo.Application",
  "metadata:",
  "  name: app",
  "logging:",
  "  level: info",
  "targets:",
  "  # the server",
  "  - !ref server",
  "  - ref: !ref migrate",
  '    when: !cel "variables.migrate"',
  "  - name: seed",
  "    invoke: !ref seeder",
  "    inputs:",
  "      count: 3",
  "",
].join("\n");

describe("editing the boot sequence in the manifest", () => {
  it("removes a started resource's entry and appends it back as `!ref <name>`", () => {
    let workspace = applicationWorkspace(APP);
    workspace = removeResourceFieldItem(workspace, PATH, "Telo.Application", "app", bootEntryPointer(0));
    expect(textOf(workspace)).not.toContain("!ref server");
    expect(bootEntries(rootOf(workspace).fields[BOOT_FIELD]).map((e) => e.target)).toEqual([
      "migrate",
      "seeder",
    ]);

    const root = rootOf(workspace);
    workspace = setModuleRootFields(workspace, PATH, root.kind, root.name, root.fields, {
      ...root.fields,
      [BOOT_FIELD]: withBootTarget(root.fields[BOOT_FIELD], "server"),
    });
    expect(textOf(workspace)).toMatch(/- !ref server\n$/);
    expect(bootEntries(rootOf(workspace).fields[BOOT_FIELD]).map((e) => e.target)).toEqual([
      "migrate",
      "seeder",
      "server",
    ]);
  });

  it("drops several entries starting one resource in one write", () => {
    expect(withoutBootEntries([ref("a"), ref("b"), ref("a")], [0, 2])).toEqual([ref("b")]);
  });

  it("reorders an entry in place, keeping its tag", () => {
    const workspace = moveResourceFieldItem(
      applicationWorkspace(APP),
      PATH,
      "Telo.Application",
      "app",
      bootEntryPointer(0),
      1,
    );
    expect(bootEntries(rootOf(workspace).fields[BOOT_FIELD]).map((e) => e.target)).toEqual([
      "migrate",
      "server",
      "seeder",
    ]);
    expect(textOf(workspace)).toContain('    when: !cel "variables.migrate"\n  - !ref server\n');
  });

  it("writes nothing on save when the entries and logging were opened and not touched", async () => {
    const workspace = applicationWorkspace(APP);
    const root = rootOf(workspace);
    const unchanged = setModuleRootFields(workspace, PATH, root.kind, root.name, root.fields, {
      ...root.fields,
    });
    expect(unchanged).toBe(workspace);
    const adapter = {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      listDir: vi.fn(async () => []),
      createDir: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
    } satisfies WorkspaceAdapter;
    await saveModuleFromDocuments(unchanged, PATH, adapter);
    expect(adapter.writeFile).not.toHaveBeenCalled();
  });

  it("edits `logging:` through the module root without touching the boot sequence", () => {
    let workspace = applicationWorkspace(APP);
    const root = rootOf(workspace);
    expect(root.fields.logging).toEqual({ level: "info" });
    workspace = setModuleRootFields(workspace, PATH, root.kind, root.name, root.fields, {
      ...root.fields,
      logging: { level: "debug" },
    });
    expect(textOf(workspace)).toBe(APP.replace("level: info", "level: debug"));
  });
});
