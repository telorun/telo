import type { ResourceInstance, ResourceManifest, RuntimeDiagnostic } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { ModuleContext } from "../src/module-context.js";

/**
 * End-to-end over the multi-pass init loop: what a real failing manifest throws.
 * The controllers are stand-ins, but everything between registering a manifest
 * and the aggregate `ERR_RESOURCE_INITIALIZATION_FAILED` is the production path
 * — dependency capture at create(), retry until no progress, classification.
 */

/** A resource whose `init()` throws whatever its manifest's `failWith` says. */
function moduleContext(): ModuleContext {
  return new ModuleContext(
    "test",
    {},
    {},
    {},
    [],
    async (_ctx, resource) => {
      const manifest = resource as unknown as Record<string, any>;
      const instance: ResourceInstance = {
        snapshot: async () => ({}),
        init: async () => {
          if (manifest.failWith) throw manifest.failWith();
        },
      };
      return { resource, instance, ctx: {} };
    },
    async () => {},
  );
}

/** A ref in the shape Phase 2.5 leaves behind — what `collectResourceRefs` reads. */
const ref = (name: string) => ({ kind: "Test.Thing", name });

function manifest(name: string, config: Record<string, unknown> = {}): ResourceManifest {
  return { kind: "Test.Thing", metadata: { name }, ...config } as unknown as ResourceManifest;
}

async function initFailure(manifests: ResourceManifest[]): Promise<RuntimeError> {
  const ctx = moduleContext();
  for (const m of manifests) ctx.registerManifest(m);
  try {
    await ctx.initializeResources();
  } catch (err) {
    return err as RuntimeError;
  }
  throw new Error("expected initializeResources to fail");
}

const byName = (diagnostics: RuntimeDiagnostic[], name: string) =>
  diagnostics.find((d) => d.resource === name);

describe("init loop — what a failed initialization reports", () => {
  it("names the one root cause and collapses the chain hanging off it", async () => {
    const err = await initFailure([
      manifest("Db", { failWith: () => new Error("connect ECONNREFUSED 127.0.0.1:5432") }),
      manifest("Store", {
        connection: ref("Db"),
        failWith: () => new RuntimeError("ERR_LOCAL_REF_PENDING", "not initialized yet"),
      }),
      manifest("Work", {
        store: ref("Store"),
        failWith: () => new RuntimeError("ERR_LOCAL_REF_PENDING", "not initialized yet"),
      }),
    ]);

    expect(err.code).toBe("ERR_RESOURCE_INITIALIZATION_FAILED");
    const diagnostics = err.diagnostics!;
    expect(diagnostics).toHaveLength(3);
    expect(byName(diagnostics, "Db")?.message).toBe("connect ECONNREFUSED 127.0.0.1:5432");
    expect(byName(diagnostics, "Db")?.derived).toBeUndefined();
    // Both are attributed to the ROOT of the chain, not the nearest blocker.
    expect(byName(diagnostics, "Store")).toMatchObject({ derived: true, blockedBy: "Db" });
    expect(byName(diagnostics, "Work")).toMatchObject({ derived: true, blockedBy: "Db" });

    // The root leads the message; the chain is one line, not two.
    const lines = err.message.split("\n");
    expect(lines[0]).toBe("3 resources failed to initialize (1 root cause, rest blocked):");
    expect(lines[1]).toContain("connect ECONNREFUSED");
    expect(lines.filter((l) => l.includes("blocked by Db"))).toHaveLength(1);
  });

  it("still reports a dependent that failed for a reason of its own", async () => {
    // Api references the failed Db AND fails its own validation. Collapsing it
    // would hide a second, unrelated error until the next run.
    const err = await initFailure([
      manifest("Db", { failWith: () => new Error("connect ECONNREFUSED") }),
      manifest("Api", {
        connection: ref("Db"),
        failWith: () =>
          new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", "/port must be integer"),
      }),
    ]);

    expect(byName(err.diagnostics!, "Api")?.derived).toBeUndefined();
    expect(err.message).toContain("/port must be integer");
    expect(err.message).toContain("2 resources failed to initialize");
  });

  it("attaches a nested context's diagnostics as children instead of flattening them", async () => {
    // What a Telo.Import does: its init() runs the child context's own loop.
    const child = await initFailure([
      manifest("Db", { failWith: () => new Error("connect ECONNREFUSED") }),
      manifest("Store", {
        connection: ref("Db"),
        failWith: () => new RuntimeError("ERR_LOCAL_REF_PENDING", "not initialized yet"),
      }),
    ]);
    const err = await initFailure([manifest("Lib", { failWith: () => child })]);

    const wrapper = byName(err.diagnostics!, "Lib")!;
    expect(wrapper.code).toBe("ERR_RESOURCE_INITIALIZATION_FAILED");
    expect(wrapper.message).toBe("2 resources failed to initialize (1 root cause, rest blocked)");
    expect(wrapper.children?.map((c) => c.resource)).toEqual(["Db", "Store"]);
    // The child's own classification survives the boundary.
    expect(wrapper.children?.find((c) => c.resource === "Store")).toMatchObject({
      derived: true,
      blockedBy: "Db",
    });
  });
});
