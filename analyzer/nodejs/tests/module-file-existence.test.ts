import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import { diagnosticFix, type ManifestSource } from "../src/types.js";

/** An in-memory source over manifests plus a set of paths that exist, so the
 *  loader's existence question is answered without a filesystem. */
function source(files: Record<string, string>, present: string[], canAnswer = true): ManifestSource {
  const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/") + 1);
  return {
    supports: () => true,
    async read(url) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base, relative) => dirOf(base) + relative.replace(/^\.\//, ""),
    ...(canAnswer
      ? {
          async exists(base: string, relative: string) {
            return present.includes(dirOf(base) + relative);
          },
        }
      : {}),
  };
}

const app = [
  "kind: Telo.Application",
  "metadata: { name: App, version: 1.0.0 }",
  "include: [./part.yaml]",
  "---",
  "kind: Http.Static",
  "metadata: { name: site }",
  "root: !module-path ./public",
].join("\n");

const part = ["kind: Http.Static", "metadata: { name: assets }", "root: !module-path ./assets"].join(
  "\n",
);

describe("MODULE_PATH_NOT_FOUND at load", () => {
  it("reports a module path naming nothing, resolved against the owner even from a partial", async () => {
    const files = { "/app/telo.yaml": app, "/app/part.yaml": part };
    const graph = await new Loader([source(files, ["/app/public"])]).loadGraph("/app/telo.yaml");

    expect(
      graph.moduleFileDiagnostics.map((d) => ({
        code: d.code,
        path: (d.data as { path?: string }).path,
        filePath: (d.data as { filePath?: string }).filePath,
      })),
    ).toEqual([{ code: "MODULE_PATH_NOT_FOUND", path: "root", filePath: "/app/part.yaml" }]);
  });

  it("reports nothing when the source cannot say what exists", async () => {
    const files = { "/app/telo.yaml": app, "/app/part.yaml": part };
    const graph = await new Loader([source(files, [], false)]).loadGraph("/app/telo.yaml");
    expect(graph.moduleFileDiagnostics).toEqual([]);
  });
});

describe("MODULE_PATH_NOT_FOUND for a path a sources: entry stages", () => {
  const pin = `sha256: ${"a".repeat(64)}, executable: false`;
  const staging = (sources: string) =>
    [
      "kind: Telo.Library",
      "metadata: { name: Lib, version: 1.0.0 }",
      "assets: [./tessdata/]",
      "native:",
      "  - { name: engine, format: napi, os: linux, arch: amd64, path: ./native/engine.node }",
      "sources:",
      sources,
    ].join("\n");
  const models = [
    "  models:",
    "    version: 1.0.0",
    "    url: https://example.com/{upstream}-{version}.tgz",
    "    archive: tar.gz",
    "    notices: [./notices/models.LICENSE]",
    "    entries:",
    `      ./tessdata/eng.traineddata.gz: { upstream: eng, member: package/eng.traineddata.gz, ${pin} }`,
    `      ./notices/models.LICENSE: { upstream: eng, member: package/LICENSE, ${pin} }`,
    `      ./native/engine.node: { upstream: engine, member: build/engine.node, ${pin} }`,
  ].join("\n");
  const readsModulePaths = (paths: string[], sources = models) =>
    [
      staging(sources),
      ...paths.map((p, i) =>
        ["---", "kind: Http.Static", `metadata: { name: site${i} }`, `root: !module-path ${p}`].join("\n"),
      ),
    ].join("\n");
  const notFound = async (paths: string[], sources?: string) => {
    const files = { "/lib/telo.yaml": readsModulePaths(paths, sources) };
    const graph = await new Loader([source(files, [])]).loadGraph("/lib/telo.yaml");
    return graph.moduleFileDiagnostics.map((d) => (d.data as { resource: { name: string } }).resource.name);
  };

  it("counts an entry an assets: pattern selects as present", async () => {
    expect(await notFound(["./tessdata/eng.traineddata.gz"])).toEqual([]);
  });

  it("counts a source's notice as present", async () => {
    expect(await notFound(["./notices/models.LICENSE"])).toEqual([]);
  });

  it("counts a directory a staged module file lies beneath as present", async () => {
    expect(await notFound(["./tessdata"])).toEqual([]);
  });

  it("still reports a path no entry stages, and a staged native file", async () => {
    expect(
      await notFound(["./tessdata/deu.traineddata.gz", "./tess", "./native/engine.node"]),
    ).toEqual(["site0", "site1", "site2"]);
  });

  it("still reports a staged path while the sources: block does not read", async () => {
    const unreadable = `${models}\n  Broken: { version: 1.0.0 }`;
    expect(await notFound(["./tessdata/eng.traineddata.gz"], unreadable)).toEqual(["site0"]);
  });
});

