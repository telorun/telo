import { getRefIdentity } from "@telorun/sdk";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/dotted-key-inline/telo.yaml");

describe("an inline declaration at a property name holding a dot", () => {
  it("is created, injected at that key and identified by its pointer", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()] });
    await kernel.load(APP);
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
    }
    // Builds the real `ui` and `font` controllers from source on a cold cache.
  }, { timeout: 60_000 });
});
