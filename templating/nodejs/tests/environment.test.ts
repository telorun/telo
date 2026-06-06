import { Stream } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";

describe("buildCelEnvironment", () => {
  it("registers Telo's stdlib of CEL functions", () => {
    const env = buildCelEnvironment();
    expect(env.parse("join(['a', 'b', 'c'], '-')")({})).toBe("a-b-c");
    expect(env.parse("keys({'x': 1, 'y': 2})")({})).toEqual(["x", "y"]);
    // cel-js parses integer literals as BigInts; assert that shape.
    expect(env.parse("values({'x': 1, 'y': 2})")({})).toEqual([1n, 2n]);
  });

  it("calls user-supplied handlers for sha256", () => {
    const env = buildCelEnvironment({ sha256: (s) => `H(${s})` });
    expect(env.parse("sha256('hello')")({})).toBe("H(hello)");
  });

  it("registers Stream as a CEL object type so producers can pass async iterables through", () => {
    const env = buildCelEnvironment();
    const stream = new Stream(
      (async function* () {
        yield "a";
      })(),
    );
    // Pass through the value — type-checker accepts the registered constructor.
    expect(env.parse("input")({ input: stream })).toBe(stream);
  });

  it("accepts a Stream produced by a 'foreign' sdk copy via the globalThis singleton", () => {
    // Simulates the kernel + npm-loaded-controller realm split: a controller
    // imports its own @telorun/sdk copy, that copy's stream.ts also calls
    // `globalThis[Symbol.for("@telorun/sdk:Stream")] ??= ctor`, so the
    // controller ends up using the *kernel's* Stream class. Two sdk copies =>
    // one constructor identity, and cel-js's type-by-constructor check
    // therefore matches the registered Stream regardless of which copy
    // produced the value.
    const ForeignStream = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@telorun/sdk:Stream")
    ] as typeof Stream;
    expect(ForeignStream).toBe(Stream);

    const env = buildCelEnvironment();
    const stream = new ForeignStream(
      (async function* () {
        yield "b";
      })(),
    );
    expect(env.parse("input")({ input: stream })).toBe(stream);
  });

  it("default sha256 stub throws a helpful error", () => {
    const env = buildCelEnvironment();
    expect(() => env.parse("sha256('x')")({})).toThrow(/sha256/);
  });

  it("provides current-time functions, UTC by default and zone-aware on demand", () => {
    const env = buildCelEnvironment();
    expect(env.parse("nowIso()")({})).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
    expect(env.parse("today()")({})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof env.parse("nowMillis()")({})).toBe("bigint");
    expect(typeof env.parse("nowSeconds()")({})).toBe("bigint");
    // Zone-aware overload: ISO with a numeric offset, not `Z`.
    expect(env.parse("nowIso('America/New_York')")({})).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    expect(env.parse("today('Asia/Tokyo')")({})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("provides UUID generators for every version", () => {
    const env = buildCelEnvironment();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const expr of ["uuidv1()", "uuidv4()", "uuidv6()", "uuidv7()"]) {
      expect(env.parse(expr)({})).toMatch(uuidRe);
    }
    // v3/v5 hash a name under a namespace UUID — deterministic for fixed inputs.
    const ns = env.parse("uuidv4()")({}) as string;
    const a = env.parse("uuidv5('alice', ns)")({ ns });
    const b = env.parse("uuidv5('alice', ns)")({ ns });
    expect(a).toMatch(uuidRe);
    expect(a).toBe(b);
  });

  it("validates and reads the version of a UUID", () => {
    const env = buildCelEnvironment();
    const v4 = env.parse("uuidv4()")({}) as string;
    expect(env.parse("uuidValidate(u)")({ u: v4 })).toBe(true);
    expect(env.parse("uuidValidate('nope')")({})).toBe(false);
    expect(env.parse("uuidVersion(u)")({ u: v4 })).toBe(4n);
  });

  it("provides string functions", () => {
    const env = buildCelEnvironment();
    expect(env.parse("lower('AbC')")({})).toBe("abc");
    expect(env.parse("upper('AbC')")({})).toBe("ABC");
    expect(env.parse("trim('  x  ')")({})).toBe("x");
    expect(env.parse("replace('a.b.c', '.', '-')")({})).toBe("a-b-c");
    expect(env.parse("split('a,b,c', ',')")({})).toEqual(["a", "b", "c"]);
  });

  it("provides math functions", () => {
    const env = buildCelEnvironment();
    expect(env.parse("abs(-3.5)")({})).toBe(3.5);
    expect(env.parse("floor(2.9)")({})).toBe(2);
    expect(env.parse("ceil(2.1)")({})).toBe(3);
    expect(env.parse("round(2.5)")({})).toBe(3);
    expect(env.parse("min([3.0, 1.0, 2.0])")({})).toBe(1);
    expect(env.parse("max([3.0, 1.0, 2.0])")({})).toBe(3);
  });

  it("provides collection functions without mutating the input", () => {
    const env = buildCelEnvironment();
    expect(env.parse("distinct([1, 1, 2, 3, 3])")({})).toEqual([1n, 2n, 3n]);
    expect(env.parse("reverse([1, 2, 3])")({})).toEqual([3n, 2n, 1n]);
    expect(env.parse("flatten([[1, 2], [3]])")({})).toEqual([1n, 2n, 3n]);
    expect(env.parse("sort([3.0, 1.0, 2.0])")({})).toEqual([1, 2, 3]);
  });

  it("provides JSON parse and URL encoding", () => {
    const env = buildCelEnvironment();
    expect(env.parse("parseJson('{\"a\": 1}').a")({})).toBe(1);
    expect(env.parse("urlEncode('a b&c')")({})).toBe("a%20b%26c");
    expect(env.parse("urlDecode('a%20b%26c')")({})).toBe("a b&c");
  });

  it("provides null-handling helpers (CEL has no ??)", () => {
    const env = buildCelEnvironment();
    expect(env.parse("default(x, 'fallback')")({ x: null })).toBe("fallback");
    expect(env.parse("default(x, 'fallback')")({ x: "value" })).toBe("value");
    expect(env.parse("coalesce(items)")({ items: [null, null, "last"] })).toBe("last");
  });

  it("routes hashing and base64 through host handlers", () => {
    const env = buildCelEnvironment({
      md5: (s) => `md5(${s})`,
      hmac: (algo, key, msg) => `${algo}:${key}:${msg}`,
      base64Encode: (s) => `b64(${s})`,
    });
    expect(env.parse("md5('x')")({})).toBe("md5(x)");
    expect(env.parse("hmac('sha256', 'k', 'm')")({})).toBe("sha256:k:m");
    expect(env.parse("base64Encode('hi')")({})).toBe("b64(hi)");
  });
});
