import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/owner-identity/telo.yaml");

/** Capture every payload emitted under a given event name. */
function capture(kernel: Kernel, event: string): Record<string, any>[] {
  const seen: Record<string, any>[] = [];
  kernel.on(event, (e: any) => seen.push(e.payload));
  return seen;
}

describe("owner identity — children spawned by a templated kind", () => {
  it("gives two instances' same-named children distinct ids and owner pointers", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);

    // Both `Lib.Boxed` instances spawn a child literally named `inner`.
    const children = capture(kernel, "Run.Value.inner.Created");
    const alphas = capture(kernel, "Lib.Boxed.alpha.Created");

    await kernel.boot();

    // The two children no longer collide: each carries its owner's prefix.
    const childIds = children.map((p) => p.resource.id).sort();
    expect(childIds).toEqual([
      "Lib.Boxed.alpha/Run.Value.inner",
      "Lib.Boxed.beta/Run.Value.inner",
    ]);

    const byId = new Map(children.map((p) => [p.resource.id, p]));
    expect(byId.get("Lib.Boxed.alpha/Run.Value.inner")?.owner).toMatchObject({
      kind: "Lib.Boxed",
      name: "alpha",
      id: "Lib.Boxed.alpha",
    });
    expect(byId.get("Lib.Boxed.beta/Run.Value.inner")?.owner).toMatchObject({
      kind: "Lib.Boxed",
      name: "beta",
      id: "Lib.Boxed.beta",
    });

    // A top-level resource gets a bare `<kind>.<name>` id and no owner — the
    // anchor a child's prefix resolves against.
    const alpha = alphas[0];
    expect(alpha?.resource.id).toBe("Lib.Boxed.alpha");
    expect(alpha?.owner).toBeUndefined();
    // Its `Created` event carries the resolved config.
    expect(alpha?.properties).toMatchObject({ value: "a" });

    await kernel.teardown();
  });

  it("does not emit a dependency edge for a `{kind,name}` schema example", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);

    // The `Boxed` definition's schema example carries `ref: { kind: Demo.Thing,
    // name: phantom }` — documentation data, not a `!ref`.
    const defs = capture(kernel, "Telo.Definition.Boxed.Created");
    await kernel.boot();

    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      const deps = (d.dependencies ?? []) as { name: string }[];
      expect(deps.some((dep) => dep.name === "phantom")).toBe(false);
    }

    await kernel.teardown();
  });
});
