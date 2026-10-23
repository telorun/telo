import { getRefIdentity } from "@telorun/sdk";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/dotted-key-inline/telo.yaml");

describe("an inline declaration at a property name holding a dot", () => {
  it("is created, injected at that key and identified by its pointer", async () => {
    // A cache of its own: the workspace cache is shared with every other kernel
    // run in the checkout, and a build there superseding the `ui` or `font`
    // bundle prunes the directory this load imports it from.
    // Its real path: a Windows temp directory under an 8.3 short name
    // (`RUNNER~1`) becomes `%7E` in the file URL an emitted module is
    // imported by, which the test runner's loader cannot resolve.
    const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-dotted-key-")));
    const kernel = new Kernel({ sources: [new LocalFileSource()] });
    await kernel.load(APP, { cacheDir });
    await kernel.boot();
    try {
      const root = (kernel as unknown as { rootContext: any }).rootContext;
      const font = root.resourceInstances.get("brand_font_body")?.instance;
      expect(getRefIdentity(font)).toEqual({
        kind: "Font.Family",
        name: "brand_font_body",
        origin: { module: root.source, pointer: "brand#/font.body" },
      });
      const brand = root.resourceInstances.get("brand")?.instance;
      const provided = await brand.provide();
      expect(provided.tokens).toEqual({ "color.accent": "#1f8fff" });
      expect(provided.fonts["font.body"].family).toBe("Inter");
    } finally {
      await kernel.teardown();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
    // Builds the real `ui` and `font` controllers from source on a cold cache.
  }, { timeout: 60_000 });
});
