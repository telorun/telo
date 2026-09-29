import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A key one union branch declares a reference slot and a sibling branch a plain
 * value: a value written there reaches the controller untouched — Phase-5
 * substitution and inline extraction leave a scalar at a reference site alone.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/value-alternative/telo.yaml");

function received(kernel: Kernel, name: string): unknown {
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  return (ctx.resourceInstances.get(name).instance as { received: unknown }).received;
}

describe("a value at a reference slot's value alternative", () => {
  it("reaches the controller as written, at a root union and one object down", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    expect(received(kernel, "rootLevel")).toBe("hello");
    expect(received(kernel, "nested")).toBe("hello");
    await kernel.teardown();
  });
});
