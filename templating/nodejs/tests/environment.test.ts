import { isCelTimestamp, Stream } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";

/**
 * The realm guard that stood here is **gone**, and its premise with it: it asserted that
 * the engine's `Duration` / `UnsignedInt` classes were the ones `@telorun/sdk` exports,
 * because that engine typed and dispatched by constructor and a second installed copy made
 * every value a controller built foreign. The value domain is now `@telorun/cel`'s, where a
 * value says what it is under `Symbol.for("telo.cel.value")` — one symbol in every copy — so
 * there is nothing left for this package to assert about it.
 */
describe("buildCelEnvironment", () => {
  it("registers Telo's stdlib of CEL functions", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("join(['a', 'b', 'c'], '-')")).toBe("a-b-c");
    expect(env.evaluate("keys({'x': 1, 'y': 2})")).toEqual(["x", "y"]);
    // A CEL int is int64, so an integer literal is a bigint; assert that shape.
    expect(env.evaluate("values({'x': 1, 'y': 2})")).toEqual([1n, 2n]);
  });

  it("type-checks heterogeneous aggregate literals (cel-go default, unify to dyn)", () => {
    const env = buildCelEnvironment();
    // Concrete mixed list/map: cel-go unifies to dyn instead of erroring.
    expect(env.check("[1, 'two']")).toMatchObject({ valid: true });
    expect(env.check("{'a': 1, 'b': true}")).toMatchObject({ valid: true });
    // The manifest-world case: map value type inferred as dyn absorbs a bool.
    expect(env.check("items.map(r, {'id': r.id, 'done': r.done == 1})")).toMatchObject({
      valid: true,
    });
  });

  it("calls user-supplied handlers for sha256", () => {
    const env = buildCelEnvironment({ sha256: (s) => `H(${s})` });
    expect(env.evaluate("sha256('hello')")).toBe("H(hello)");
  });

  it("registers Stream as a live handle: carried through, with no member to read", () => {
    const env = buildCelEnvironment().registerVariable("input", "Stream");
    const stream = new Stream(
      (async function* () {
        yield "a";
      })(),
    );
    // A producer's handle reaches a consumer untouched, whichever sdk copy built
    // it — identity is no longer a class, so there is nothing to deduplicate.
    expect(env.evaluate("input", { input: stream })).toBe(stream);
    // `dyn` underneath with no conversion and no member, so reading anything off
    // one is refused where the author can see it.
    expect(env.check("input.text").diagnostics).toEqual([
      { code: "CEL_TYPE_ERROR", message: "Stream holds no members", range: [6, 10] },
    ]);
  });

  it("default sha256 stub throws a helpful error", () => {
    const env = buildCelEnvironment();
    expect(() => env.evaluate("sha256('x')")).toThrow(/sha256/);
  });

  it("provides current-time functions, UTC by default and zone-aware on demand", () => {
    const env = buildCelEnvironment();
    expect(isCelTimestamp(env.evaluate("now()"))).toBe(true);
    expect(env.evaluate("nowIso()")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
    expect(env.evaluate("today()")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof env.evaluate("nowMillis()")).toBe("bigint");
    expect(typeof env.evaluate("nowSeconds()")).toBe("bigint");
    // Zone-aware overload: ISO with a numeric offset, not `Z`.
    expect(env.evaluate("nowIso('America/New_York')")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    expect(env.evaluate("today('Asia/Tokyo')")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("provides UUID generators for every version", () => {
    const env = buildCelEnvironment();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const expr of ["uuidv1()", "uuidv4()", "uuidv6()", "uuidv7()"]) {
      expect(env.evaluate(expr)).toMatch(uuidRe);
    }
    // v3/v5 hash a name under a namespace UUID — deterministic for fixed inputs.
    const ns = env.evaluate("uuidv4()") as string;
    const a = env.evaluate("uuidv5('alice', ns)", { ns });
    const b = env.evaluate("uuidv5('alice', ns)", { ns });
    expect(a).toMatch(uuidRe);
    expect(a).toBe(b);
  });

  it("validates and reads the version of a UUID", () => {
    const env = buildCelEnvironment();
    const v4 = env.evaluate("uuidv4()") as string;
    expect(env.evaluate("uuidValidate(u)", { u: v4 })).toBe(true);
    expect(env.evaluate("uuidValidate('nope')")).toBe(false);
    expect(env.evaluate("uuidVersion(u)", { u: v4 })).toBe(4n);
  });

  it("provides string functions", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("lower('AbC')")).toBe("abc");
    expect(env.evaluate("upper('AbC')")).toBe("ABC");
    expect(env.evaluate("trim('  x  ')")).toBe("x");
    expect(env.evaluate("replace('a.b.c', '.', '-')")).toBe("a-b-c");
    expect(env.evaluate("split('a,b,c', ',')")).toEqual(["a", "b", "c"]);
  });

  it("provides math functions", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("abs(-3.5)")).toBe(3.5);
    expect(env.evaluate("floor(2.9)")).toBe(2);
    expect(env.evaluate("ceil(2.1)")).toBe(3);
    expect(env.evaluate("round(2.5)")).toBe(3);
    expect(env.evaluate("min([3.0, 1.0, 2.0])")).toBe(1);
    expect(env.evaluate("max([3.0, 1.0, 2.0])")).toBe(3);
  });

  it("provides collection functions without mutating the input", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("distinct([1, 1, 2, 3, 3])")).toEqual([1n, 2n, 3n]);
    expect(env.evaluate("reverse([1, 2, 3])")).toEqual([3n, 2n, 1n]);
    expect(env.evaluate("flatten([[1, 2], [3]])")).toEqual([1n, 2n, 3n]);
    expect(env.evaluate("sort([3.0, 1.0, 2.0])")).toEqual([1, 2, 3]);
  });

  it("provides JSON parse and URL encoding", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("parseJson('{\"a\": 1}').a")).toBe(1);
    expect(env.evaluate("urlEncode('a b&c')")).toBe("a%20b%26c");
    expect(env.evaluate("urlDecode('a%20b%26c')")).toBe("a b&c");
  });

  it("provides null-handling helpers (CEL has no ??)", () => {
    const env = buildCelEnvironment();
    expect(env.evaluate("default(x, 'fallback')", { x: null })).toBe("fallback");
    expect(env.evaluate("default(x, 'fallback')", { x: "value" })).toBe("value");
    expect(env.evaluate("coalesce(items)", { items: [null, null, "last"] })).toBe("last");
  });

  it("routes hashing and base64 through host handlers", () => {
    const env = buildCelEnvironment({
      md5: (s) => `md5(${s})`,
      hmac: (algo, key, msg) => `${algo}:${key}:${msg}`,
      base64Encode: (s) => `b64(${s})`,
    });
    expect(env.evaluate("md5('x')")).toBe("md5(x)");
    expect(env.evaluate("hmac('sha256', 'k', 'm')")).toBe("sha256:k:m");
    expect(env.evaluate("base64Encode('hi')")).toBe("b64(hi)");
  });
});
