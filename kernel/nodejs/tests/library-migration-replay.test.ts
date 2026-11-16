import { AnalysisRegistry, Loader, registerLoadedGraph } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { withLibraryMigrations } from "../src/library-migration-replay.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const SHOP = `kind: Telo.Library
metadata: { name: Shop }
lang: en
migrations:
  SHOP_LABEL_RENAMED:
    reason: A box names what it holds as its value.
    rules:
      - rewrite: Self.Box
        match: { type: object, required: [label] }
        move: { /label: /value }
---
kind: Telo.Definition
metadata: { name: Box }
extends: Telo.Value
`;

const APP = `kind: Telo.Application
metadata: { name: Store }
lang: en
imports: { S: memory://shop }
targets: []
---
kind: S.Box
metadata: { name: box }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { who: { type: string } } }
label: !cel "'hello ' + inputs.who"
`;

function sources(app = APP): MemorySource {
  const memory = new MemorySource();
  memory.set("shop", SHOP);
  memory.set("app", app);
  return memory;
}

describe("library migrations replayed at load", () => {
  it("boots the migrated tree, a moved expression evaluated at its destination", async () => {
    const kernel = new Kernel({ sources: [sources()], env: {} });
    await kernel.load("memory://app");
    await kernel.boot();

    expect(await kernel.invoke("Shop.Box.box", { who: "ada" })).toBe("hello ada");

    // The Loader's own compiled file is untouched: another graph it serves reads
    // the tree as written.
    const loader = (kernel as unknown as { loader: Loader }).loader;
    const cached = await loader.loadModule("memory://app", { compile: true, desugarImports: true, migrate: true });
    const box = cached.owner.manifests.find((m) => m?.metadata?.name === "box") as Record<string, unknown>;
    expect(Object.keys(box)).toContain("label");
    expect(Object.keys(box)).not.toContain("value");
    await kernel.teardown();
  });

  it("refuses a record whose file changed after the analysis load", async () => {
    const memory = sources();
    const loader = new Loader([memory]);
    const graph = await loader.loadGraph("memory://app", { desugarImports: true, migrate: true });
    registerLoadedGraph(graph, new AnalysisRegistry());
    const record = graph.libraryMigrations?.records.get(graph.rootSource);
    expect(record).toBeDefined();

    memory.set("app", APP.replace("hello", "hi"));
    loader.forget(graph.rootSource);
    const compiled = await loader.loadModule("memory://app", { compile: true, desugarImports: true, migrate: true });

    let failure: unknown;
    try {
      withLibraryMigrations(compiled, record);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).message).toContain(`${graph.rootSource} changed after the load analyzed it`);
  });
});
