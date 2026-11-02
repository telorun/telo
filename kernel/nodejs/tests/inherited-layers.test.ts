import * as path from "path";
import { fileURLToPath } from "url";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * An inheriting kind's `inputs:` / `result:` layers are resolved before its
 * controller creates the instance, and a declaration-read reference (`use:
 * schema`) never holds the creation back.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = path.resolve(here, "__fixtures__/inherited-layers/telo.yaml");
const creates = () => (globalThis as any).inheritedLayersCreates as Record<string, number>;

async function loaded(): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(manifest);
  return kernel;
}

describe("an inheriting kind's creation", () => {
  it("defers on its layers before the controller creates anything", async () => {
    const kernel = await loaded();
    (kernel as any).inheritedLayers = () => {
      throw new RuntimeError("ERR_LOCAL_REF_PENDING", "layers not resolvable yet");
    };
    await expect(kernel.boot()).rejects.toThrow();
    expect(creates().merged).toBeUndefined();
    await kernel.teardown();
  });

  it("creates a resource whose declaration-read reference names a shape declared later", async () => {
    const kernel = await loaded();
    await kernel.boot();
    expect(creates()).toMatchObject({ merged: 1, mapped: 1 });
    await kernel.teardown();
  });
});
