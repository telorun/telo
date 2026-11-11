import { sha256Base64Url } from "@telorun/analyzer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, WorkspaceAdapter } from "../model";
import {
  buildRemoteImportPlan,
  collectClaimedRemoteFiles,
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
    readBytes: vi.fn(async () => new Uint8Array()),
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
      "/workspace/apps/hello": [{ name: "telo.yaml", isDirectory: false, kind: "file" }],
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

describe("buildRemoteImportPlan — pinned oci ref", () => {
  const CACHE_URL = "https://manifests.telo.sh/oci/ghcr.io/acme/hello/1.2.0/telo.yaml";
  const PUBLISHED_YAML = `kind: Telo.Application
metadata:
  name: HelloApp
  version: 1.2.0
imports:
  Console: oci://ghcr.io/telorun/console@0.18.1
layers:
  - role: controller
    selector: { format: js }
    blob: sha256:${"a".repeat(64)}
    integrity: sha256-${"A".repeat(43)}
  - role: assets
    blob: sha256:${"b".repeat(64)}
    integrity: sha256-${"B".repeat(43)}
`;

  function stubCache(text: string, status = 200, statusText = "OK") {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function pinned(text: string): Promise<string> {
    return `oci://ghcr.io/acme/hello@1.2.0#sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;
  }

  it("copies the cached manifest verbatim and lists the uncopied layers", async () => {
    const fetchMock = stubCache(PUBLISHED_YAML);
    const plan = await buildRemoteImportPlan(await pinned(PUBLISHED_YAML), listDirAdapter({}));
    expect(fetchMock).toHaveBeenCalledWith(CACHE_URL);
    expect(plan.files).toEqual([
      expect.objectContaining({
        destPath: "/workspace/apps/hello-app/telo.yaml",
        text: PUBLISHED_YAML,
        isRoot: true,
      }),
    ]);
    expect(plan.imports).toEqual([
      expect.objectContaining({ name: "Console", source: "oci://ghcr.io/telorun/console@0.18.1" }),
    ]);
    expect(plan.published).toEqual({ uncopiedLayers: ["controller js", "assets"] });
  });

  it("lists no layers when the manifest has no layers: index", async () => {
    const bare = "kind: Telo.Library\nmetadata:\n  name: HelloLib\n  version: 1.2.0\n";
    stubCache(bare);
    const plan = await buildRemoteImportPlan(await pinned(bare), listDirAdapter({}));
    expect(plan.kind).toBe("Library");
    expect(plan.published).toEqual({ uncopiedLayers: [] });
  });

  it.each([
    "oci://ghcr.io/acme/hello@1.2.0",
    `oci://ghcr.io/acme/hello#sha256-${"A".repeat(43)}`,
  ])("refuses %s, which lacks a version or a pin", async (ref) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(buildRemoteImportPlan(ref, listDirAdapter({}))).rejects.toThrow(
      "Studio opens a published application only by version and pin: oci://<host>/<repo>@<version>#sha256-<pin>",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the page fragment when the pin arrived there unencoded", async () => {
    await expect(
      buildRemoteImportPlan("oci://ghcr.io/acme/hello@1.2.0", listDirAdapter({}), [], {
        pageFragment: `#sha256-${"A".repeat(43)}`,
      }),
    ).rejects.toThrow("the pin arrived as the page fragment — percent-encode `#` as `%23`");
  });

  it("explains a version the manifest cache does not hold", async () => {
    stubCache("", 404, "Not Found");
    await expect(buildRemoteImportPlan(await pinned(PUBLISHED_YAML), listDirAdapter({}))).rejects.toThrow(
      `${CACHE_URL} has no copy of oci://ghcr.io/acme/hello@1.2.0 (HTTP 404). Studio reads published ` +
        "applications through the hub's manifest cache, which holds only versions a hub has ingested — " +
        "register oci://ghcr.io/acme/hello with the hub and open this link again once the hub reports it ready.",
    );
  });

  it("passes any other fetch failure through verbatim", async () => {
    stubCache("", 500, "Internal Server Error");
    const ref = await pinned(PUBLISHED_YAML);
    const error = await buildRemoteImportPlan(ref, listDirAdapter({})).catch((e) => e);
    expect(error.message).toBe(
      `Failed to fetch manifest ${ref}: 500 Internal Server Error (${CACHE_URL})`,
    );
  });

  it("refuses bytes that do not match the pin with the integrity error", async () => {
    stubCache(PUBLISHED_YAML.replace("HelloApp", "Tampered"));
    const ref = await pinned(PUBLISHED_YAML);
    const pin = ref.slice(ref.indexOf("#") + 1);
    const error = await buildRemoteImportPlan(ref, listDirAdapter({})).catch((e) => e);
    expect(error.name).toBe("IntegrityError");
    expect(error.message.startsWith(`Integrity check failed for ${ref}: expected ${pin}, got sha256-`)).toBe(
      true,
    );
  });
});

describe("collectClaimedRemoteFiles", () => {
  const root = "https://h/app/telo.yaml";
  const dest = "/workspace/apps/slug/telo.yaml";
  const claiming = (path: string, tag = "module-path") =>
    `kind: Telo.Application\nmetadata: { name: A }\nicon: !${tag} ${path}\n`;

  function stubBodies(bodies: Record<string, Uint8Array | number>): string[] {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        const body = bodies[url];
        if (typeof body === "number") {
          return { ok: false, status: body, statusText: "Nope" } as Response;
        }
        if (!body) return { ok: false, status: 404, statusText: "Not Found" } as Response;
        return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => body.buffer } as Response;
      }),
    );
    return requested;
  }

  it("copies a file a tag claims from beside the module's manifest", async () => {
    const requested = stubBodies({ "https://h/app/telo-mark.svg": new TextEncoder().encode("<svg/>") });
    const out = await collectClaimedRemoteFiles(
      root,
      dest,
      [mod(root, claiming("./telo-mark.svg"))],
      new Set([dest]),
    );
    expect(requested).toEqual(["https://h/app/telo-mark.svg"]);
    expect(out.files).toEqual([
      {
        url: "https://h/app/telo-mark.svg",
        destPath: "/workspace/apps/slug/telo-mark.svg",
        text: "<svg/>",
        isRoot: false,
        exists: false,
      },
    ]);
    expect(out.errors).toEqual([]);
  });

  it("does not fetch a file the plan already holds", async () => {
    const requested = stubBodies({});
    const out = await collectClaimedRemoteFiles(
      root,
      dest,
      [mod(root, claiming("./telo-mark.svg"))],
      new Set([dest, "/workspace/apps/slug/telo-mark.svg"]),
    );
    expect(requested).toEqual([]);
    expect(out.files).toEqual([]);
  });

  it("reports a file the origin does not serve as an error", async () => {
    stubBodies({});
    const out = await collectClaimedRemoteFiles(root, dest, [mod(root, claiming("./gone.svg"))], new Set());
    expect(out.files).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ url: "https://h/app/gone.svg" });
    expect(out.errors[0].message).toMatch(/^HTTP 404 Not Found/);
  });

  it("reports a binary file, which the workspace cannot store, as an error", async () => {
    stubBodies({ "https://h/app/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) });
    const out = await collectClaimedRemoteFiles(root, dest, [mod(root, claiming("./logo.png"))], new Set());
    expect(out.files).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.errors).toEqual([
      { url: "https://h/app/logo.png", message: expect.stringContaining("binary file") },
    ]);
  });

  it("skips cross-origin modules", async () => {
    const requested = stubBodies({});
    await collectClaimedRemoteFiles(
      root,
      dest,
      [mod("https://other/telo.yaml", claiming("./x.svg"))],
      new Set(),
    );
    expect(requested).toEqual([]);
  });
});

