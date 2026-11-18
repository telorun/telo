import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flagTargets, loadGenerated, RUN } from "./configuration-cost-fixtures.js";

// How often each library stage reads the libraries' documents.
const calls = vi.hoisted(() => ({ scoped: 0, browser: 0, textKeys: [] as unknown[] }));
vi.mock("../src/validate-scoped-kind-documents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate-scoped-kind-documents.js")>();
  return {
    ...actual,
    validateLibraryScopedKindDocuments: (...args: Parameters<typeof actual.validateLibraryScopedKindDocuments>) => {
      calls.scoped++;
      return actual.validateLibraryScopedKindDocuments(...args);
    },
  };
});
vi.mock("../src/validate-library-browser-exports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate-library-browser-exports.js")>();
  return {
    ...actual,
    validateLibraryBrowserExports: (...args: Parameters<typeof actual.validateLibraryBrowserExports>) => {
      calls.browser++;
      return actual.validateLibraryBrowserExports(...args);
    },
  };
});
vi.mock("../src/text-keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/text-keys.js")>();
  return {
    ...actual,
    misplacedTextKeys: (...args: Parameters<typeof actual.misplacedTextKeys>) => {
      calls.textKeys.push(args[0]);
      return actual.misplacedTextKeys(...args);
    },
  };
});

const AGREEMENT = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "tests/__fixtures__/check-run-agreement");
const LIBRARIES = {
  scoped: join(AGREEMENT, "scoped-kind-document-library/lib"),
  browser: join(AGREEMENT, "browser-entry/unknown-export/lib"),
  textKeys: join(AGREEMENT, "text-vocabulary/text-keys/outside-schema-lib"),
};

/** `n` flags choosing targets, and each library imported twice. */
function twoImportsOfEach(n: number): string {
  const imports = Object.entries(LIBRARIES)
    .flatMap(([name, source]) => [`  ${name}First: ${source}`, `  ${name}Second: ${source}`])
    .join("\n");
  return flagTargets(n).replace(`  Run: ${RUN}\n`, `  Run: ${RUN}\n${imports}\n`);
}

describe("what a library's own documents hold of scope members, browser exports and text keys", () => {
  it("is judged once per library however many configurations, and reported once at the first import reaching it: N=1, 4 and 8", async () => {
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`library-document-stages-${n}.yaml`, twoImportsOfEach(n));
      const documents = loaded.moduleDocuments.filter((d) => ["ScopedKindDocumentLib", "BrowserExportUnknownLib", "TextKeysOutsideLib"].includes(d.module));
      expect(documents.length, `libraries at N=${n}`).toBe(3);
      calls.scoped = calls.browser = 0;
      calls.textKeys.length = 0;
      const found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      expect(calls.scoped, `scope-member judge at N=${n}`).toBe(1);
      expect(calls.browser, `browser-export judge at N=${n}`).toBe(1);
      // Each document of the libraries is read once, by identity.
      const read = new Set(calls.textKeys);
      for (const library of documents) {
        for (const m of library.manifests) {
          expect(calls.textKeys.filter((doc) => doc === m).length, `${library.module} ${String(m.kind)}/${String(m.metadata?.name)} at N=${n}`).toBe(1);
          expect(read.has(m)).toBe(true);
        }
      }
      const reported = (code: string) => found.filter((d) => d.code === code).map((d) => (d.data as { path?: string }).path);
      expect(reported("CAPABILITY_UNKNOWN"), `capability at N=${n}`).toEqual(["imports.scopedFirst"]);
      expect(reported("BROWSER_EXPORT_UNKNOWN"), `browser export at N=${n}`).toEqual(["imports.browserFirst"]);
      expect(reported("TEXT_KEYS_INVALID").filter((path) => path === "imports.textKeysFirst").length, `text keys at N=${n}`).toBeGreaterThan(0);
      expect(reported("TEXT_KEYS_INVALID").filter((path) => path === "imports.textKeysSecond"), `text keys at the second import at N=${n}`).toEqual([]);
    }
  }, 240_000);
});
