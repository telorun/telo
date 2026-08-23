import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { EffectScope } from "../src/effect-scope.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/revertible-effects-app/telo.yaml");

async function journalOf(kernel: Kernel): Promise<string[]> {
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const instance = ctx.resolveImportedInstance("Fixture", "journal");
  const report = (await instance.provide()) as { entries: string[] };
  return report.entries;
}

describe("revertible effects — the accumulator", () => {
  it("unwinds a frame last-in-first-out", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    await scope
      .chain("a", async () => ({ result: 1, inverse: () => order.push("~a") }))
      .effect("b", async () => ({ result: 2, inverse: () => order.push("~b") }))
      .perform();
    expect(await scope.unwindFrame()).toEqual([]);
    expect(order).toEqual(["~b", "~a"]);
  });

  it("threads each step's result into the next", async () => {
    const scope = new EffectScope("test");
    const { result } = await scope
      .chain("first", async () => ({ result: { port: 8080 }, inverse: () => {} }))
      .effect("second", async ({ port }) => ({ result: `http://host:${port}`, inverse: () => {} }))
      .perform();
    expect(result).toBe("http://host:8080");
  });

  it("is lazy — nothing runs until the chain is executed", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    const chain = scope.chain("a", async () => {
      order.push("a");
      return { result: 0, inverse: () => {} };
    });
    expect(order).toEqual([]);
    await chain.perform();
    expect(order).toEqual(["a"]);
  });

  it("unwinds only the frame that failed", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    await scope
      .chain("created", async () => ({ result: 0, inverse: () => order.push("~created") }))
      .perform();
    scope.openFrame("init");
    await scope
      .chain("inited", async () => ({ result: 0, inverse: () => order.push("~inited") }))
      .perform();
    await scope.unwindFrame();
    // What create() did survives an init that failed — the retry has to start
    // from a constructed resource, not a reverted one.
    expect(order).toEqual(["~inited"]);
    await scope.unwindAll();
    expect(order).toEqual(["~inited", "~created"]);
  });

  it("keeps the inverses of completed steps when a later step throws", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    await expect(
      scope
        .chain("one", async () => {
          order.push("one");
          return { result: 0, inverse: () => order.push("~one") };
        })
        .effect("two", async () => {
          throw new Error("step two failed");
        })
        .perform(),
    ).rejects.toThrow("step two failed");
    await scope.unwindFrame();
    expect(order).toEqual(["one", "~one"]);
  });

  it("registers one inverse per completed step of a generator body", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    await expect(
      scope
        .chain("steps", async function* () {
          order.push("one");
          yield () => order.push("~one");
          order.push("two");
          throw new Error("failed between steps");
        })
        .perform(),
    ).rejects.toThrow("failed between steps");
    await scope.unwindFrame();
    // Only step one yielded, so only step one is undone: step two's allocation
    // never completed and has nothing to revert.
    expect(order).toEqual(["one", "two", "~one"]);
  });

  it("disposes an effect early, out of order, and skips it when the frame unwinds", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    const first = await scope
      .chain("first", async () => ({ result: 0, inverse: () => order.push("~first") }))
      .perform();
    await scope
      .chain("second", async () => ({ result: 0, inverse: () => order.push("~second") }))
      .perform();
    await first.dispose();
    await first.dispose(); // idempotent
    expect(order).toEqual(["~first"]);
    await scope.unwindFrame();
    expect(order).toEqual(["~first", "~second"]);
  });

  it("refuses an effect against a scope that has unwound, before the body runs", async () => {
    let bodyRan = false;
    const scope = new EffectScope("test");
    await scope.unwindAll();

    await expect(
      scope
        .chain("late", async () => {
          bodyRan = true;
          return { result: 0, inverse: () => {} };
        })
        .perform(),
    ).rejects.toMatchObject({ code: "ERR_EFFECT_SCOPE_CLOSED" });
    // Refused BEFORE the forward action, so a late effect cannot allocate and
    // then find nowhere to record its inverse.
    expect(bodyRan).toBe(false);
    expect(() => scope.register("late hold", () => {})).toThrow(/torn down/);
  });

  it("reports a refusing inverse rather than swallowing it, and keeps unwinding", async () => {
    const order: string[] = [];
    const scope = new EffectScope("test");
    await scope
      .chain("outer", async () => ({ result: 0, inverse: () => order.push("~outer") }))
      .effect("refuses", async () => ({
        result: 0,
        inverse: () => {
          throw new Error("cannot roll back");
        },
      }))
      .perform();
    const failures = await scope.unwindFrame();
    expect(failures.map((f) => f.reason)).toEqual(["refuses"]);
    expect(order).toEqual(["~outer"]);
  });
});

describe("revertible effects — the resource lifecycle", () => {
  it("recovers a failed init, discards the instance, and retries against a fresh one", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();

    expect(await journalOf(kernel)).toEqual([
      "create",
      "init:1:1",
      "alpha",
      "beta1",
      "beta2",
      // LIFO, and every inverse of the failed attempt runs BEFORE the retry —
      // so the second attempt is not a retry from a dirty state.
      "~beta2",
      "~beta1",
      "~alpha",
      // A second `create`, and its init is attempt 1 of a NEW instance: the
      // object holding half an allocation was discarded, not re-entered.
      "create",
      "init:2:1",
      "alpha",
      "beta1",
      "beta2",
    ]);
  });

  it("unwinds run and init effects at teardown, newest frame first", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    await kernel.runTargets();
    expect(await journalOf(kernel)).toContain("run");

    // Held across teardown: the resource is gone from the context afterwards,
    // while the journal it wrote into is module scope and outlives it.
    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    const journal = ctx.resolveImportedInstance("Fixture", "journal");
    await kernel.teardown();
    const entries = ((await journal.provide()) as { entries: string[] }).entries;
    // The run frame first (gamma), then what init built (beta, alpha) — and the
    // kernel hold `run()` took is released by the same unwind, which is what
    // lets this fixture declare no teardown() at all.
    expect(entries.slice(entries.indexOf("run"))).toEqual([
      "run",
      "~gamma",
      "~beta2",
      "~beta1",
      "~alpha",
    ]);
  });
});
