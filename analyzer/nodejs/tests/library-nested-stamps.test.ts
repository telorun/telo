import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it, vi } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flagTargets, loadGenerated, RUN } from "./configuration-cost-fixtures.js";

// What the nested-stamp judge and the omitted-input reader each read, in order.
const judged = vi.hoisted(() => [] as unknown[]);
const omittedRead = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/metadata-stamp-refusals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/metadata-stamp-refusals.js")>();
  return {
    ...actual,
    writtenNestedStampPlaces: (...args: Parameters<typeof actual.writtenNestedStampPlaces>) => {
      judged.push(args[0]);
      return actual.writtenNestedStampPlaces(...args);
    },
  };
});
vi.mock("../src/omitted-input-references.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/omitted-input-references.js")>();
  return {
    ...actual,
    libraryOptionalReferences: (...args: Parameters<typeof actual.libraryOptionalReferences>) => {
      omittedRead.push(args[0].manifests);
      return actual.libraryOptionalReferences(...args);
    },
  };
});

const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/library-nested-stamps");

/** `n` flags choosing targets, and two imports of one library writing a stamp
 *  on a nested declaration under a choice: one deciding it false, one by a flag. */
function twoImports(n: number): string {
  return flagTargets(n).replace(
    `  Run: ${RUN}\n`,
    `  Run: ${RUN}\n` +
      `  First: { source: ${LIBRARY}, variables: { flag: false } }\n` +
      `  Second: { source: ${LIBRARY}, variables: { flag: !cel "variables.flag1" } }\n`,
  );
}

describe("a library's nested stamps", () => {
  it("are judged once per library, over the documents the omitted-input reader reads, and reported once at the first import reaching it: N=1, 4 and 8", async () => {
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`library-nested-stamps-${n}.yaml`, twoImports(n));
      const library = loaded.moduleDocuments.find((d) => d.module === "NestedStampTwiceLib")!;
      judged.length = 0;
      omittedRead.length = 0;
      const found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      const ofLibrary = judged.filter((input) => (input as ResourceManifest[]).some((m) => library.manifests.includes(m)));
      expect(ofLibrary, `judged at N=${n}`).toEqual([library.manifests]);
      expect(ofLibrary[0], `the judge's input at N=${n}`).toBe(library.manifests);
      expect(omittedRead.length, `omitted-input reads at N=${n}`).toBeGreaterThan(0);
      for (const read of omittedRead) expect(read).toBe(library.manifests);
      expect(
        found
          .filter((d) => d.code === "METADATA_RESERVED_FIELD")
          .map((d) => ({ message: d.message, path: (d.data as { path?: string }).path })),
      ).toEqual([
        {
          message:
            "Imported library 'NestedStampTwiceLib', reached through import 'First': Telo.Sequence/job: 'steps[0].invoke.then.metadata.module' is written by the loader — the module the document belongs to — and cannot be written in a manifest. Remove it.",
          path: "imports.First",
        },
      ]);
    }
  }, 240_000);
});
