import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const APP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/check-run-agreement/abstract-extends-chain/app.yaml",
);

describe("an abstract extending an abstract of another module", () => {
  it("registers its ancestors folded in its own scope, so a child two modules away accepts an inherited field", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await expect(kernel.boot()).resolves.not.toThrow();
    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    expect(ctx.resourceInstances.get("leaf")?.instance).toBeDefined();
    await kernel.teardown();
  });
});
