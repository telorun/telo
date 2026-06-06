import { describe, expect, it } from "vitest";
import { CEL_FUNCTIONS, celFunctionCatalog } from "../src/cel/catalog.js";
import { buildCelEnvironment } from "../src/cel/environment.js";

describe("CEL function catalog", () => {
  it("is the single source: every catalog function registers in the environment", () => {
    // buildCelEnvironment registers from CEL_FUNCTIONS; if a signature were
    // malformed this would throw. A nullary call per function also proves the
    // name is callable in the built env (for the ones that take no args).
    const env = buildCelEnvironment();
    for (const fn of CEL_FUNCTIONS) {
      for (const sig of fn.register ?? [fn.signature]) {
        if (/^\w+\(\)/.test(sig)) {
          // The nullary overload parses (name resolved, no "unknown function").
          expect(() => env.parse(`${fn.name}()`)).not.toThrow();
        }
      }
    }
  });

  it("celFunctionCatalog() omits the build impl but keeps the metadata", () => {
    const catalog = celFunctionCatalog();
    expect(catalog.length).toBe(CEL_FUNCTIONS.length);
    for (const entry of catalog) {
      expect(entry).not.toHaveProperty("build");
      expect(entry.name).toBeTruthy();
      expect(entry.signature).toContain(entry.name);
      expect(typeof entry.summary).toBe("string");
    }
  });

  it("has no duplicate function names", () => {
    const names = CEL_FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks non-deterministic and host-backed functions correctly", () => {
    const byName = Object.fromEntries(celFunctionCatalog().map((f) => [f.name, f]));
    expect(byName.nowIso.deterministic).toBe(false);
    expect(byName.uuidv4.deterministic).toBe(false);
    expect(byName.nowMillis.deterministic).toBe(false);
    expect(byName.lower.deterministic).toBe(true);
    expect(byName.uuidv5.deterministic).toBe(true);

    expect(byName.sha256.hostBacked).toBe(true);
    expect(byName.hmac.hostBacked).toBe(true);
    expect(byName.base64Encode.hostBacked).toBe(true);
    expect(byName.lower.hostBacked).toBe(false);
    expect(byName.parseJson.hostBacked).toBe(false);
  });
});
