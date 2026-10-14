import * as path from "path";
import { fileURLToPath } from "url";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { EvaluationContext, publishedPropsForInstance } from "../src/evaluation-context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (file: string) => path.resolve(here, "__fixtures__/provider-status", file);

describe("a Provider reporting observed state from init()", () => {
  it("discards what an init() that deferred reported", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture("telo.yaml"));
    await kernel.boot();
    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    const reading = publishedPropsForInstance(ctx.resourceInstances.get("deferred")?.instance);
    expect(reading).toBeDefined();
    expect(reading).not.toHaveProperty("status");
    await kernel.teardown();
  });

  it("defers a startup read of a producer that has not initialized", () => {
    const ctx = new EvaluationContext("test", {}, async () => null, new Set(), async () => {});
    ctx.registerManifest({ kind: "Self.Endpoint", metadata: { name: "db" } });
    const reader = {
      kind: "Self.Endpoint",
      metadata: { name: "reader" },
      host: makeTaggedSentinel("cel", "resources.db.status.host"),
    };
    expect(() =>
      ctx.deferPendingStartupReads("Self.Endpoint/reader", reader, {
        compile: ["**"],
        runtime: [],
        regions: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "ERR_LOCAL_REF_PENDING" }));
  });

  it("still refuses a report from init() by any other capability", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture("before-start.yaml"));
    await expect(kernel.boot()).rejects.toThrow(/reported observed state before it started/);
  });
});
