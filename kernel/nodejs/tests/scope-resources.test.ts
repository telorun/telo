import { describe, expect, it } from "vitest";
import type { ResourceManifest } from "@telorun/sdk";
import { ModuleContext } from "../src/module-context.js";

/**
 * `ScopeContext.resources` is what a `Run.Sequence`'s steps read
 * `resources.<name>` through inside a `with:` scope. It layers the scope's own
 * resources over the enclosing module's — and the outer half has to stay LIVE,
 * because `setResource` replaces the module's map wholesale on every publish
 * (a post-invoke refresh, a `setStatus()`, a target started later).
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
      instance: { snapshot: () => ({ from: "scope", name: resource.metadata.name }) },
      ctx: {},
    }),
    async () => {},
  );
}

function scopedManifest(name: string): ResourceManifest {
  return { kind: "Test.Scoped", metadata: { name } } as unknown as ResourceManifest;
}

describe("ScopeContext.resources", () => {
  it("sees an outer resource published AFTER the scope opened", async () => {
    const parent = moduleContext();
    parent.setResource("early", { value: 1 });

    let seenDuring: Record<string, unknown> | undefined;
    await parent.createScopeHandle([]).run(async (scope) => {
      // Republishing replaces the module's `_resources` object; a copy taken at
      // scope entry would still be pointing at the old one.
      parent.setResource("late", { value: 2 });
      parent.setResource("early", { value: 99 });
      seenDuring = scope.resources;
    });

    expect(seenDuring).toEqual({ early: { value: 99 }, late: { value: 2 } });
  });

  it("layers a scope-local resource over the outer map, scope-local winning", async () => {
    const parent = moduleContext();
    parent.setResource("shared", { from: "outer" });
    parent.setResource("outerOnly", { from: "outer" });

    let seen: Record<string, unknown> | undefined;
    await parent.createScopeHandle([scopedManifest("shared")]).run(async (scope) => {
      seen = scope.resources;
    });

    // Matches `ScopeContext.getInstance`'s order, so CEL and `!ref` agree.
    expect(seen).toEqual({
      shared: { from: "scope", name: "shared" },
      outerOnly: { from: "outer" },
    });
  });

  it("gives each run its own scope-local overlay, so concurrent runs never cross", async () => {
    const parent = moduleContext();
    const handle = parent.createScopeHandle([scopedManifest("inner")]);

    let releaseFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => (releaseFirst = resolve));

    let firstSeen: Record<string, unknown> | undefined;
    let secondSeen: Record<string, unknown> | undefined;

    await Promise.all([
      handle.run(async (scope) => {
        await firstEntered;
        firstSeen = scope.resources;
      }),
      handle.run(async (scope) => {
        secondSeen = scope.resources;
        releaseFirst();
      }),
    ]);

    // Each run built its own `inner` — neither observed the other's, and
    // neither observed a merged or doubled map.
    expect(firstSeen).toEqual({ inner: { from: "scope", name: "inner" } });
    expect(secondSeen).toEqual({ inner: { from: "scope", name: "inner" } });
  });

  it("does not leak a scoped name into the module's own resources map", async () => {
    const parent = moduleContext();
    await parent.createScopeHandle([scopedManifest("inner")]).run(async () => {});
    expect(parent.resources).not.toHaveProperty("inner");
  });
});
