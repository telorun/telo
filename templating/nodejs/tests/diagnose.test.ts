import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { analyzeCelExpression } from "../src/engines/cel.js";

const env = { celEnv: buildCelEnvironment(), contextSchema: null };
const analyze = (expr: string) => analyzeCelExpression(expr, env);
const codes = (expr: string) => analyze(expr).diagnostics.map((d) => d.code);
const first = (expr: string) => analyze(expr).diagnostics[0]!;

describe("call form classification", () => {
  it("reads a global call of a method as a call-form error, not a type error", () => {
    // The distinction is the whole point: cel-js reports
    // `no matching overload for 'startsWith(dyn, string)'`, whose named argument
    // types send the reader looking for a cast that cannot help.
    const d = first("startsWith(key, 'uploads/')");
    expect(d.code).toBe("CEL_WRONG_CALL_FORM");
    expect(d.fix?.replacement).toBe("key.startsWith('uploads/')");
  });

  it("classifies by registry, not by argument types — literals fail identically", () => {
    expect(codes("startsWith('abc', 'x')")).toEqual(["CEL_WRONG_CALL_FORM"]);
  });

  it("reads a method call of a global function as the mirror error", () => {
    const d = first("name.lower()");
    expect(d.code).toBe("CEL_WRONG_CALL_FORM");
    expect(d.fix?.replacement).toBe("lower(name)");
  });

  it("parenthesizes a receiver that would otherwise reparse", () => {
    expect(first("startsWith(a + b, 'x')").fix?.replacement).toBe("(a + b).startsWith('x')");
  });

  it("accepts a name registered in both forms, either way round", () => {
    expect(codes("s.trim()")).toEqual([]);
    expect(codes("trim(s)")).toEqual([]);
  });

  it("leaves macros alone — they are expanded by the parser, not registered", () => {
    expect(codes("items.filter(x, x > 1)")).toEqual([]);
  });
});

describe("unknown functions", () => {
  it("says the name does not exist rather than blaming the arguments", () => {
    const d = first("now()");
    expect(d.code).toBe("CEL_UNKNOWN_FUNCTION");
    expect(d.message).toContain("there is no function `now`");
  });

  it("reaches nowIso/nowMillis/nowSeconds from `now` — edit distance never would", () => {
    const message = first("now()").message;
    for (const name of ["nowIso", "nowMillis", "nowSeconds"]) {
      expect(message).toContain(name);
    }
  });

  // The receiver name has to be one the registry does NOT know: `slice` is
  // registered now, so a mis-arity call on it is classified as a wrong overload
  // rather than a missing name, and would no longer exercise this path.
  it("filters candidates by arity, so a 1-arg method lists substring", () => {
    const message = first("s.subst(7)").message;
    expect(message).toContain("there is no method `subst`");
    expect(message).toContain("substring");
  });

  it("offers a fix only when one candidate is unambiguous", () => {
    // Several `uuidvN()` candidates — picking one would be a guess.
    expect(first("uuid()").fix).toBeUndefined();
  });
});

describe("arbitration with the type checker", () => {
  it("reports every bad call in one pass, where check() stops at the first", () => {
    expect(codes("startsWith(key, 'u') && now() > 5")).toEqual([
      "CEL_WRONG_CALL_FORM",
      "CEL_UNKNOWN_FUNCTION",
    ]);
  });

  it("suppresses the opaque residual when the audit already explained it", () => {
    expect(codes("startsWith(key, 'u')")).not.toContain("CEL_TYPE_ERROR");
  });

  it("still reports a genuine type mismatch the audit cannot explain", () => {
    expect(codes("'x' + 1")).toEqual(["CEL_TYPE_ERROR"]);
  });

  it("explains a known name that no registered signature accepts", () => {
    const d = first("upper()");
    expect(d.code).toBe("CEL_TYPE_ERROR");
    expect(d.message).toContain("upper(string): string");
  });

  it("explains `dyn` without firing on the word 'dynamic'", () => {
    // Right name, right form, right arity — only the argument types are wrong,
    // so this is a real residual, and one of them is untyped.
    expect(first("hmac(a.b, 1, 2)").message).toContain("no static type here");
    // "must be list, map, or dynamic" contains `dyn` as a substring but says
    // nothing about an untyped operand.
    expect(first("list.filter(x, x > 1)").message).not.toContain("no static type here");
  });

  it("reports the checked type for a valid expression", () => {
    expect(analyze("upper(a.b)").type).toBe("string");
  });
});

describe("timestamp round-trip", () => {
  it("converts an instant back out, so a computed expiry can be stored", () => {
    expect(analyze("string(timestamp(nowSeconds()) + duration('24h'))").type).toBe("string");
    expect(analyze("int(timestamp(nowIso()))").type).toBe("int");
  });
});

describe("call inventory", () => {
  it("reports determinism so a caller can apply eval-mode policy", () => {
    const calls = analyze("nowIso() + upper(x)").calls;
    expect(calls.find((c) => c.name === "nowIso")?.deterministic).toBe(false);
    expect(calls.find((c) => c.name === "upper")?.deterministic).toBe(true);
  });

  it("leaves determinism undefined for an unregistered name — absent is not 'deterministic'", () => {
    expect(analyze("now()").calls[0]!.deterministic).toBeUndefined();
  });
});
