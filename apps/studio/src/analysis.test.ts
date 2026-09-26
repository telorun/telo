import type { ManifestSource } from "@telorun/analyzer";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory, kind: isDirectory ? "directory" : "file" }) as const);
    },
    async createDir() {},
    async delete(path: string) {
      const prefix = path + "/";
      for (const k of [...map.keys()]) {
        if (k === path || k.startsWith(prefix)) map.delete(k);
      }
    },
    async rename(from: string, to: string) {
      const prefix = from + "/";
      for (const k of [...map.keys()]) {
        if (k === from || k.startsWith(prefix)) {
          map.set(to + k.slice(from.length), map.get(k)!);
          map.delete(k);
        }
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
 *  through a fixed in-memory map. Mirrors what `HttpSource` does at
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

    const analysis = await analyzeWorkspace(workspace, adapter, []);
    const registry = analysis.registryByFile.get("/ws/app/telo.yaml");
    expect(registry?.resolveDefinition("Http.Server")?.metadata.name).toBe("Server");
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

    const analysis = await analyzeWorkspace(workspace, adapter, [registry]);
    const appRegistry = analysis.registryByFile.get("/ws/app/telo.yaml");
    expect(appRegistry?.resolveDefinition("Http.Server")?.metadata.name).toBe("Server");
  });

  it("resolves x-telo-schema-from across a registry module's transitive INLINE import", async () => {
    // Regression: a registry module (`outer`) importing another registry module
    // (`inner`) via an inline `imports:` map, where `outer`'s definition anchors
    // an `x-telo-schema-from` at `Inner.<Kind>`. The editor used to never stamp
    // `resolvedModuleName` for the transitive inline import, so the alias
    // resolved to the version-suffixed source (`inner@1.0.0.Request`) and emitted
    // a false-positive SCHEMA_FROM_MISSING_PATH. Driving the analyzer's own
    // loadGraph + flattenForAnalyzer resolves identity exactly like `telo check`.
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Outer: std/outer@1.0.0",
        "---",
        "kind: Outer.Api",
        "metadata: { name: MyApi }",
        "routes:",
        "  - request: { path: /x, method: POST }",
        "",
      ].join("\n"),
    };

    const registryFiles: Record<string, Record<string, string>> = {
      "std/outer@1.0.0": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: outer, version: 1.0.0 }",
          "imports:",
          "  Inner: std/inner@1.0.0",
          "exports:",
          "  kinds: [ Api ]",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: Api }",
          "capability: Telo.Mount",
          "controllers: { pkg:npm: '@telorun/outer' }",
          "schema:",
          "  type: object",
          "  properties:",
          "    routes:",
          "      type: array",
          "      items:",
          "        type: object",
          "        properties:",
          "          request:",
          '            x-telo-schema-from: "Inner.Request/$defs/Matcher"',
          "",
        ].join("\n"),
      },
      "std/inner@1.0.0": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: inner, version: 1.0.0 }",
          "exports:",
          "  kinds: [ Request ]",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: Request }",
          "capability: Telo.Type",
          "schema:",
          "  type: object",
          "  $defs:",
          "    Matcher:",
          "      type: object",
          "      properties: { path: { type: string }, method: { type: string } }",
          "",
        ].join("\n"),
      },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);
    const analysis = await analyzeWorkspace(workspace, adapter, [registry]);
    const appRegistry = analysis.registryByFile.get("/ws/app/telo.yaml");
    expect(
      appRegistry?.resolveSchemaFrom("Inner.Request/$defs/Matcher", "outer.Api")?.properties,
    ).toEqual({ path: { type: "string" }, method: { type: "string" } });
  });

  it("resolves a cross-module abstract implementation forwarded from an imported library", async () => {
    // `ai-mcp.ToolProvider` (in lib ai-mcp, which imports ai as `Ai`) declares
    // `extends: Ai.ToolProvider`. An app importing both ai and ai-mcp drives an
    // Ai.Agent whose `toolProviders[].provider` ref targets the abstract
    // `Ai.ToolProvider`. The analyzer must know `ai-mcp.ToolProvider`
    // implements `ai.ToolProvider` — which requires resolving the forwarded
    // definition's `extends` in ai-mcp's OWN alias scope. The CLI does this;
    // the editor must too, else a spurious REFERENCE_KIND_MISMATCH fires.
    const files: Record<string, string> = {
      "/ws/ai/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: ai, version: 1.0.0 }",
        "exports:",
        "  kinds: [ ToolProvider, Tools, Agent ]",
        "---",
        "kind: Telo.Abstract",
        "metadata: { name: ToolProvider }",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: Tools }",
        "capability: Telo.Provider",
        "extends: Self.ToolProvider",
        "controllers: { pkg:npm: '@telorun/ai' }",
        "schema: { type: object, additionalProperties: true }",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: Agent }",
        "capability: Telo.Invocable",
        "controllers: { pkg:npm: '@telorun/ai' }",
        "schema:",
        "  type: object",
        "  properties:",
        "    toolProviders:",
        "      type: array",
        "      items:",
        "        type: object",
        "        required: [ provider ]",
        "        properties:",
        "          provider:",
        "            type: object",
        '            x-telo-ref: Self.ToolProvider',
        "",
      ].join("\n"),
      "/ws/ai-mcp/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: ai-mcp, version: 1.0.0 }",
        "imports:",
        "  Ai: ../ai",
        "exports:",
        "  kinds: [ ToolProvider ]",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: ToolProvider }",
        "capability: Telo.Provider",
        "extends: Ai.ToolProvider",
        "controllers: { pkg:npm: '@telorun/ai-mcp' }",
        "schema: { type: object, additionalProperties: true }",
        "",
      ].join("\n"),
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Ai: ../ai",
        "  AiMcp: ../ai-mcp",
        "---",
        "kind: AiMcp.ToolProvider",
        "metadata: { name: RegistryTools }",
        "---",
        "kind: Ai.Agent",
        "metadata: { name: Assistant }",
        "toolProviders:",
        "  - provider: { kind: AiMcp.ToolProvider, name: RegistryTools }",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);
    const analysis = await analyzeWorkspace(workspace, adapter, []);
    expect(analysis.registryByFile.get("/ws/app/telo.yaml")?.implementationsOf("ai.ToolProvider")).toContain(
      "ai-mcp.ToolProvider",
    );
  });

  it("resolves a cross-module abstract implementation across REGISTRY imports", async () => {
    // Same as above, but ai / ai-mcp are registry modules and ai-mcp imports ai
    // via a registry ref (`std/ai@0.4.0`) using separate Telo.Import docs — the
    // published shape of std/ai-mcp@0.4.0 (examples/agent-console.yaml). Guards
    // that a forwarded definition's `extends` still resolves in the imported
    // library's own alias scope when that library was reached through the
    // registry, so the Ai.Agent toolProviders ref doesn't false-positive.
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Ai: std/ai@0.4.0",
        "  AiMcp: std/ai-mcp@0.4.0",
        "  Mcp: std/mcp-client@0.3.1",
        "---",
        "kind: Mcp.HttpClient",
        "metadata: { name: RegistryMcp }",
        "url: https://example.test/mcp",
        "---",
        "kind: AiMcp.ToolProvider",
        "metadata: { name: RegistryTools }",
        "client: { kind: Mcp.HttpClient, name: RegistryMcp }",
        "---",
        "kind: Ai.Agent",
        "metadata: { name: Assistant }",
        "toolProviders:",
        "  - provider: { kind: AiMcp.ToolProvider, name: RegistryTools }",
        "",
      ].join("\n"),
    };

    const registryFiles: Record<string, Record<string, string>> = {
      "std/mcp-client@0.3.1": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: mcp-client, version: 0.3.1 }",
          "exports:",
          "  kinds: [ Client, HttpClient ]",
          "---",
          "kind: Telo.Abstract",
          "metadata: { name: Client }",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: HttpClient }",
          "capability: Telo.Service",
          "extends: Self.Client",
          "controllers: { pkg:npm: '@telorun/mcp-client' }",
          "schema:",
          "  type: object",
          "  properties: { url: { type: string } }",
          "  required: [ url ]",
          "",
        ].join("\n"),
      },
      "std/ai@0.4.0": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: ai, version: 1.0.0 }",
          "exports:",
          "  kinds: [ ToolProvider, Tools, Agent ]",
          "---",
          "kind: Telo.Abstract",
          "metadata: { name: ToolProvider }",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: Tools }",
          "capability: Telo.Provider",
          "extends: Self.ToolProvider",
          "controllers: { pkg:npm: '@telorun/ai' }",
          "schema: { type: object, additionalProperties: true }",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: Agent }",
          "capability: Telo.Invocable",
          "controllers: { pkg:npm: '@telorun/ai' }",
          "schema:",
          "  type: object",
          "  properties:",
          "    toolProviders:",
          "      type: array",
          "      items:",
          "        type: object",
          "        required: [ provider ]",
          "        properties:",
          "          provider:",
          "            type: object",
          '            x-telo-ref: Self.ToolProvider',
          "",
        ].join("\n"),
      },
      "std/ai-mcp@0.4.0": {
        // Mirrors the PUBLISHED shape exactly: separate Telo.Import docs (not an
        // inline `imports:` map), with the `---\n---` double separators the
        // publish desugaring emits (empty docs between real ones).
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: ai-mcp, version: 0.4.0 }",
          "exports:",
          "  kinds: [ ToolProvider ]",
          "---",
          "---",
          "kind: Telo.Import",
          "metadata: { name: Ai }",
          "source: std/ai@0.4.0",
          "---",
          "---",
          "kind: Telo.Import",
          "metadata: { name: Mcp }",
          "source: std/mcp-client@0.3.1",
          "---",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: ToolProvider }",
          "capability: Telo.Mount",
          "extends: Ai.ToolProvider",
          "controllers: { pkg:npm: '@telorun/ai-mcp' }",
          "schema:",
          "  type: object",
          "  properties:",
          "    client:",
          '      x-telo-ref: Mcp.Client',
          "  required: [ client ]",
          "  additionalProperties: false",
          "",
        ].join("\n"),
      },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);
    const analysis = await analyzeWorkspace(workspace, adapter, [registry]);
    expect(analysis.registryByFile.get("/ws/app/telo.yaml")?.implementationsOf("ai.ToolProvider")).toContain(
      "ai-mcp.ToolProvider",
    );
  });

  it("isolates apps importing different versions of the same library", async () => {
    // Two Applications each import `std/widget`, but at incompatible versions.
    // The two library versions define the same kind (`widget.Box`) with
    // mutually exclusive schemas. Pre-fix, the whole workspace shared one
    // AnalysisRegistry, so whichever version registered last overwrote the
    // other's `widget.Box` definition — and exactly one app got a spurious
    // SCHEMA_VIOLATION validating its resource against the wrong version.
    const widgetLib = (required: string, prop: string, propSchema: string): string =>
      [
        "kind: Telo.Library",
        "metadata:",
        "  name: widget",
                "  version: 1.0.0",
        "exports:",
        "  kinds:",
        "    - Box",
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Box",
        "capability: Telo.Service",
        "controllers:",
        "  pkg:npm: '@telorun/widget'",
        "schema:",
        "  type: object",
        "  additionalProperties: false",
        `  required: [${required}]`,
        "  properties:",
        `    ${prop}: ${propSchema}`,
        "",
      ].join("\n");

    const app = (version: string, field: string): string =>
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Widget",
        `source: std/widget@${version}`,
        "---",
        "kind: Widget.Box",
        "metadata:",
        "  name: box",
        field,
        "",
      ].join("\n");

    const files: Record<string, string> = {
      // app-a uses v1 (size: integer); valid only under v1.
      "/ws/app-a/telo.yaml": app("1.0.0", "size: 5"),
      // app-b uses v2 (label: string); valid only under v2.
      "/ws/app-b/telo.yaml": app("2.0.0", "label: hi"),
    };

    const registryFiles: Record<string, Record<string, string>> = {
      "std/widget@1.0.0": { "telo.yaml": widgetLib("size", "size", "{ type: integer }") },
      "std/widget@2.0.0": { "telo.yaml": widgetLib("label", "label", "{ type: string }") },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);

    // Both versions coexist in the workspace under distinct canonical paths.
    expect(workspace.modules.has("registry://std/widget@1.0.0/telo.yaml")).toBe(true);
    expect(workspace.modules.has("registry://std/widget@2.0.0/telo.yaml")).toBe(true);

    const analysis = await analyzeWorkspace(workspace, adapter, [registry]);

    // Each app's resources resolve against its own closure registry, holding
    // the version that app imports.
    const a = analysis.registryByFile.get("/ws/app-a/telo.yaml");
    const b = analysis.registryByFile.get("/ws/app-b/telo.yaml");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a?.resolveDefinition("Widget.Box")?.schema?.required).toEqual(["size"]);
    expect(b?.resolveDefinition("Widget.Box")?.schema?.required).toEqual(["label"]);
  });
});

