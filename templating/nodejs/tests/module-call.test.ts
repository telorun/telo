import { celMapFromEntries } from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { extractAccessChains } from "../src/cel/analyze.js";
import { compileExpression, namespaceDispatchOf } from "../src/cel/compile.js";
import { auditCalls } from "../src/cel/diagnose.js";
import { moduleCallNames, MODULE_CALL_DISPATCH_KEY } from "../src/cel/module-call.js";
import { analyzeCelExpression } from "../src/engines/cel.js";

const celEnv = buildCelEnvironment();
const NAMES = new Set(["Billing", "Self", "Checkout", "Telo"]);

/**
 * A site's environment: the declaring module's own names registered as namespaces, which is
 * what turns `Billing.format(x)` into a qualified call as the expression is READ. The
 * namespaces are open because whether such a call reaches a function is the host's verdict,
 * never this engine's — which is the split every reader below is written against.
 */
function siteEnv() {
  const env = celEnv.clone();
  for (const name of NAMES) env.registerNamespace(name, [], { open: true });
  return env;
}

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
    const env = siteEnv();
    const compiled = compileExpression(source, celEnv, NAMES);
    expect(compiled.source).toBe(source);
    const resolved = analyzeCelExpression(source, {
      celEnv: env,
      contextSchema: null,
      moduleNames: NAMES,
    }).calls.find((c) => c.moduleCall);
    expect(source.slice(resolved!.start, resolved!.end)).toBe("Billing.format(price)");
  });

  it("is a call on a bare name only — a field access receiver is an ordinary method call", () => {
    expect(moduleCallNames(siteEnv().parse("a.Billing.format(x)").root)).toEqual([]);
  });

  it("carries an argument's member chain, but not one rooted at a name the expression binds", () => {
    const source = "request.lines.map(item, Billing.total(item.net, request.rate))";
    const call = analyzeCelExpression(source, {
      celEnv: siteEnv(),
      contextSchema: null,
      moduleNames: NAMES,
    }).calls.find((c) => c.moduleCall);
    expect(call?.arguments?.map((a) => a.chain)).toEqual([undefined, ["request", "rate"]]);
  });

  it("keeps the receiver out of the access chains and the root references", () => {
    const compiled = compileExpression("Billing.format(price.amount)", celEnv, NAMES);
    expect(compiled.refs).toEqual(["price"]);
    const root = siteEnv().parse("Billing.format(price.amount)").root;
    expect(extractAccessChains(root)).toEqual([["price", "amount"]]);
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
    expect(celEnv.parse(MODULE_CALL_DISPATCH_KEY).diagnostics.length).toBeGreaterThan(0);
  });

  it("hands a module function its arguments in the form a HOST holds them", () => {
    // A `Telo.Callable`'s parameters are AJV-checked against its declared `params`, and a
    // controller's own `call` reads them as data — neither reads the value domain's map
    // container, so a map literal written at a call site arrived as `{"entries":{}}` and
    // was refused for a property its author had written.
    const compiled = compileExpression(
      "Self.seal({'query': 'q', 'page': 1}, [{'a': 2}])",
      celEnv,
      NAMES,
    );
    let seen: readonly unknown[] | undefined;
    const table = new Map<string, (args: readonly unknown[]) => unknown>([
      [
        "Self.seal",
        (args) => {
          seen = args;
          return "ok";
        },
      ],
    ]);
    expect(compiled.call({ [MODULE_CALL_DISPATCH_KEY]: table })).toBe("ok");
    expect(seen).toEqual([{ query: "q", page: 1n }, [{ a: 2n }]]);
    // The plain form, not the carrier: `Object.keys` of the container answered `entries`.
    expect(Object.keys(seen?.[0] as object)).toEqual(["query", "page"]);
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
    const env = siteEnv();
    const audit = auditCalls(source, env.parse(source).root, env);
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
      celEnv: siteEnv(),
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

  /**
   * The ADAPTER itself, not one caller's use of it. Every host that binds a
   * dispatch table reaches the engine through this one function — the kernel
   * while evaluating, and the analyzer while evaluating a rule condition or a
   * pure function body at `telo check`. A second adapter answered the filter
   * identically and the conversion differently, so a map literal at a call site
   * was the value domain's container at check and a plain object at run: a
   * divergence by construction, in the direction nothing reports.
   */
  it("hands a module function plain host values, whichever host bound the table", () => {
    // Asked of the adapter directly — the shape the analyzer reaches it in,
    // evaluating a rule condition or a pure function body at `telo check`.
    const direct: unknown[] = [];
    const dispatch = namespaceDispatchOf(
      new Map([["Billing.total", (args: readonly unknown[]) => (direct.push(...args), 1n)]]),
    );
    dispatch?.("Billing", "total")?.([celMapFromEntries(["a", 1n])] as never);

    // And through a compiled value — the shape the kernel reaches it in.
    const compiled: unknown[] = [];
    compileExpression("Billing.total({'a': 1})", celEnv, NAMES).call?.({
      [MODULE_CALL_DISPATCH_KEY]: new Map([
        ["Billing.total", (args: readonly unknown[]) => (compiled.push(...args), 1n)],
      ]),
    });

    // Both arrivals are the plain object, never the value domain's container.
    for (const seen of [direct, compiled]) {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ a: 1n });
      expect(Object.getPrototypeOf(seen[0])).toBe(Object.prototype);
    }
  });

  it("binds nothing when no table was bound, so the call is refused before its arguments run", () => {
    expect(namespaceDispatchOf(undefined)).toBeUndefined();
  });
});
