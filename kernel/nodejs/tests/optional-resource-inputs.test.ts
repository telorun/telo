import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { computeAnalysisSignature, writeAnalysisStamp } from "../src/manifest-sources/analysis-stamp.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/resource-inputs/optional",
);

let scratch: string;
beforeEach(() => {
  scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "telo-optional-input-")));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const kernel = () => new Kernel({ sources: [new LocalFileSource()], env: {}, argv: [] });

/** An application importing the optional-store library, supplying its own
 *  store or not; every event name it emitted, in order. */
async function events(supplies: boolean): Promise<string[]> {
  const entry = path.join(scratch, "app.yaml");
  fs.writeFileSync(
    entry,
    [
      "kind: Telo.Application",
      "metadata: { name: App, version: 1.0.0 }",
      "imports:",
      `  Kinds: ${path.join(FIXTURES, "kinds")}`,
      ...(supplies
        ? ["  Lib:", `    source: ${path.join(FIXTURES, "lib")}`, "    resources:", "      store: !ref mine"]
        : [`  Lib: ${path.join(FIXTURES, "lib")}`]),
      ...(supplies ? ["---", "kind: Kinds.Store", "metadata: { name: mine }", "label: mine"] : []),
    ].join("\n"),
  );
  const instance = kernel();
  const seen: string[] = [];
  instance.on("*", (event) => {
    seen.push(event.name);
  });
  await instance.load(entry, { cacheDir: null });
  try {
    await instance.boot();
    await instance.runTargets();
  } finally {
    await instance.teardown();
  }
  return seen;
}

/** What booting `fixture` raises once its analysis is taken as already
 *  passed — a load whose stamp says so — leaving the kernel's own guards. */
async function unanalysedRefusal(fixture: string): Promise<{ message: string }> {
  const entry = path.join(FIXTURES, fixture);
  const first = kernel();
  await expect(first.load(entry, { cacheDir: scratch })).rejects.toThrow();
  const graph = first.getLoadedGraph()!;
  const signature = computeAnalysisSignature(graph, { entryUrl: graph.rootSource });
  await writeAnalysisStamp(graph.rootSource, signature, path.join(scratch, "analysis"));
  const second = kernel();
  try {
    await second.load(entry, { cacheDir: scratch });
    await second.boot();
  } catch (error) {
    return error as { message: string };
  } finally {
    await second.teardown();
  }
  throw new Error("expected the boot to be refused");
}

describe("an optional resource input", () => {
  it("is held when supplied, its default never created, and outlives the library", async () => {
    const seen = await events(true);
    expect(seen.some((name) => name.endsWith(".fallback.Created"))).toBe(false);
    const holderGone = seen.findIndex((name) => name.endsWith(".holder.Teardown"));
    const mineGone = seen.findIndex((name) => name.endsWith(".mine.Teardown"));
    expect(holderGone).toBeGreaterThanOrEqual(0);
    expect(mineGone).toBeGreaterThan(holderGone);
  });

  it("is replaced by the library's default when omitted, torn down with the library", async () => {
    const seen = await events(false);
    expect(seen.some((name) => name.endsWith(".fallback.Created"))).toBe(true);
    expect(seen.some((name) => name.endsWith(".fallback.Teardown"))).toBe(true);
  });

  it("referenced where an import omits it is refused by the import", async () => {
    const refused = await unanalysedRefusal("referenced/omitting.yaml");
    expect(refused.message).toContain("ERR_RESOURCE_INPUT_OPTIONAL_REFERENCED");
    expect(refused.message).toContain("'store' references resource input 'store'");
  });

  it("supplied by one import of a shared library and omitted by another is a conflict", async () => {
    const refused = await unanalysedRefusal("shared-conflict.yaml");
    expect(refused.message).toContain("ERR_SHARED_LIBRARY_CONFLICT");
    expect(refused.message).toContain("import 'Supplying' supplies it and import 'Omitting' omits it");
  });
});
