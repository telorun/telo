import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A kind that forwards its configuration hands its own accessor fields on as
 * written, so the kind reading the field is the one that makes the binding.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe("an accessor field a template forwards", () => {
  it("reaches the entry as the chain and is bound there", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(path.resolve(here, "__fixtures__/forwarded-accessor/telo.yaml"));
    await kernel.boot();
    const root = (kernel as unknown as { rootContext: any }).rootContext;
    expect(await root.resourceInstances.get("labelled").instance.provide()).toEqual({
      value: { root: "row", path: ["name"] },
    });
    await kernel.teardown();
  });
});
