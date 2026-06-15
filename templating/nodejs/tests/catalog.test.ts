import { describe, expect, it } from "vitest";
import { CEL_FUNCTIONS, celFunctionCatalog } from "../src/cel/catalog.js";
import { buildCelEnvironment, deriveSignatures } from "../src/cel/environment.js";

describe("deriveSignatures", () => {
  it("returns the signature unchanged when no ? is present", () => {
    expect(deriveSignatures("fn(string): bool")).toEqual(["fn(string): bool"]);
    expect(deriveSignatures("fn(): string")).toEqual(["fn(): string"]);
  });

  it("expands a single optional param into 0-arg and 1-arg variants", () => {
    expect(deriveSignatures("nowIso(string?): string")).toEqual([
      "nowIso(): string",
      "nowIso(string): string",
    ]);
  });

  it("expands mixed required + optional params", () => {
    expect(deriveSignatures("fn(int, string?): bool")).toEqual([
      "fn(int): bool",
      "fn(int, string): bool",
    ]);
  });

  it("returns the signature unchanged when it cannot be parsed", () => {
    expect(deriveSignatures("not a signature")).toEqual(["not a signature"]);
  });
});

describe("CEL function catalog", () => {
  it("is the single source: every catalog function registers in the environment", () => {
    // buildCelEnvironment registers from CEL_FUNCTIONS; if a signature were
    // malformed this would throw. A nullary call per function also proves the
    // name is callable in the built env (for the ones that take no args).
    const env = buildCelEnvironment();
    for (const fn of CEL_FUNCTIONS) {
      for (const sig of fn.register ?? deriveSignatures(fn.signature)) {
        if (/^\w+\(\)/.test(sig)) {
          // The nullary overload both parses AND type-checks successfully.
          expect(() => env.parse(`${fn.name}()`)).not.toThrow();
          expect(env.check(`${fn.name}()`)).toMatchObject({ valid: true });
        }
      }
    }
  });

  it("optional-param functions type-check at their minimal arity", () => {
    // Guards the case where a function has optional args — its minimal-arity
    // overload (only the required params) must pass env.check(). For a
    // fully-optional function (e.g. nowIso) that is the 0-arg call; for one with
    // required params (e.g. regexReplace) it is the required-only call.
    const placeholder: Record<string, string> = {
      string: "''",
      int: "1",
      double: "1.0",
      bool: "true",
      list: "[]",
      map: "{}",
    };
    const litFor = (type: string) => placeholder[type.trim()] ?? "1";
    const env = buildCelEnvironment();
    const optionalFns = CEL_FUNCTIONS.filter((fn) => fn.signature.includes("?"));
    expect(optionalFns.length).toBeGreaterThan(0);
    for (const fn of optionalFns) {
      const minimal = (fn.register ?? deriveSignatures(fn.signature))[0]!;
      const params = minimal.slice(minimal.indexOf("(") + 1, minimal.indexOf(")")).trim();
      const args = params === "" ? "" : params.split(",").map(litFor).join(", ");
      const call = `${fn.name}(${args})`;
      expect(env.check(call), `${call} should type-check`).toMatchObject({ valid: true });
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
