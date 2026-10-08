import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A template body's bare `self.<path>` may continue past a reference slot: where
 * the referenced instance has no such member, the path continues in what that
 * resource was declared with.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "__fixtures__/template-forward/across-reference/telo.yaml");

describe("a template forward that continues past a reference", () => {
  it("reads the data the referenced resource was declared with", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture);
    await kernel.boot();
    try {
      expect(await kernel.invoke("Lib.Label.label", {})).toBe("shelf");
    } finally {
      await kernel.teardown();
    }
  });

  it("hands on a reference that resource holds, as the live instance", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture);
    await kernel.boot();
    try {
      const held = (await kernel.invoke("Lib.Entry.entry", {})) as { invoke(inputs: unknown): Promise<unknown> };
      expect(await held.invoke({})).toBe("hello");
    } finally {
      await kernel.teardown();
    }
  });
});
