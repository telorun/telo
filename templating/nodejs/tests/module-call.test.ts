import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { extractAccessChains } from "../src/cel/analyze.js";
import { compileExpression } from "../src/cel/compile.js";
import { auditCalls } from "../src/cel/diagnose.js";
import {
  moduleCallOf,
  resolveModuleCalls,
  MODULE_CALL_DISPATCH_KEY,
} from "../src/cel/module-call.js";
import { analyzeCelExpression } from "../src/engines/cel.js";

const celEnv = buildCelEnvironment();
const NAMES = new Set(["Billing", "Self", "Checkout", "Telo"]);

describe("resolution on the parsed tree", () => {
  it("carries every qualified call and nothing a bare name reaches", () => {
    expect(compileExpression("Billing.format(x) + Self.y(1)", celEnv, NAMES).calls).toEqual([
      "Billing.format",
      "Self.y",
    ]);
    expect(compileExpression("format(1, ',d', 'en')", celEnv, NAMES).calls).toEqual([]);
  });

  it("leaves the author's text and spans untouched", () => {
    const source = "'x' + Billing.format(price)";
    const compiled = compileExpression(source, celEnv, NAMES);
    expect(compiled.source).toBe(source);
    const call = auditCalls(source, celEnv.parse(source).ast, celEnv).calls[0];
    const resolved = analyzeCelExpression(source, {
      celEnv,
      contextSchema: null,
      moduleNames: NAMES,
    }).calls.find((c) => c.moduleCall);
    expect(source.slice(resolved!.start, resolved!.end)).toBe("Billing.format(price)");
    // The unresolved reading of the same text spans the same range — resolution
    // changes what the node MEANS, never where it is.
    expect([call!.start, call!.end]).toEqual([resolved!.start, resolved!.end]);
  });

  it("is a call on a bare name only — a field access receiver is an ordinary method call", () => {
    const ast = celEnv.parse("a.Billing.format(x)").ast;
    expect(resolveModuleCalls(ast, NAMES)).toEqual([]);
  });

  it("carries an argument's member chain, but not one rooted at a name the expression binds", () => {
    const source = "request.lines.map(item, Billing.total(item.net, request.rate))";
    const call = analyzeCelExpression(source, {
      celEnv,
      contextSchema: null,
      moduleNames: NAMES,
    }).calls.find((c) => c.moduleCall);
    expect(call?.arguments?.map((a) => a.chain)).toEqual([undefined, ["request", "rate"]]);
  });

  it("keeps the receiver out of the access chains and the root references", () => {
    const compiled = compileExpression("Billing.format(price.amount)", celEnv, NAMES);
    expect(compiled.refs).toEqual(["price"]);
    const ast = celEnv.parse("Billing.format(price.amount)").ast;
    resolveModuleCalls(ast, NAMES);
    expect(extractAccessChains(ast)).toEqual([["price", "amount"]]);
  });
});

describe("dispatch", () => {
  it("throws naming the qualified function when nothing bound it", () => {
    const compiled = compileExpression("Billing.format(1)", celEnv, NAMES);
    expect(() => compiled.call({})).toThrow(/unbound function 'Billing\.format'/);
  });

  it("dispatches through a table no CEL source can name", () => {
    const compiled = compileExpression("Billing.format(1) + Self.y(2)", celEnv, NAMES);
    const table = new Map<string, (args: readonly unknown[]) => unknown>([
      ["Billing.format", ([n]) => `#${n}`],
      ["Self.y", ([n]) => `!${n}`],
    ]);
    expect(compiled.call({ [MODULE_CALL_DISPATCH_KEY]: table })).toBe("#1!2");
    // The key is outside CEL's identifier grammar, so no expression can read
    // the table — the dispatcher is unreachable from source.
    expect(() => celEnv.parse(`${MODULE_CALL_DISPATCH_KEY}`)).toThrow();
  });

  it("reaches the table through a comprehension and a cel.bind overlay", () => {
    const compiled = compileExpression(
      "cel.bind(k, 2, items.map(i, Self.y(i + k)))",
      celEnv,
      NAMES,
    );
    const table = new Map<string, (args: readonly unknown[]) => unknown>([
      ["Self.y", ([n]) => (n as bigint) * 10n],
    ]);
    expect(
      compiled.call({ items: [1n, 2n], [MODULE_CALL_DISPATCH_KEY]: table }),
    ).toEqual([30n, 40n]);
  });
});

