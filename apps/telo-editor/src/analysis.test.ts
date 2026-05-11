import type { ManifestSource } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "./analysis";
import { loadWorkspace } from "./loader";
import type { DirEntry, WorkspaceAdapter } from "./model";

/** In-memory ManifestSource + WorkspaceAdapter pair for editor tests. Holds
 *  a flat path → text map and serves disk-style URLs. Mirrors the shape of
 *  `LocalStorageAdapter` so `loadWorkspace` exercises the same code paths
 *  the browser host runs. */
function inMemoryAdapter(files: Record<string, string>) {
  const map = new Map(Object.entries(files));

  const adapter: ManifestSource & WorkspaceAdapter = {
    supports(url: string): boolean {
      return !url.startsWith("http") && !url.startsWith("pkg:");
    },
    async read(url: string) {
      const text = map.get(url);
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    async readFile(path: string) {
      const text = map.get(path);
      if (text === undefined) throw new Error(`File not found: ${path}`);
      return text;
    },
    async writeFile(path: string, text: string) {
      map.set(path, text);
    },
    async listDir(path: string): Promise<DirEntry[]> {
      const prefix = path.endsWith("/") ? path : path + "/";
      const seen = new Map<string, boolean>();
      for (const k of map.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash === -1) seen.set(rest, false);
        else seen.set(rest.slice(0, slash), true);
      }
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async createDir() {},
    async delete(path: string) {
      const prefix = path + "/";
      for (const k of [...map.keys()]) {
        if (k === path || k.startsWith(prefix)) map.delete(k);
      }
    },
    resolveRelative(base: string, relative: string): string {
      if (relative.startsWith("/")) return relative;
      const baseDir = base.slice(0, base.lastIndexOf("/") + 1);
      const parts = (baseDir + relative).split("/");
      const out: string[] = [];
      for (const p of parts) {
        if (p === "" && out.length === 0) {
          out.push("");
          continue;
        }
        if (p === "" || p === ".") continue;
        if (p === "..") {
          if (out.length > 1) out.pop();
          continue;
        }
        out.push(p);
      }
      let resolved = out.join("/");
      if (!/\.[^/]+$/.test(resolved)) resolved += "/telo.yaml";
      return resolved;
    },
  };

  return adapter;
}

/** ManifestSource that resolves registry-style refs (`namespace/name@version`)
 *  through a fixed in-memory map. Mirrors what `RegistrySource` does at
 *  runtime; lets tests exercise the editor's Phase 2a registry-import path
 *  without spinning up a real registry server. */
function inMemoryRegistry(refToFiles: Record<string, Record<string, string>>): ManifestSource {
  return {
    supports(url: string): boolean {
      // Registry refs: `namespace/name@version` (no `://`, includes `/` and `@`).
      return /[^/]+\/[^/]+@/.test(url) && !url.includes("://");
    },
    async read(url: string) {
      const files = refToFiles[url];
      if (!files) throw new Error(`Registry: no entry for ${url}`);
      const ownerKey = Object.keys(files).find((k) => k.endsWith("telo.yaml"));
      if (!ownerKey) throw new Error(`Registry: no telo.yaml in ${url}`);
      // Source URL is the canonical "registry resolved" form — the editor
      // keys imported modules by this string.
      return { text: files[ownerKey], source: `registry://${url}/telo.yaml` };
    },
    resolveRelative(base: string, relative: string): string {
      // Registry-served files don't resolve relative imports back to disk;
      // tests don't need this so we throw a clear error if hit.
      throw new Error(`inMemoryRegistry: resolveRelative(${base}, ${relative})`);
    },
  };
}

describe("analyzeWorkspace — imported library kinds", () => {
  it("resolves Telo.Definition kinds from a workspace-local Telo.Library import", async () => {
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Http",
        "source: ../http",
        "---",
        "kind: Http.Server",
        "metadata:",
        "  name: main",
        "port: 8080",
        "",
      ].join("\n"),
      "/ws/http/telo.yaml": [
        "kind: Telo.Library",
        "metadata:",
        "  name: http",
        "  version: 1.0.0",
        "exports:",
        "  kinds:",
        "    - Server",
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Server",
        "capability: Telo.Service",
        "controllers:",
        "  pkg:npm: '@telorun/http-server'",
        "schema:",
        "  type: object",
        "  properties:",
        "    port: { type: integer }",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);

    // The import's resolvedPath should point at the library's owner file.
    const appManifest = workspace.modules.get("/ws/app/telo.yaml");
    expect(appManifest, "app manifest should be loaded").toBeTruthy();
    const httpImport = appManifest!.imports.find((i) => i.name === "Http");
    expect(httpImport?.resolvedPath).toBe("/ws/http/telo.yaml");
    expect(workspace.modules.has("/ws/http/telo.yaml")).toBe(true);

    const diagnostics = analyzeWorkspace(workspace);

    // Collect every diagnostic across resource/file buckets.
    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) all.push({ code: d.code, message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) all.push({ code: d.code, message: d.message });
    }

    const undefinedKind = all.filter((d) => d.code === "UNDEFINED_KIND");
    expect(
      undefinedKind,
      `expected no UNDEFINED_KIND diagnostics, got: ${JSON.stringify(undefinedKind, null, 2)}`,
    ).toHaveLength(0);
  });

  it("resolves Telo.Definition kinds from a registry-style Telo.Library import", async () => {
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Http",
        "source: std/http@1.0.0",
        "---",
        "kind: Http.Server",
        "metadata:",
        "  name: main",
        "port: 8080",
        "",
      ].join("\n"),
    };

    const registryFiles: Record<string, Record<string, string>> = {
      "std/http@1.0.0": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata:",
          "  name: http",
          "  version: 1.0.0",
          "exports:",
          "  kinds:",
          "    - Server",
          "---",
          "kind: Telo.Definition",
          "metadata:",
          "  name: Server",
          "capability: Telo.Service",
          "controllers:",
          "  pkg:npm: '@telorun/http-server'",
          "schema:",
          "  type: object",
          "  properties:",
          "    port: { type: integer }",
          "",
        ].join("\n"),
      },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);

    const appManifest = workspace.modules.get("/ws/app/telo.yaml");
    expect(appManifest, "app manifest should be loaded").toBeTruthy();
    const httpImport = appManifest!.imports.find((i) => i.name === "Http");
    expect(httpImport?.resolvedPath, "import should be resolved").toBeTruthy();
    expect(
      workspace.modules.has(httpImport!.resolvedPath!),
      `imported library should be registered at ${httpImport?.resolvedPath}`,
    ).toBe(true);

    const diagnostics = analyzeWorkspace(workspace);

    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) all.push({ code: d.code, message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) all.push({ code: d.code, message: d.message });
    }

    const undefinedKind = all.filter((d) => d.code === "UNDEFINED_KIND");
    expect(
      undefinedKind,
      `expected no UNDEFINED_KIND diagnostics, got: ${JSON.stringify(undefinedKind, null, 2)}`,
    ).toHaveLength(0);
  });

  it("resolves diagnostic positions per (kind, name), not name alone", async () => {
    // Two resources share `metadata.name: dup` but have different kinds.
    // Both emit UNDEFINED_KIND (no Telo.Definition for either kind).
    // The diagnostics' resolved ranges must reflect each resource's own
    // line. Pre-fix the positions map was keyed by name only, so the
    // later-emitted resource's positions overwrote the earlier one's.
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application", // doc 0, line 0
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Foo.A", // doc 1, line 5
        "metadata:",
        "  name: dup",
        "---",
        "kind: Bar.B", // doc 2, line 9
        "metadata:",
        "  name: dup",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);
    const diagnostics = analyzeWorkspace(workspace);

    const byResource = diagnostics.byResource.get("/ws/app/telo.yaml");
    expect(byResource).toBeTruthy();
    const dup = byResource!.get("dup");
    expect(dup).toBeTruthy();
    expect(dup!.length).toBeGreaterThanOrEqual(2);

    // Each UNDEFINED_KIND diagnostic carries the offending kind in its
    // message; pair the message with the resolved range to verify the
    // positions came from the resource that owns each kind.
    const fooA = dup!.find((d) => d.message.includes("'Foo.A'"));
    const barB = dup!.find((d) => d.message.includes("'Bar.B'"));
    expect(fooA, "Foo.A diagnostic should be present").toBeTruthy();
    expect(barB, "Bar.B diagnostic should be present").toBeTruthy();
    expect(
      fooA!.range.start.line,
      `Foo.A range should point to line 5 (its own location), not line 9`,
    ).toBe(5);
    expect(
      barB!.range.start.line,
      `Bar.B range should point to line 9 (its own location), not line 5`,
    ).toBe(9);
  });
});
