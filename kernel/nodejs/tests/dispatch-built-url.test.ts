import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import type { ModuleContext } from "../src/module-context.js";

/**
 * A `Telo.Url` built when a call is dispatched joins no redaction set — one per call
 * would grow without bound — and a trace payload shows it by the value rule: censored
 * when it holds a password, its text when it holds none, with no mark on the contract.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/dispatch-built-url/telo.yaml");

async function bootKernel(): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  return kernel;
}

describe("a Telo.Url built at dispatch", () => {
  it("leaves the owning context's redaction set as it was across 1,000 distinct arguments", async () => {
    const kernel = await bootKernel();
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const before = [...root.secretValues];

    for (let i = 0; i < 1000; i++) {
      const result = (await kernel.invoke("Run.Sequence.hostOf", {
        url: `postgres://app:pw-${i}@db-${i}.internal/orders`,
      })) as { host: string };
      expect(result.host).toBe(`db-${i}.internal`);
    }

    expect([...root.secretValues]).toEqual(before);
    await kernel.teardown();
  });

  it("is censored in a trace payload when it holds a password, and written as its text when it holds none", async () => {
    const kernel = await bootKernel();
    const payloads: Record<string, unknown>[] = [];
    kernel.on("hostOf.Invoked", (event) => {
      payloads.push(event.payload as Record<string, unknown>);
    });

    await kernel.invoke("Run.Sequence.hostOf", { url: "postgres://app:tr4ce-pw@db.internal/orders" });
    await kernel.invoke("Run.Sequence.hostOf", { url: "postgres://app@db.internal/orders" });
    await kernel.teardown();

    expect(payloads.map((payload) => (payload.inputs as { url: unknown }).url)).toEqual([
      "[redacted]",
      "postgres://app@db.internal/orders",
    ]);
    expect(JSON.stringify(payloads)).not.toContain("tr4ce-pw");
  });
});
