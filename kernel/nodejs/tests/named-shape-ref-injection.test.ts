import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A reference slot a kind's schema reaches through a recursive named shape is a
 * Phase-5 injection site at every depth, as `telo check` reads it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe("references inside a recursive named shape", () => {
  it("injects the live instance at every depth", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(path.resolve(here, "__fixtures__/named-shape-ref-injection/telo.yaml"));
    await kernel.boot();
    const root = (kernel as unknown as { rootContext: any }).rootContext;
    expect(await root.resourceInstances.get("tree").instance.provide()).toEqual([
      { type: "ref", live: true },
      { type: "box", children: [{ type: "box", children: [{ type: "ref", live: true }] }] },
    ]);
    await kernel.teardown();
  });
});