describe("INCLUDE_FILE_NOT_FOUND at load", () => {
  const withPrompt = (path: string) =>
    [
      "kind: Telo.Library",
      "metadata: { name: Chat, version: 1.0.0 }",
      "---",
      "kind: Ai.Agent",
      "metadata: { name: author }",
      `system: !include-text ${path}`,
    ].join("\n");
  const importing = (source: string) =>
    [
      "kind: Telo.Application",
      "metadata: { name: App, version: 1.0.0 }",
      `imports: { Chat: ${source} }`,
    ].join("\n");
  const codes = (graph: { moduleFileDiagnostics: { code?: string; data?: unknown }[] }) =>
    graph.moduleFileDiagnostics.map((d) => ({
      code: d.code,
      filePath: (d.data as { filePath?: string }).filePath,
    }));

  it("reports an embed naming nothing in a library reached by a path import", async () => {
    const files = {
      "/app/telo.yaml": importing("./chat/telo.yaml"),
      "/app/chat/telo.yaml": withPrompt("./primer.md"),
    };
    const graph = await new Loader([source(files, [])]).loadGraph("/app/telo.yaml", { desugarImports: true });
    expect(codes(graph)).toEqual([
      { code: "INCLUDE_FILE_NOT_FOUND", filePath: "/app/chat/telo.yaml" },
    ]);
  });

  it("resolves the embed against the library's own root", async () => {
    const files = {
      "/app/telo.yaml": importing("./chat/telo.yaml"),
      "/app/chat/telo.yaml": withPrompt("./primer.md"),
    };
    const graph = await new Loader([source(files, ["/app/chat/primer.md"])]).loadGraph(
      "/app/telo.yaml",
      { desugarImports: true },
    );
    expect(graph.moduleFileDiagnostics).toEqual([]);
  });

  it("leaves a library reached by a registry import to its publish", async () => {
    const files = {
      "/app/telo.yaml": importing("https://registry.example/chat/telo.yaml"),
      "https://registry.example/chat/telo.yaml": withPrompt("./primer.md"),
    };
    const graph = await new Loader([source(files, [])]).loadGraph("/app/telo.yaml", { desugarImports: true });
    expect(graph.errors).toEqual([]);
    expect(graph.modules.has("https://registry.example/chat/telo.yaml")).toBe(true);
    expect(graph.moduleFileDiagnostics).toEqual([]);
  });
});

describe("what a missing file's directory says about it", () => {
  const embed = (path: string) =>
    [
      "kind: Telo.Application",
      "metadata: { name: App, version: 1.0.0 }",
      "---",
      "kind: Ai.Agent",
      "metadata: { name: author }",
      `system: !include-text ${path}`,
    ].join("\n");
  const listing = (dirs: Record<string, string[]>): ManifestSource => ({
    ...source({ "/app/telo.yaml": embed("./prompts/primer.md") }, []),
    locate: (base, relative) => base.slice(0, base.lastIndexOf("/") + 1) + relative,
    async listDirectory(base, relative) {
      return dirs[base.slice(0, base.lastIndexOf("/") + 1) + relative];
    },
  });
  const report = async (dirs: Record<string, string[]>, from = listing(dirs)) => {
    const [d] = (await new Loader([from]).loadGraph("/app/telo.yaml")).moduleFileDiagnostics;
    return { message: d!.message, fix: diagnosticFix(d!) };
  };

  it("names the path it looked at", async () => {
    expect((await report({ "/app/prompts": [] })).message).toContain(
      "there is nothing there (/app/prompts/primer.md).",
    );
  });

  it("offers the one entry a typo most plausibly meant, as a fix keeping the ./ spelling", async () => {
    const { message, fix } = await report({ "/app/prompts": ["primr.md", "system.md"] });
    expect(message).toContain("Did you mean './prompts/primr.md'?");
    expect(fix).toEqual({ replacement: "./prompts/primr.md" });
  });

  it("offers nothing when two entries are equally close", async () => {
    const { message, fix } = await report({ "/app/prompts": ["primr.md", "priner.md"] });
    expect(message).not.toContain("Did you mean");
    expect(fix).toBeUndefined();
  });

  it("says the directory is missing rather than listing it", async () => {
    const { message, fix } = await report({});
    expect(message).toContain("The directory 'prompts/' does not exist.");
    expect(fix).toBeUndefined();
  });

  it("reports the plain finding when the source cannot list", async () => {
    const { message, fix } = await report(
      {},
      source({ "/app/telo.yaml": embed("./prompts/primer.md") }, []),
    );
    expect(message).toContain("names 'prompts/primer.md', and there is nothing there.");
    expect(message).not.toContain("does not exist");
    expect(fix).toBeUndefined();
  });
});