describe("what the catalog says about a module call", () => {
  it("does not classify one against the catalog, and attaches no catalog flag", () => {
    const source = "Billing.format(1) + Checkout.now()";
    const ast = celEnv.parse(source).ast;
    resolveModuleCalls(ast, NAMES);
    const audit = auditCalls(source, ast, celEnv);
    expect(audit.diagnostics).toEqual([]);
    expect(audit.calls.map((c) => [c.name, c.moduleCall, c.deterministic])).toEqual([
      ["Billing.format", true, undefined],
      ["Checkout.now", true, undefined],
    ]);
  });
});

describe("names a module call takes over", () => {
  const analyze = (expr: string, moduleNames = NAMES) =>
    analyzeCelExpression(expr, {
      celEnv,
      contextSchema: null,
      rootsDeclared: false,
      moduleNames,
    }).diagnostics;

  it("reserves a comprehension variable named after a module", () => {
    expect(analyze("items.map(Billing, Billing + 1)")[0]).toMatchObject({
      code: "BINDING_NAME_RESERVED",
    });
  });

  it("reserves a cel.bind name equal to a module name", () => {
    expect(analyze("cel.bind(Self, 3, Self + 1)")[0]).toMatchObject({
      code: "BINDING_NAME_RESERVED",
    });
  });

  /** The hint is repair advice, so it is offered only where the repair is the
   *  right one: the host says which names could denote a module at all. */
  const unknownIdentifier = (expr: string, couldNameModule: (name: string) => boolean) =>
    analyzeCelExpression(expr, {
      celEnv: buildCelEnvironment().registerVariable("variables", "map"),
      contextSchema: null,
      rootsDeclared: true,
      moduleNames: NAMES,
      couldNameModule,
    }).diagnostics.find((x) => x.code === "CEL_UNKNOWN_IDENTIFIER");

  const typeLevel = (name: string) => name[0]! >= "A" && name[0]! <= "Z";

  it("tells an undeclared call receiver it needs an imports: alias", () => {
    expect(unknownIdentifier("Unknown.bar(1)", typeLevel)?.message).toContain("imports:");
  });

  it("withholds that advice from a receiver that could not name a module", () => {
    expect(unknownIdentifier("dbb.query(1)", typeLevel)?.message).not.toContain("imports:");
  });
});

/**
 * The cel-js internals resolution rests on. None is in the package's typings,
 * so an upgrade can move any of them without a type error anywhere — these
 * assertions are what turns that into a failing test.
 */
describe("cel-js internals guard", () => {
  it("redirects check and evaluation through setMeta('macro')", () => {
    const parsed = celEnv.parse("Billing.format(x)");
    resolveModuleCalls(parsed.ast, NAMES);
    const call = moduleCallOf(parsed.ast);
    expect(call?.qualified).toBe("Billing.format");
    // `check()` on the REWRITTEN tree — `celEnv.check(source)` re-parses and
    // would type a tree with no rewrite in it.
    expect(parsed.check()).toEqual({ valid: true, type: "dyn" });
  });

  it("types a module call from the resolver hook, and its arguments in place", () => {
    const parsed = celEnv.parse("Billing.format(1) + 'x'");
    resolveModuleCalls(parsed.ast, NAMES, () => "string");
    expect(parsed.check()).toEqual({ valid: true, type: "string" });
  });

  it("is synchronous once checked when every argument is", () => {
    const typed = buildCelEnvironment().registerVariable("n", "int");
    const parsed = typed.parse("Billing.format(n + 1)");
    resolveModuleCalls(parsed.ast, NAMES);
    expect(parsed.check().valid).toBe(true);
    expect(parsed.ast.maybeAsync).toBe(false);
  });

  it("checks arguments in the current context", () => {
    const typed = buildCelEnvironment().registerVariable("n", "string");
    const parsed = typed.parse("Billing.format(n + 1)");
    resolveModuleCalls(parsed.ast, NAMES);
    expect(parsed.check().valid).toBe(false);
  });

  it("resolves a call the parser expanded as a comprehension macro as the module call it names", () => {
    // `map` expands into an `alternate`, which cel-js consults before `macro`. A
    // call whose arguments do not fit the macro never parses at all, which is why
    // no function may take a macro's name.
    const parsed = celEnv.parse("Billing.map(i, i)");
    expect(resolveModuleCalls(parsed.ast, NAMES)).toEqual(["Billing.map"]);
    const table = new Map<string, (args: readonly unknown[]) => unknown>([
      ["Billing.map", (args) => args.length],
    ]);
    expect(parsed({ i: 1n, [MODULE_CALL_DISPATCH_KEY]: table })).toBe(2);
  });
});
