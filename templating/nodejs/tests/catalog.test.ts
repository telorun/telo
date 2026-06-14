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

describe("indexing & regex/affix functions", () => {
  const env = buildCelEnvironment();

  it("range materializes [0, n-1] and is empty for n <= 0", () => {
    expect(env.evaluate("range(3)")).toEqual([0n, 1n, 2n]);
    expect(env.evaluate("range(0)")).toEqual([]);
    expect(env.evaluate("range(-2)")).toEqual([]);
  });

  it("range + map indexes an unknown-length list (NumberLines)", () => {
    expect(
      env.evaluate("range(size(xs)).map(i, string(i + 1) + ': ' + xs[i])", {
        xs: ["a", "b", "c"],
      }),
    ).toEqual(["1: a", "2: b", "3: c"]);
  });

  it("enumerate pairs each element with its index", () => {
    expect(env.evaluate("enumerate(xs)", { xs: ["a", "b"] })).toEqual([
      { index: 0n, value: "a" },
      { index: 1n, value: "b" },
    ]);
    expect(
      env.evaluate("enumerate(xs).map(e, string(e.index + 1) + ': ' + e.value)", {
        xs: ["a", "b"],
      }),
    ).toEqual(["1: a", "2: b"]);
  });

  it("regexReplace replaces every match by default and honors flags", () => {
    expect(env.evaluate("regexReplace('a1b2', '[0-9]', '#')")).toBe("a#b#");
    expect(env.evaluate("regexReplace('keep<x>drop</x>tail', '<x>.*?</x>', '', 's')")).toBe(
      "keeptail",
    );
    expect(env.evaluate("regexReplace('John Smith', '(\\\\w+) (\\\\w+)', '$2 $1')")).toBe(
      "Smith John",
    );
  });

  it("regexExtract / regexExtractAll / regexGroups pull matches and groups", () => {
    expect(env.evaluate("regexExtract('id=42;', '[0-9]+')")).toBe("42");
    expect(env.evaluate("regexExtract('none', '[0-9]+')")).toBe("");
    expect(env.evaluate("regexExtractAll('a1b2c3', '[0-9]')")).toEqual(["1", "2", "3"]);
    expect(env.evaluate("regexGroups('2026-06-14', '(\\\\d+)-(\\\\d+)-(\\\\d+)')")).toEqual([
      "2026",
      "06",
      "14",
    ]);
    expect(env.evaluate("regexGroups('x', '(\\\\d+)')")).toEqual([]);
  });

  it("trimPrefix / trimSuffix strip a fixed affix only when present", () => {
    expect(env.evaluate("trimPrefix('foobar', 'foo')")).toBe("bar");
    expect(env.evaluate("trimPrefix('foobar', 'xyz')")).toBe("foobar");
    expect(env.evaluate("trimSuffix('line.', '.')")).toBe("line");
    expect(env.evaluate("trimSuffix('line', '.')")).toBe("line");
  });
});
