import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { analyzeCelExpression } from "../src/engines/cel.js";

const env = { celEnv: buildCelEnvironment(), contextSchema: null };
const analyze = (expr: string) => analyzeCelExpression(expr, env);
const codes = (expr: string) => analyze(expr).diagnostics.map((d) => d.code);
const first = (expr: string) => analyze(expr).diagnostics[0]!;

describe("a rejected read", () => {
  it("names the undeclared field and what IS declared", () => {
    const typed = buildCelEnvironment();
    typed.registerVariable("variables", { fields: { db: "string" } });
    const { diagnostics } = analyzeCelExpression("variables.dbb", {
      celEnv: typed,
      contextSchema: null,
    });
    expect(diagnostics).toEqual([
      { code: "CEL_UNKNOWN_FIELD", message: '"dbb" is not declared here (declared: db)' },
    ]);
  });
});

describe("call form classification", () => {
  it("reads a global call of a method as a call-form error, not a type error", () => {
    // The distinction is the whole point: a message naming the argument types
    // sends the reader looking for a cast that cannot help, where the repair is
    // the other call form — and the fix is the whole expression, rewritten.
    const d = first("startsWith(key, 'uploads/')");
    expect(d.code).toBe("CEL_WRONG_CALL_FORM");
    expect(d.fix?.replacement).toBe('key.startsWith("uploads/")');
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
    expect(first("startsWith(a + b, 'x')").fix?.replacement).toBe('(a + b).startsWith("x")');
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
    const d = first("no()");
    expect(d.code).toBe("CEL_UNKNOWN_FUNCTION");
    // The names that WOULD have worked ride the same sentence — the registered names
    // accepting its form and arity, ranked by the engine's own declared rule.
    expect(d.message).toBe(
      'no function named "no" is registered — the closest taking no arguments: ' +
        "now, nowIso, today, uuidv1, uuidv4",
    );
  });
});

describe("arbitration with the type checker", () => {
  it("reports every bad call in one pass, where check() stops at the first", () => {
    expect(codes("startsWith(key, 'u') && nosuchfn() > 5")).toEqual([
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
    expect(analyze("nosuchfn()").calls[0]!.deterministic).toBeUndefined();
  });
});

describe("cel.bind", () => {
  it("is never classified as an unknown method", () => {
    expect(codes("cel.bind(c, 150, string(c))")).not.toContain("CEL_UNKNOWN_FUNCTION");
  });

  it("reports an unrelated bad call inside the body, and only that one", () => {
    const ds = analyze("cel.bind(c, 150, nosuchfn(c))").diagnostics;
    expect(ds.map((d) => d.code)).toEqual(["CEL_UNKNOWN_FUNCTION"]);
    expect(ds[0]!.message).toContain("nosuchfn");
    expect(ds[0]!.message).not.toContain("`bind`");
  });

  it("evaluates, so the analyzer and the runtime agree it is valid", () => {
    expect(env.celEnv.evaluate("cel.bind(c, 150, string(c / 100) + '.' + string(c % 100))")).toBe(
      "1.50",
    );
  });
});
