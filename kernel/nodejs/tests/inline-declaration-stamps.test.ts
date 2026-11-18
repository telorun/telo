import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";

/** A controller's context in the root module `App`, for a resource declared there. */
async function holderContext() {
  const memory = new MemorySource();
  memory.set("app", "kind: Telo.Application\nmetadata:\n  name: App\n");
  const kernel = new Kernel({ sources: [memory] });
  await kernel.load("memory://app");
  const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
  const ctx = (kernel as unknown as {
    createResourceContext(m: ModuleContext, r: unknown): { ensureKindRef(value: unknown, name?: string): unknown };
  }).createResourceContext(root, { kind: "Test.Probe", metadata: { name: "probe", module: "App" } });
  const declared = (name: string) =>
    (root as unknown as { declaredManifests: Map<string, { metadata: Record<string, unknown> }> }).declaredManifests.get(name);
  return { ctx, declared };
}

describe("an inline declaration a controller registers", () => {
  it("is the holder's module's, and refused for a stamp its author wrote", async () => {
    const { ctx, declared } = await holderContext();

    ctx.ensureKindRef({ kind: "Telo.Value", value: 1 }, "plain");
    expect(declared("plain")?.metadata.module).toBe("App");

    expect(() =>
      ctx.ensureKindRef({ kind: "Telo.Value", metadata: { module: "Elsewhere" }, value: 1 }, "forged"),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_METADATA_RESERVED_FIELD",
        message: expect.stringContaining("'metadata.module' is written by the loader"),
      }),
    );
    expect(declared("forged")).toBeUndefined();
  });
});