describe("analyzeWorkspace — oci:// imports via the manifest cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  const LIBRARY = [
    "kind: Telo.Library",
    "metadata:",
    "  name: s3",
        "  version: 1.2.0",
    "exports:",
    "  kinds:",
    "    - Bucket",
    "---",
    "kind: Telo.Definition",
    "metadata:",
    "  name: Bucket",
    "capability: Telo.Provider",
    "controllers:",
    "  pkg:npm: '@telorun/s3'",
    "schema:",
    "  type: object",
    "  properties:",
    "    bucketName: { type: string }",
    "",
  ].join("\n");

  it("resolves an oci import's kinds from manifests.telo.sh", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === "https://manifests.telo.sh/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml") {
        return new Response(LIBRARY, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "imports:",
        "  S3: oci://ghcr.io/aws/telo-s3@1.2.0",
        "---",
        "kind: S3.Bucket",
        "metadata:",
        "  name: store",
        "bucketName: files",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);

    const appManifest = workspace.modules.get("/ws/app/telo.yaml");
    expect(appManifest, "app manifest should be loaded").toBeTruthy();
    const s3Import = appManifest!.imports.find((i) => i.name === "S3");
    expect(s3Import?.importKind).toBe("oci");

    const analysis = await analyzeWorkspace(workspace, adapter, []);

    expect(
      fetched.some((u) => u === "https://manifests.telo.sh/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml"),
      `the import should resolve against the manifest cache, fetched: ${JSON.stringify(fetched)}`,
    ).toBe(true);
    expect(analysis.registryByFile.get("/ws/app/telo.yaml")?.resolveDefinition("S3.Bucket")?.metadata.name).toBe(
      "Bucket",
    );
  });
});
