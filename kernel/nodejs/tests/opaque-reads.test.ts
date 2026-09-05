import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { ModuleContext } from "../src/module-context.js";

/**
 * A context whose resources exist as soon as they are registered, so a test can
 * drive `getInstance` without running the init loop.
 */
function moduleContext(): ModuleContext {
  return new ModuleContext(
    "test",
    {},
    {},
    {},
    [],
    async (_ctx, resource) => ({
      resource,
      instance: { snapshot: () => ({}) },
      ctx: {},
    }),
    async () => {},
  );
}

const manifest = (name: string): ResourceManifest =>
  ({ kind: "Test.Thing", metadata: { name } }) as unknown as ResourceManifest;

async function withResources(...names: string[]): Promise<ModuleContext> {
  const ctx = moduleContext();
  for (const name of names) ctx.registerManifest(manifest(name));
  await ctx.initializeResources();
  return ctx;
}

describe("by-name resolution is recorded while a module is initializing", () => {
  it("records a read taken before initialization finished", async () => {
    const ctx = await withResources("store");
    // Back to the state a controller's own `init()` runs in.
    ctx.reopenForInitialization();
    ctx.getInstance("store");

    expect([...ctx.opaqueReads()]).toEqual(["store"]);
  });

  it("does not record a read taken after initialization", async () => {
    const ctx = await withResources("store");
    expect(ctx.state).toBe("Initialized");
    ctx.getInstance("store");

    // Nothing to hold: a dispatch-time resolution resolves again next time, so
    // rebuilding the target underneath it is safe.
    expect([...ctx.opaqueReads()]).toEqual([]);
  });

  it("never records a lookup that names its declared ref", async () => {
    const ctx = await withResources("store");
    ctx.reopenForInitialization();
    ctx.getInstance("store", { kind: "Test.Thing", name: "store" });

    // The name came out of a ref slot, so the edge is in the manifest already.
    expect([...ctx.opaqueReads()]).toEqual([]);
  });

  it("records a name whose resolution deferred, since the caller will retry", async () => {
    const ctx = moduleContext();
    ctx.registerManifest(manifest("store"));
    // Registered, not yet initialized — the deferral the init loop retries on.
    expect(() => ctx.getInstance("store")).toThrowError(/not initialized yet/);
    expect([...ctx.opaqueReads()]).toEqual(["store"]);
  });
});

describe("impactedBy reports what it cannot cover", () => {
  it("stays precise when every edge is declared", async () => {
    const ctx = await withResources("db", "unrelated");
    const { impacted, opaque } = ctx.impactedBy(["db"]);
    expect([...impacted]).toEqual(["db"]);
    expect(opaque).toEqual([]);
  });

  it("names the resource held through a by-name resolution", async () => {
    const ctx = await withResources("db", "unrelated");
    ctx.reopenForInitialization();
    ctx.getInstance("db");
    ctx.closeInitialization();

    // The set is NOT expanded to every resource: the holders are unknown, so
    // there is no closure to report. The caller escalates and can say why.
    const { impacted, opaque } = ctx.impactedBy(["db"]);
    expect([...impacted]).toEqual(["db"]);
    expect(opaque).toEqual(["db"]);
  });

  it("says nothing when the by-name read is outside the closure", async () => {
    const ctx = await withResources("db", "cache", "unrelated");
    ctx.reopenForInitialization();
    ctx.getInstance("cache");
    ctx.closeInitialization();

    expect(ctx.impactedBy(["db"]).opaque).toEqual([]);
  });
});
