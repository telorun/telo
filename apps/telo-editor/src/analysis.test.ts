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

    const diagnostics = await analyzeWorkspace(workspace, adapter, []);

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

  it("resolves a cross-module `!ref Alias.export` in a flat targets invoke step", async () => {
    // Reproduces the editor/CLI divergence: an Application imports a workspace
    // library and drives one of its exported instances from a flat `targets`
    // invoke step (`invoke: !ref Console.writeLine`). The CLI resolves this
    // because `flattenForAnalyzer` forwards the library's `exports.resources`
    // instance flagged `forwardedExport`, so `!ref Console.writeLine` resolves
    // to `{kind, name}` before AJV runs. The editor must do the same via
    // `selectModuleManifestsForAnalysis`; otherwise the raw `!ref` sentinel
    // reaches the `targets` schema and every anyOf branch fails (the reported
    // SCHEMA_VIOLATION storm).
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "imports:",
        "  Console: ../console",
        "targets:",
        "  - invoke: !ref Console.writeLine",
        "    inputs:",
        "      output: Hello from Telo!",
        "",
      ].join("\n"),
      "/ws/console/telo.yaml": [
        "kind: Telo.Library",
        "metadata:",
        "  name: console",
        "  version: 1.0.0",
        "exports:",
        "  resources:",
        "    - writeLine",
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: WriteLine",
        "capability: Telo.Invocable",
        "controllers:",
        "  pkg:npm: '@telorun/console'",
        "inputType:",
        "  type: object",
        "  properties:",
        "    output: { type: string }",
        "schema:",
        "  type: object",
        "---",
        "kind: Self.WriteLine",
        "metadata:",
        "  name: writeLine",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);

    const appManifest = workspace.modules.get("/ws/app/telo.yaml");
    expect(appManifest, "app manifest should be loaded").toBeTruthy();
    const consoleImport = appManifest!.imports.find((i) => i.name === "Console");
    expect(consoleImport?.resolvedPath, "inline import should resolve").toBe(
      "/ws/console/telo.yaml",
    );

    const diagnostics = await analyzeWorkspace(workspace, adapter, []);

    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) all.push({ code: d.code, message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) all.push({ code: d.code, message: d.message });
    }

    const offending = all.filter(
      (d) => d.code === "SCHEMA_VIOLATION" || d.code === "UNRESOLVED_REFERENCE",
    );
    expect(
      offending,
      `targets invoke step should resolve cleanly; got: ${JSON.stringify(offending, null, 2)}`,
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

    const diagnostics = await analyzeWorkspace(workspace, adapter, [registry]);

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
          "metadata: { name: outer, namespace: std, version: 1.0.0 }",
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
          "metadata: { name: inner, namespace: std, version: 1.0.0 }",
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
    const diagnostics = await analyzeWorkspace(workspace, adapter, [registry]);

    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values())
      for (const list of fileMap.values()) for (const d of list) all.push({ code: d.code, message: d.message });
    for (const list of diagnostics.byFile.values())
      for (const d of list) all.push({ code: d.code, message: d.message });

    const schemaFrom = all.filter((d) => d.code === "SCHEMA_FROM_MISSING_PATH");
    expect(
      schemaFrom,
      `expected no SCHEMA_FROM_MISSING_PATH; got: ${JSON.stringify(schemaFrom, null, 2)}`,
    ).toHaveLength(0);
  });

  it("surfaces diagnostics on a registry module's forwarded definition (not silently dropped)", async () => {
    // External (registry/remote) modules never anchor their own analysis closure,
    // yet `telo check <app>` validates forwarded imported definitions and reports
    // errors against their source file. The editor must do the same — emitting
    // such diagnostics from the first consumer closure — rather than swallowing
    // them behind the workspace-only root-local filter.
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Bad",
        "source: std/bad@1.0.0",
        "",
      ].join("\n"),
    };

    const registryFiles: Record<string, Record<string, string>> = {
      "std/bad@1.0.0": {
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata:",
          "  name: bad",
          "  version: 1.0.0",
          "exports:",
          "  kinds:",
          "    - Thing",
          "---",
          "kind: Telo.Definition",
          "metadata:",
          "  name: Thing",
          "capability: Telo.Invocable",
          "controllers:",
          "  pkg:npm: '@telorun/bad'",
          "schema:",
          "  type: object",
          "  properties:",
          "    name: { type: string }",
          "invoke:",
          "  kind: bad.Thing",
          "  name: x",
          // `self.bogus` is not in this definition's schema → CEL_UNKNOWN_FIELD,
          // attributed to the registry file.
          "inputs:",
          "  name: '${{ self.bogus }}'",
          "",
        ].join("\n"),
      },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);

    const diagnostics = await analyzeWorkspace(workspace, adapter, [registry]);

    const regFile = "registry://std/bad@1.0.0/telo.yaml";
    const onRegistryFile: Array<{ code?: string; message: string }> = [];
    for (const list of diagnostics.byResource.get(regFile)?.values() ?? []) {
      for (const d of list) onRegistryFile.push({ code: d.code, message: d.message });
    }
    for (const d of diagnostics.byFile.get(regFile) ?? []) {
      onRegistryFile.push({ code: d.code, message: d.message });
    }

    expect(
      onRegistryFile.some((d) => d.code === "CEL_UNKNOWN_FIELD"),
      `registry definition error should surface on ${regFile}; got: ${JSON.stringify(onRegistryFile, null, 2)}`,
    ).toBe(true);
  });

  it("resolves a cross-module abstract implementation forwarded from an imported library", async () => {
    // `ai-mcp.ToolProvider` (in lib ai-mcp, which imports ai as `Ai`) declares
    // `extends: Ai.ToolProvider`. An app importing both ai and ai-mcp drives an
    // Ai.Agent whose `toolProviders[].provider` ref targets the abstract
    // `std/ai#ToolProvider`. The analyzer must know `ai-mcp.ToolProvider`
    // implements `ai.ToolProvider` — which requires resolving the forwarded
    // definition's `extends` in ai-mcp's OWN alias scope. The CLI does this;
    // the editor must too, else a spurious REFERENCE_KIND_MISMATCH fires.
    const files: Record<string, string> = {
      "/ws/ai/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: ai, namespace: std, version: 1.0.0 }",
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
        '            x-telo-ref: "std/ai#ToolProvider"',
        "",
      ].join("\n"),
      "/ws/ai-mcp/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: ai-mcp, namespace: std, version: 1.0.0 }",
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
    const diagnostics = await analyzeWorkspace(workspace, adapter, []);

    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) all.push({ code: d.code, message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) all.push({ code: d.code, message: d.message });
    }

    const mismatch = all.filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(
      mismatch,
      `AiMcp.ToolProvider should be a known implementation of ai.ToolProvider; got: ${JSON.stringify(mismatch, null, 2)}`,
    ).toHaveLength(0);
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
          "metadata: { name: mcp-client, namespace: std, version: 0.3.1 }",
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
          "metadata: { name: ai, namespace: std, version: 1.0.0 }",
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
          '            x-telo-ref: "std/ai#ToolProvider"',
          "",
        ].join("\n"),
      },
      "std/ai-mcp@0.4.0": {
        // Mirrors the PUBLISHED shape exactly: separate Telo.Import docs (not an
        // inline `imports:` map), with the `---\n---` double separators the
        // publish desugaring emits (empty docs between real ones).
        "telo.yaml": [
          "kind: Telo.Library",
          "metadata: { name: ai-mcp, namespace: std, version: 0.4.0 }",
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
          '      x-telo-ref: "std/mcp-client#Client"',
          "  required: [ client ]",
          "  additionalProperties: false",
          "",
        ].join("\n"),
      },
    };

    const adapter = inMemoryAdapter(files);
    const registry = inMemoryRegistry(registryFiles);
    const workspace = await loadWorkspace("/ws", adapter, adapter, [registry]);
    const diagnostics = await analyzeWorkspace(workspace, adapter, [registry]);

    const all: Array<{ code?: string; message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) all.push({ code: d.code, message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) all.push({ code: d.code, message: d.message });
    }

    const mismatch = all.filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(
      mismatch,
      `AiMcp.ToolProvider should be a known implementation of ai.ToolProvider; got: ${JSON.stringify(mismatch, null, 2)}`,
    ).toHaveLength(0);
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
        "  namespace: std",
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

    const diagnostics = await analyzeWorkspace(workspace, adapter, [registry]);

    const violations: Array<{ message: string }> = [];
    for (const fileMap of diagnostics.byResource.values()) {
      for (const list of fileMap.values()) {
        for (const d of list) if (d.code === "SCHEMA_VIOLATION") violations.push({ message: d.message });
      }
    }
    for (const list of diagnostics.byFile.values()) {
      for (const d of list) if (d.code === "SCHEMA_VIOLATION") violations.push({ message: d.message });
    }

    expect(
      violations,
      `each app should validate against its own imported version; got: ${JSON.stringify(violations, null, 2)}`,
    ).toHaveLength(0);

    // Each app's resource is owned by its own closure registry.
    expect(diagnostics.registryByFile.has("/ws/app-a/telo.yaml")).toBe(true);
    expect(diagnostics.registryByFile.has("/ws/app-b/telo.yaml")).toBe(true);
    expect(diagnostics.registryByFile.get("/ws/app-a/telo.yaml")).not.toBe(
      diagnostics.registryByFile.get("/ws/app-b/telo.yaml"),
    );
  });

  it("routes diagnostics to the resource's own file when two modules share a (kind, name)", async () => {
    // Resource names are module-scoped, so an app and a library it imports may
    // each legitimately declare `Widget.Box/dup`. Both sit in the app's
    // analysis closure. Routing must use each diagnostic's own `data.filePath`
    // rather than a `${kind}/${name}` projection (which collapses the two to a
    // single file and misattributes one module's diagnostic to the other).
    const files: Record<string, string> = {
      "/ws/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Mod",
        "source: ../mod",
        "---",
        "kind: Widget.Box", // undefined kind → UNDEFINED_KIND, in app's file
        "metadata:",
        "  name: dup",
        "",
      ].join("\n"),
      "/ws/mod/telo.yaml": [
        "kind: Telo.Library",
        "metadata:",
        "  name: mod",
        "  version: 1.0.0",
        "---",
        "kind: Widget.Box", // same kind+name, in the library's file
        "metadata:",
        "  name: dup",
        "",
      ].join("\n"),
    };

    const adapter = inMemoryAdapter(files);
    const workspace = await loadWorkspace("/ws", adapter, adapter, []);
    const diagnostics = await analyzeWorkspace(workspace, adapter, []);

    const appDup = diagnostics.byResource.get("/ws/app/telo.yaml")?.get("dup");
    const modDup = diagnostics.byResource.get("/ws/mod/telo.yaml")?.get("dup");

    expect(
      appDup?.some((d) => d.code === "UNDEFINED_KIND"),
      "app's Widget.Box/dup should report against /ws/app/telo.yaml",
    ).toBe(true);
    expect(
      modDup?.some((d) => d.code === "UNDEFINED_KIND"),
      "library's Widget.Box/dup should report against /ws/mod/telo.yaml",
    ).toBe(true);
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
    const diagnostics = await analyzeWorkspace(workspace, adapter, []);

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
