import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * The renderer entry as the kernel's browser build makes it: one build with
 * code splitting, whose sidecar lists every non-external import of the entry,
 * dynamic ones included, so the chunk is served by digest with the entry.
 */
const manifest = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" })[0].toJS();
const entry = manifest.exports.browser.find((each: { specifier: string }) => each.specifier === "@telorun/ui-react-renderer");

let directory: string;
let outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[]; inputs: Record<string, unknown> }>;

beforeAll(async () => {
  directory = mkdtempSync(join(fileURLToPath(new URL("../node_modules/", import.meta.url)), ".markdown-bundle-"));
  const result = await build({
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    splitting: true,
    conditions: ["source"],
    define: { "process.env.NODE_ENV": '"production"' },
    external: entry.external,
    entryPoints: { renderer: fileURLToPath(new URL(`../../${entry.source}`, import.meta.url)) },
    outdir: directory,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  outputs = result.metafile.outputs as typeof outputs;
}, 60_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const holds = (output: { inputs: Record<string, unknown> }, library: string) => Object.keys(output.inputs).some((input) => input.includes(`/${library}/`));

describe("the renderer entry as built", () => {
  it("loads the markdown parser and highlighter from a chunk of its own, imported dynamically", () => {
    const entryFile = Object.keys(outputs).find((file) => file.endsWith("/renderer.js")) as string;
    // What the entry loads at once: itself and the chunks it imports, transitively.
    const loaded = new Set<string>();
    const queue = [entryFile];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (loaded.has(file)) continue;
      loaded.add(file);
      queue.push(...outputs[file].imports.filter((each) => each.kind === "import-statement" && !each.external).map((each) => each.path));
    }
    const lazy = [...loaded].flatMap((file) => outputs[file].imports.filter((each) => each.kind === "dynamic-import" && !each.external).map((each) => each.path));
    expect(lazy).toHaveLength(1);
    expect(holds(outputs[lazy[0]], "mdast-util-from-markdown")).toBe(true);
    expect(holds(outputs[lazy[0]], "lowlight")).toBe(true);
    for (const file of loaded) {
      expect(holds(outputs[file], "mdast-util-from-markdown")).toBe(false);
      expect(holds(outputs[file], "lowlight")).toBe(false);
    }
  });
});
