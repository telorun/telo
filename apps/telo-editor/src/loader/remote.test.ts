import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, WorkspaceAdapter } from "../model";
import {
  fetchRemoteManifest,
  manifestExists,
  readManifestUrlParam,
  slugifyModuleName,
} from "./remote";

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
