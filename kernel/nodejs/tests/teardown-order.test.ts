import * as path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/teardown-order-app/telo.yaml");

/**
 * Boot the fixture, tear it down, and return what THIS boot recorded.
 *
 * The journal instance is captured BEFORE teardown: the resource is gone from
 * the context afterwards, while the module-scope array it reads outlives it —
 * which is also why the result is sliced from a baseline. The fixture's bundle
 * is content-addressed, so every kernel in this file shares one module scope and
 * one journal, and entries accumulate across tests.
 */
async function teardownJournal(): Promise<string[]> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const journal = ctx.resolveImportedInstance("Fixture", "journal");
  const entries = async (): Promise<string[]> =>
    ((await journal.provide()) as { entries: string[] }).entries;
  const baseline = (await entries()).length;
  await kernel.teardown();
  return (await entries()).slice(baseline);
}

/** Boot and hand back the live root context plus a reader over the journal, for
 *  the tests that unwind PART of a running app and leave the rest up. */
async function running(): Promise<{
  kernel: Kernel;
  ctx: any;
  inverses: () => Promise<string[]>;
}> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const journal = ctx.resolveImportedInstance("Fixture", "journal");
  const all = async (): Promise<string[]> =>
    ((await journal.provide()) as { entries: string[] }).entries;
  // The journal is module scope in the fixture's bundle, and the bundle is
  // content-addressed — so every kernel in this file shares one, and entries
  // accumulate across tests. Each test reads only what its own boot added.
  const baseline = (await all()).length;
  const inverses = async (): Promise<string[]> =>
    (await all()).slice(baseline).filter((e) => e.startsWith("~"));
  return { kernel, ctx, inverses };
}

describe("partial unwind — reconciliation's half of teardown", () => {
  it("unwinds only what is named and leaves the rest running", async () => {
    const { kernel, ctx, inverses } = await running();
    expect(await inverses()).toEqual([]);

    await ctx.unwindResources(new Set(["localConsumer", "localProvider"]));

    // `consumer` and the library's `provider` are untouched: nothing in the
    // selection holds them and they hold nothing in it.
    expect(await inverses()).toEqual(["~localConsumer", "~localProvider"]);
    await kernel.teardown();
  });

  it("unwinds the selection in the order the edges give, not the order asked for", async () => {
    const { kernel, ctx, inverses } = await running();
    // Asked provider-first; the holder still has to go first.
    await ctx.unwindResources(new Set(["localProvider", "localConsumer"]));
    expect(await inverses()).toEqual(["~localConsumer", "~localProvider"]);
    await kernel.teardown();
  });

  it("takes its selection from impactedBy, which pulls the holder in", async () => {
    const { kernel, ctx, inverses } = await running();

    // Rebuilding `localProvider` invalidates `localConsumer`, which is holding
    // the instance — so the closure is what makes the unwind safe.
    const { impacted } = ctx.impactedBy(["localProvider"]);
    expect([...impacted].sort()).toEqual(["localConsumer", "localProvider"]);

    await ctx.unwindResources(impacted);
    expect(await inverses()).toEqual(["~localConsumer", "~localProvider"]);
    await kernel.teardown();
  });

  it("skips a name with no live instance rather than failing", async () => {
    const { kernel, ctx, inverses } = await running();
    await ctx.unwindResources(new Set(["localConsumer", "neverDeclared"]));
    expect(await inverses()).toEqual(["~localConsumer"]);
    await kernel.teardown();
  });
});

describe("teardown order — a consumer unwinds before what it holds", () => {
  let entries: string[];
  beforeAll(async () => {
    entries = await teardownJournal();
  });

  it("runs every node's inverse", () => {
    // Guards the two orderings below: `indexOf` on a label that never ran
    // returns -1, which compares as "earlier" against anything present.
    expect(entries).toEqual(
      expect.arrayContaining(["~consumer", "~provider", "~localConsumer", "~localProvider"]),
    );
  });

  it("unwinds a consumer before the imported library resource it holds", () => {
    // The regression this locks: the child-context cascade used to run BEFORE
    // this context's own resources, so every imported library was torn down
    // first and `consumer` unwound against a provider already gone. An import's
    // own inverse tears its child context down, so the import's position in the
    // owning context's order is the library's position.
    expect(entries.indexOf("~consumer")).toBeLessThan(entries.indexOf("~provider"));
  });

  it("unwinds a consumer before a sibling it holds in the same context", () => {
    // Reverse insertion already gets this right on its own, because the init
    // loop defers a resource whose refs are unresolved and so cannot insert a
    // consumer before its provider. What the edge-driven order adds is the
    // guarantee: it holds for an edge that never passes through Phase-5
    // injection, where insertion order says nothing.
    expect(entries.indexOf("~localConsumer")).toBeLessThan(entries.indexOf("~localProvider"));
  });
});
