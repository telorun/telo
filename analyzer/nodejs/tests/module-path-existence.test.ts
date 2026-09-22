import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

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
      graph.modulePathDiagnostics.map((d) => ({
        code: d.code,
        path: (d.data as { path?: string }).path,
        filePath: (d.data as { filePath?: string }).filePath,
      })),
    ).toEqual([{ code: "MODULE_PATH_NOT_FOUND", path: "root", filePath: "/app/part.yaml" }]);
  });

  it("reports nothing when the source cannot say what exists", async () => {
    const files = { "/app/telo.yaml": app, "/app/part.yaml": part };
    const graph = await new Loader([source(files, [], false)]).loadGraph("/app/telo.yaml");
    expect(graph.modulePathDiagnostics).toEqual([]);
  });
});
