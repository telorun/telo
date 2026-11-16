import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { registerLoadedGraph } from "../src/graph-registration.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import { planLibraryWriteBack } from "../src/library-migrations/write-back.js";

const CONSUMER = fileURLToPath(new URL("../../library-migration-conformance/consumers/hand-over-account/", import.meta.url));

const fileSource: ManifestSource = {
  supports: (url) => url.startsWith("file://") || isAbsolute(url),
  async read(url) {
    const path = url.startsWith("file://") ? fileURLToPath(url) : url;
    const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "telo.yaml") : path;
    return { text: readFileSync(file, "utf8"), source: pathToFileURL(file).href };
  },
  resolveRelative: (base, relative) =>
    pathToFileURL(resolve(dirname(base.startsWith("file://") ? fileURLToPath(base) : base), relative)).href,
};

async function plan(poison?: (path: readonly (string | number)[]) => boolean) {
  const graph = await new Loader([fileSource]).loadGraph(join(CONSUMER, "telo.yaml"), { desugarImports: true, migrate: true });
  registerLoadedGraph(graph, new AnalysisRegistry());
  const outcome = graph.libraryMigrations!;
  const record = outcome.records.get(graph.rootSource)!;
  const root = graph.modules.get(graph.rootSource)!;
  const entries = record.entries.map((entry) =>
    poison?.(entry.anchor.path)
      ? { anchor: entry.anchor, node: { get literal(): never { throw new Error("cannot render") } } as never }
      : entry,
  );
  return {
    record,
    result: planLibraryWriteBack({
      record: { ...record, entries },
      files: [root.owner, ...root.partials],
      originals: outcome.originals,
      findings: outcome.findings,
      handOvers: outcome.handOvers,
    }),
  };
}

describe("library migration write-back", () => {
  it("writes a hand-over group whole, and none of it when one member cannot be rendered", async () => {
    const whole = await plan();
    expect(whole.result.unwritable).toEqual([]);
    expect(whole.result.rewrites.map((r) => `${r.line}:${r.path}`)).toEqual([
      "7:/",
      "13:/",
      "28:/pages/0/children/0",
      "28:/pages/0/children/1",
      "31:/pages/1/children/0",
    ]);

    const partial = await plan((path) => path.join("/") === "pages/0/children/0");
    expect(partial.result.unwritable.map((u) => `${u.line}:${u.path}`)).toEqual([
      "28:/pages/0/children/0",
      "7:/",
      "31:/pages/1/children/0",
    ]);
    expect(partial.result.unwritable[0]!.reason).toContain("cannot be rendered: cannot render");
    for (const u of partial.result.unwritable.slice(1)) {
      expect(u.reason).toMatch(/^the hand-over of `me` \(.*telo\.yaml:7:1\) has an unwritable member — .*\(\/pages\/0\/children\/0\) cannot be rendered/);
    }
    expect(partial.result.rewrites.map((r) => `${r.line}:${r.path}`)).toEqual(["13:/", "28:/pages/0/children/1"]);
  });
});
