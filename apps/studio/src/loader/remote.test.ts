import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, WorkspaceAdapter } from "../model";
import {
  collectPlanFiles,
  fetchRemoteManifest,
  manifestExists,
  readManifestUrlParam,
  slugifyModuleName,
  workspacePathFor,
} from "./remote";

function mod(source: string, text: string, partials: { source: string; text: string }[] = []) {
  return [source, { owner: { source, text }, partials }] as const;
}

const APP_YAML = `kind: Telo.Application
metadata:
  name: HelloApiExample
  version: 1.0.0
`;

function listDirAdapter(entriesByDir: Record<string, DirEntry[]>): WorkspaceAdapter {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    listDir: vi.fn(async (dir: string) => entriesByDir[dir] ?? []),
    createDir: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  };
}

function stubFetch(impl: (url: string) => Partial<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = impl(url);
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        statusText: r.statusText ?? "OK",
        text: r.text ?? (async () => ""),
        ...r,
      } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slugifyModuleName", () => {
  it("kebab-cases camelCase", () => {
    expect(slugifyModuleName("HelloApiExample")).toBe("hello-api-example");
  });

  it("splits trailing acronym boundaries", () => {
    expect(slugifyModuleName("HTTPServer")).toBe("http-server");
  });

  it("collapses non-alphanumeric runs and trims", () => {
    expect(slugifyModuleName("  my__module!! ")).toBe("my-module");
  });
});

describe("readManifestUrlParam", () => {
  it("reads the manifest param", () => {
    expect(readManifestUrlParam("?open=https://x/telo.yaml")).toBe("https://x/telo.yaml");
  });

  it("returns null when absent or blank", () => {
    expect(readManifestUrlParam("")).toBeNull();
    expect(readManifestUrlParam("?open=")).toBeNull();
    expect(readManifestUrlParam("?open=%20%20%20")).toBeNull();
    expect(readManifestUrlParam("?other=1")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(readManifestUrlParam("?open=%20https://x/telo.yaml%20")).toBe(
      "https://x/telo.yaml",
    );
  });
});

describe("manifestExists", () => {
  it("detects an existing file in its directory", async () => {
    const adapter = listDirAdapter({
      "/workspace/apps/hello": [{ name: "telo.yaml", isDirectory: false }],
    });
    expect(await manifestExists(adapter, "/workspace/apps/hello/telo.yaml")).toBe(true);
  });

  it("returns false when the file is absent", async () => {
    const adapter = listDirAdapter({ "/workspace/apps/hello": [] });
    expect(await manifestExists(adapter, "/workspace/apps/hello/telo.yaml")).toBe(false);
  });
});

describe("fetchRemoteManifest", () => {
  it("resolves the destination from metadata.name", async () => {
    stubFetch(() => ({ text: async () => APP_YAML }));
    const remote = await fetchRemoteManifest("https://raw/x/hello-api.yaml");
    expect(remote.metadataName).toBe("HelloApiExample");
    expect(remote.slug).toBe("hello-api-example");
    expect(remote.destPath).toBe("/workspace/apps/hello-api-example/telo.yaml");
    expect(remote.text).toBe(APP_YAML);
  });

  it("throws on a non-OK response", async () => {
    stubFetch(() => ({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(fetchRemoteManifest("https://raw/x/missing.yaml")).rejects.toThrow(/HTTP 404/);
  });

  it("rejects non-http(s) URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      fetchRemoteManifest("data:text/yaml,kind: Telo.Application"),
    ).rejects.toThrow(/only http and https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs", async () => {
    await expect(fetchRemoteManifest("not a url")).rejects.toThrow(/Invalid manifest URL/);
  });

  it("throws on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("boom");
    }));
    await expect(fetchRemoteManifest("https://raw/x/a.yaml")).rejects.toThrow(/CORS/);
  });

  it("throws when there is no Application or Library document", async () => {
    stubFetch(() => ({ text: async () => "kind: Http.Server\nmetadata:\n  name: srv\n" }));
    await expect(fetchRemoteManifest("https://raw/x/a.yaml")).rejects.toThrow(
      /no Telo.Application or Telo.Library/,
    );
  });

  it("throws when metadata.name is missing", async () => {
    stubFetch(() => ({ text: async () => "kind: Telo.Application\nmetadata:\n  version: 1.0.0\n" }));
    await expect(fetchRemoteManifest("https://raw/x/a.yaml")).rejects.toThrow(/missing metadata.name/);
  });
});

describe("workspacePathFor", () => {
  const root = "https://h/a/b/root.yaml";
  const dest = "/workspace/apps/slug/telo.yaml";

  it("maps a sibling next to the root", () => {
    expect(workspacePathFor(root, dest, "https://h/a/b/dep.yaml")).toBe(
      "/workspace/apps/slug/dep.yaml",
    );
  });

  it("maps a subdirectory module", () => {
    expect(workspacePathFor(root, dest, "https://h/a/b/lib/telo.yaml")).toBe(
      "/workspace/apps/slug/lib/telo.yaml",
    );
  });

  it("maps a parent-directory dependency that stays inside the workspace", () => {
    expect(workspacePathFor(root, dest, "https://h/a/shared.yaml")).toBe(
      "/workspace/apps/shared.yaml",
    );
  });

  it("throws when a dependency would escape the workspace", () => {
    expect(() =>
      workspacePathFor("https://h/a/b/c/d/root.yaml", dest, "https://h/x.yaml"),
    ).toThrow(/outside the workspace/);
  });
});

describe("collectPlanFiles", () => {
  const root = "https://h/a/b/root.yaml";
  const dest = "/workspace/apps/slug/telo.yaml";

  it("maps the root and same-origin deps, root first", () => {
    const files = collectPlanFiles(root, dest, [
      mod("https://h/a/b/dep.yaml", "DEP"),
      mod(root, "ROOT"),
    ]);
    expect(files[0]).toMatchObject({ isRoot: true, destPath: dest });
    expect(files.map((f) => f.destPath)).toEqual([dest, "/workspace/apps/slug/dep.yaml"]);
  });

  it("skips cross-origin modules", () => {
    const files = collectPlanFiles(root, dest, [
      mod(root, "ROOT"),
      mod("https://other/x.yaml", "X"),
    ]);
    expect(files.map((f) => f.url)).not.toContain("https://other/x.yaml");
    expect(files).toHaveLength(1);
  });

  it("skips a cross-origin include partial of a same-origin module", () => {
    const files = collectPlanFiles(root, dest, [
      mod(root, "ROOT"),
      mod("https://h/a/b/m.yaml", "M", [{ source: "https://evil/p.yaml", text: "P" }]),
    ]);
    const urls = files.map((f) => f.url);
    expect(urls).toContain("https://h/a/b/m.yaml");
    expect(urls).not.toContain("https://evil/p.yaml");
  });

  it("throws when two distinct sources map to the same workspace path", () => {
    expect(() =>
      collectPlanFiles(root, dest, [
        mod(root, "ROOT"),
        mod("https://h/a/b/dep.yaml?v=1", "A"),
        mod("https://h/a/b/dep.yaml?v=2", "B"),
      ]),
    ).toThrow(/cannot import safely/);
  });
});
