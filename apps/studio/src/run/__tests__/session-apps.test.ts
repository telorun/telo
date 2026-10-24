import { describe, expect, it } from "vitest";

import type { ParsedManifest, Workspace } from "../../model";
import { appSetStep, desiredAppSet, referenceOutsideWorkspace, sameAppSet, type WorkspaceApplication } from "../session-apps";

const ROOT = "/ws";

function application(path: string, name: string, telo: WorkspaceApplication["telo"] = { version: "0.122.0" }): WorkspaceApplication {
  return { filePath: `${ROOT}/${path}`, name, ports: [{ port: 3000, protocol: "tcp" }], telo };
}

describe("a workspace's app set", () => {
  it("names each Application inside the folder by a DNS label of its name, a clash taking a suffix", () => {
    const set = desiredAppSet(
      ROOT,
      [
        application("b/telo.yaml", "TodoApi"),
        application("a/telo.yaml", "TodoApi"),
        application("c/telo.yaml", "Agent"),
        application("d/telo.yaml", "日本"),
        { ...application("x", "Elsewhere"), filePath: "/other/telo.yaml" },
      ],
      false,
    );
    expect(set).toEqual({
      settled: true,
      versioned: false,
      apps: [
        { appPath: "/ws/a/telo.yaml", spec: { name: "todo-api", entryRelativePath: "a/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] } },
        { appPath: "/ws/b/telo.yaml", spec: { name: "todo-api-2", entryRelativePath: "b/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] } },
        { appPath: "/ws/c/telo.yaml", spec: { name: "app-agent", entryRelativePath: "c/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] } },
        { appPath: "/ws/d/telo.yaml", spec: { name: "app", entryRelativePath: "d/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] } },
      ],
    });
  });

  it("carries each app's telo version for a runner that aligns them, leaving out one with none and waiting on one still found", () => {
    const set = desiredAppSet(
      ROOT,
      [
        application("a/telo.yaml", "A"),
        application("b/telo.yaml", "B", { refusal: "no engine" }),
        application("c/telo.yaml", "C", { pending: true }),
      ],
      true,
    );
    expect(set.settled).toBe(false);
    expect(set.apps.map((a) => [a.spec.name, a.spec.telo])).toEqual([["a", "0.122.0"]]);
  });
});

describe("an app-set change", () => {
  const api = { name: "api", entryRelativePath: "api/telo.yaml", ports: [{ port: 3000, protocol: "tcp" as const }] };
  const worker = { name: "worker", entryRelativePath: "worker/telo.yaml" };

  it("is no change in another order", () => {
    expect(sameAppSet([api, worker], [worker, api])).toBe(true);
    expect(sameAppSet([api], [{ ...api, ports: [{ port: 3001, protocol: "tcp" }] }])).toBe(false);
    expect(sameAppSet([api], [{ ...api, telo: "0.122.0" }])).toBe(false);
  });

  it("waits while an agent turn runs and is applied otherwise", () => {
    expect(appSetStep([api], [api], true)).toBe("none");
    expect(appSetStep([api], [api, worker], true)).toBe("wait");
    expect(appSetStep([api], [api, worker], false)).toBe("apply");
  });
});

describe("a file a run needs from outside the opened folder", () => {
  function workspace(modules: Array<Partial<ParsedManifest> & { filePath: string }>): Workspace {
    return {
      rootDir: ROOT,
      modules: new Map(
        modules.map((m) => [m.filePath, { kind: "Library", metadata: { name: "M" }, imports: [], resources: [], ...m } as ParsedManifest]),
      ),
    } as Workspace;
  }

  it("is the first import or partial, through the closure, that resolves above the root", () => {
    const ws = workspace([
      {
        filePath: "/ws/app/telo.yaml",
        imports: [{ name: "Lib", source: "../lib", importKind: "local", resolvedPath: "/ws/lib/telo.yaml" }],
      },
      {
        filePath: "/ws/lib/telo.yaml",
        imports: [{ name: "Shared", source: "../../shared", importKind: "local", resolvedPath: "/shared/telo.yaml" }],
      },
    ]);
    expect(referenceOutsideWorkspace(ws, "/ws/app/telo.yaml")).toEqual({
      importer: "/ws/lib/telo.yaml",
      source: "../../shared",
      target: "/shared/telo.yaml",
    });
    expect(
      referenceOutsideWorkspace(workspace([{ filePath: "/ws/app/telo.yaml", include: ["../../parts.yaml"] }]), "/ws/app/telo.yaml"),
    ).toEqual({ importer: "/ws/app/telo.yaml", source: "../../parts.yaml", target: "/parts.yaml" });
  });

  it("is nothing when the closure stays inside, registry imports included", () => {
    const ws = workspace([
      {
        filePath: "/ws/app/telo.yaml",
        include: ["parts/*.yaml"],
        imports: [
          { name: "Lib", source: "../lib", importKind: "local", resolvedPath: "/ws/lib/telo.yaml" },
          { name: "Http", source: "oci://ghcr.io/telorun/http-server@1.0.0", importKind: "oci" },
        ],
      },
      { filePath: "/ws/lib/telo.yaml" },
    ]);
    expect(referenceOutsideWorkspace(ws, "/ws/app/telo.yaml")).toBeNull();
  });
});
