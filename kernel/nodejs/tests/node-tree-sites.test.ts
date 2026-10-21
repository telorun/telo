import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * The sites a kind's schema reaches through a recursive named shape are the
 * sites `telo check` reads: an accessor at every depth is delivered as a
 * binding, and each expression beside one is evaluated at creation.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe("eval sites inside a recursive named shape", () => {
  it("delivers every accessor as a binding and evaluates what sits beside it", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(path.resolve(here, "__fixtures__/node-tree-sites/telo.yaml"));
    await kernel.boot();
    const root = (kernel as unknown as { rootContext: any }).rootContext;
    expect(await root.resourceInstances.get("card").instance.provide()).toEqual({
      text: "ab",
      at: { root: "row", path: ["x"] },
      children: [{ text: "2", at: { root: "row", path: ["y"] } }],
    });
    await kernel.teardown();
  });
});
