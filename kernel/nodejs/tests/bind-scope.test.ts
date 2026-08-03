import { describe, expect, it } from "vitest";
import { buildCelEnvironment, compileExpression } from "@telorun/templating";
import { EvaluationContext } from "../src/evaluation-context.js";

/**
 * `bindScope` has to hold three properties, and only the first is visible in an
 * ordinary manifest run: a binding is lazy (so one nothing reads never runs),
 * memoised (so one several expressions read runs once), and never shadows a
 * variable already in scope — including the ambient globals, which live on the
 * context rather than in the scope the caller passes. The last is defence in
 * depth behind `BINDING_NAME_RESERVED`: it is what bounds a reserved name the
 * static check did not foresee to a dead binding instead of a hijacked global.
 */
const env = buildCelEnvironment();
const cel = (source: string) => compileExpression(source, env);

function contextOf(ambient: Record<string, unknown>): EvaluationContext {
  return new EvaluationContext("test", { ...ambient }, async () => null, new Set(), async () => {});
}

describe("EvaluationContext.bindScope", () => {
  it("evaluates a binding only when something reads it", () => {
    const ctx = contextOf({});
    let evaluated = 0;
    const counted = {
      __compiled: true as const,
      source: "counted",
      refs: [],
      call: () => {
        evaluated++;
        return 1;
      },
    };
    const scope = ctx.bindScope({ used: counted, unused: counted }, { inputs: {} });

    expect(ctx.expandWith(cel("used"), scope)).toBe(1);
    expect(evaluated).toBe(1);
  });

  it("computes a binding at most once per scope, however often it is read", () => {
    const ctx = contextOf({});
    let evaluated = 0;
    const scope = ctx.bindScope(
      {
        once: {
          __compiled: true as const,
          source: "once",
          refs: [],
          call: () => {
            evaluated++;
            return 2;
          },
        },
      },
      { inputs: {} },
    );

    expect(ctx.expandWith(cel("once"), scope)).toBe(2);
    expect(ctx.expandWith(cel("once + once"), scope)).toBe(4);
    expect(evaluated).toBe(1);
  });

  it("resolves one binding through another with no declared order", () => {
    const ctx = contextOf({});
    const scope = ctx.bindScope(
      { net: cel("gross - discount"), gross: cel("10"), discount: cel("gross / 2") },
      { inputs: {} },
    );
    expect(ctx.expandWith(cel("net"), scope)).toBe(5n);
  });

  it("throws ERR_BINDING_CYCLE rather than overflowing when a binding reaches itself", () => {
    const ctx = contextOf({});
    const scope = ctx.bindScope({ a: cel("b"), b: cel("a") }, { inputs: {} });
    expect(() => ctx.expandWith(cel("a"), scope)).toThrow(/ERR_BINDING_CYCLE|resolves through itself/);
  });

  it("never shadows the caller's scope or an ambient global", () => {
    const ctx = contextOf({ resources: { db: "real" } });
    const scope = ctx.bindScope(
      { inputs: cel("'hijacked'"), resources: cel("'hijacked'"), safe: cel("'own'") },
      { inputs: { id: "given" } },
    );

    expect(ctx.expandWith(cel("inputs.id"), scope)).toBe("given");
    expect(ctx.expandWith(cel("resources.db"), scope)).toBe("real");
    expect(ctx.expandWith(cel("safe"), scope)).toBe("own");
  });

  it("restores the context after an expansion, leaving no binding behind", () => {
    const ctx = contextOf({});
    const scope = ctx.bindScope({ temp: cel("1") }, { inputs: {} });
    ctx.expandWith(cel("temp"), scope);
    expect(() => ctx.expand(cel("temp"))).toThrow();
  });
});
