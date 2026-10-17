import { describe, expect, it } from "vitest";
import { buildCelEnvironment, compileExpression, type CelProgramSite } from "../src/index.js";

/**
 * An expression compiled with a program-site sink is one a host may switch onto an emitted
 * program, so its closure is built only if nothing was switched in by its first evaluation.
 * An unreadable expression is still refused where it is compiled.
 */
describe("program sites", () => {
  function counting() {
    const environment = buildCelEnvironment();
    let compiles = 0;
    const compile = environment.compile.bind(environment);
    environment.compile = ((source: Parameters<typeof compile>[0]) => {
      compiles += 1;
      return compile(source);
    }) as typeof environment.compile;
    return { environment, compiles: () => compiles };
  }

  it("builds no closure for an expression whose program is switched before it runs", () => {
    const { environment, compiles } = counting();
    const sites: CelProgramSite[] = [];
    const value = compileExpression("1 + 2", environment, undefined, sites);
    expect(compiles()).toBe(0);

    const replacement = buildCelEnvironment().compile("40 + 2");
    sites[0]!.use(replacement);
    expect(value.call!({})).toBe(42n);
    expect(compiles()).toBe(0);
  });

  it("builds the closure on first evaluation when nothing was switched in", () => {
    const { environment, compiles } = counting();
    const value = compileExpression("1 + 2", environment, undefined, []);
    expect(value.call!({})).toBe(3n);
    expect(value.call!({})).toBe(3n);
    expect(compiles()).toBe(1);
  });

  it("still refuses an unreadable expression where it is compiled", () => {
    expect(() => compileExpression("1 +", buildCelEnvironment(), undefined, [])).toThrow();
  });
});