describe("buildRemoteImportPlan — an http root that claims a file", () => {
  const ROOT = "https://raw.example/app/telo.yaml";
  const YAML = `kind: Telo.Application
metadata:
  name: IconApp
  version: 1.0.0
targets: [!ref icon]
---
kind: Telo.Provider
metadata: { name: icon }
file: !module-path ./mark.svg
`;

  function serve(files: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const text = files[url];
        if (text === undefined) return { ok: false, status: 404, statusText: "Not Found", body: null } as Response;
        const bytes = new TextEncoder().encode(text);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body:
            init?.method === "HEAD"
              ? null
              : new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                }),
          text: async () => text,
          arrayBuffer: async () => bytes.buffer,
        } as Response;
      }),
    );
  }

  it("copies the claimed file beside the manifest into the plan", async () => {
    serve({ [ROOT]: YAML, "https://raw.example/app/mark.svg": "<svg/>" });
    const plan = await buildRemoteImportPlan(ROOT, listDirAdapter({}));
    expect(plan.files.map((f) => f.destPath)).toEqual([
      "/workspace/apps/icon-app/telo.yaml",
      "/workspace/apps/icon-app/mark.svg",
    ]);
    expect(plan.files[1].text).toBe("<svg/>");
    expect(plan.errors).toEqual([]);
  });

  it("lists a claimed file the origin does not serve as an error", async () => {
    serve({ [ROOT]: YAML });
    const plan = await buildRemoteImportPlan(ROOT, listDirAdapter({}));
    expect(plan.files.map((f) => f.destPath)).toEqual(["/workspace/apps/icon-app/telo.yaml"]);
    expect(plan.errors.map((e) => e.url)).toEqual(["https://raw.example/app/mark.svg"]);
  });
});
