import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/execution-zones-app/telo.yaml");

async function bootKernel(tracing: boolean): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  kernel.setTracing(tracing);
  return kernel;
}

function instanceOf(kernel: Kernel, name: string): object {
  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const entry = ctx.resourceInstances.get(name);
  if (!entry?.instance) throw new Error(`resource '${name}' has no instance`);
  return entry.instance as object;
}

/** What the fixture's probes recorded. A Provider, so it is read through
 *  `provide()` rather than dispatched. */
async function observations(kernel: Kernel): Promise<Record<string, any>[]> {
  const reporter = instanceOf(kernel, "reporter") as { provide(): Promise<unknown> };
  const report = (await reporter.provide()) as { observations: Record<string, any>[] };
  return report.observations;
}

/**
 * Every clearing / propagation assertion runs with tracing BOTH on and off.
 * The kernel rebuilds the invocation context in its tracing branches, so a
 * fresh object literal there would drop `zones` under `--debug` and keep it
 * otherwise — a safety property that changes with a debug flag. That is the
 * regression `deriveContext` exists to prevent, and the reason it is not enough
 * to test one mode.
 */
for (const tracing of [false, true]) {
  describe(`execution zones (tracing ${tracing ? "on" : "off"})`, () => {
    it("opens a correlated zone around the body and discharges a matching requirement", async () => {
      const kernel = await bootKernel(tracing);
      const result = await kernel.invoke("ZoneFixture.Batch.batchA", {});
      // The requirer resolved a zone whose correlation payload is the session
      // its own key pointer named.
      expect(result).toEqual({ zone: "ZoneFixture.Batch", correlatedOn: "sessionA" });
      await kernel.teardown();
    });

    it("derives the correlation through a traversing key pointer when the direct field is absent", async () => {
      const kernel = await bootKernel(tracing);
      // `insideB` declares no `session:`; the key's second pointer reads it off
      // the batch it names (`/batch/session`) — the manifest-level
      // transcription of the controller's own `??`.
      const result = await kernel.invoke("ZoneFixture.Batch.batchB", {});
      expect(result).toEqual({ zone: "ZoneFixture.Batch", correlatedOn: "sessionB" });
      await kernel.teardown();
    });

    it("raises ERR_ZONE_REQUIRED when no zone is open, quoting the reason", async () => {
      const kernel = await bootKernel(tracing);
      await expect(kernel.invoke("ZoneFixture.Enqueue.insideA", {})).rejects.toMatchObject({
        code: "ERR_ZONE_REQUIRED",
      });
      await expect(kernel.invoke("ZoneFixture.Enqueue.insideA", {})).rejects.toThrow(
        /losing atomicity/,
      );
      await kernel.teardown();
    });

    it("names the correlation target in the failure, not an opaque id", async () => {
      const kernel = await bootKernel(tracing);
      await expect(kernel.invoke("ZoneFixture.Enqueue.insideA", {})).rejects.toThrow(
        /ZoneFixture\.Session 'sessionA'/,
      );
      await kernel.teardown();
    });

    it("makes the zone ambient for the whole body", async () => {
      const kernel = await bootKernel(tracing);
      const result = await kernel.invoke("ZoneFixture.Batch.batchAroundProbe", {});
      expect(result).toEqual({ zones: ["ZoneFixture.Batch"] });
      await kernel.teardown();
    });

    it("unwinds the zone when the body throws", async () => {
      const kernel = await bootKernel(tracing);
      // `insideA` requires a zone on sessionA; batchB opens one on sessionB, so
      // the body throws. Afterwards nothing is left open.
      await expect(kernel.invoke("ZoneFixture.Batch.batchB", {})).resolves.toBeDefined();
      const after = await kernel.invoke("ZoneFixture.Probe.probe", {});
      expect(after).toEqual({ zones: [] });
      await kernel.teardown();
    });

    it("sheds every zone across ctx.runDetached", async () => {
      const kernel = await bootKernel(tracing);
      await kernel.invoke("ZoneFixture.Batch.batchAroundDetached", {});
      const probes = (await observations(kernel)).filter((o) => o.kind === "probe");
      // The detached probe ran inside a Batch body, yet observed no zone: the
      // detach primitive replaces the ambient context, so clearing needs no
      // zone-specific code.
      expect(probes.at(-1)?.zones).toEqual([]);
      await kernel.teardown();
    });

    it("opens an uncorrelated zone with no correlation payload", async () => {
      const kernel = await bootKernel(tracing);
      const result = await kernel.invoke("ZoneFixture.Ambient.ambientBatch", {});
      expect(result).toEqual({ zones: ["ZoneFixture.Ambient"] });
      const entry = (await observations(kernel)).find((o) => o.kind === "ambient-entry");
      expect(entry?.key).toBeNull();
      await kernel.teardown();
    });

    it("mints an entry whose provider and key are derived, never authored", async () => {
      const kernel = await bootKernel(tracing);
      await kernel.invoke("ZoneFixture.Batch.batchA", {});
      const entry = (await observations(kernel)).find((o) => o.kind === "provider-entry");
      expect(entry).toMatchObject({
        zone: "ZoneFixture.Batch",
        provider: "batchA",
        key: "sessionA",
      });
      await kernel.teardown();
    });
  });
}

describe("execution zones — a correlated zone answers only its own key", () => {
  it("refuses a requirement correlated on a different resource", async () => {
    const kernel = await bootKernel(false);
    // `crossBatch` opens a zone on sessionB around `insideA`, which is
    // correlated on sessionA. Kind matches, correlation does not — so the
    // requirement is NOT discharged. This is the runtime counterpart of the
    // static cross-connection check: a transaction on another connection would
    // not have made the statement transactional, so it must not answer.
    await expect(kernel.invoke("ZoneFixture.Batch.crossBatch", {})).rejects.toMatchObject({
      code: "ERR_ZONE_REQUIRED",
    });
    await kernel.teardown();
  });
});

describe("execution zones — zone attributes", () => {
  it("reports what an open zone declares about its contents, read off the declaring kind", async () => {
    const kernel = await bootKernel(false);
    await kernel.invoke("ZoneFixture.Batch.batchAroundProbe", { label: "attributes" });
    const seen = (await observations(kernel)).find((o) => o.label === "attributes");
    expect(seen!.attributes).toEqual([
      {
        kind: "ZoneFixture.Batch",
        attributes: {
          atomic: "a rollback discards the whole batch, entries included",
          noSuspend: "the batch holds an open handle that cannot outlive this process",
        },
      },
    ]);
    await kernel.teardown();
  });

  it("carries the author's REASON, so a refusal quotes the manifest rather than inventing one", async () => {
    const kernel = await bootKernel(false);
    await kernel.invoke("ZoneFixture.Batch.batchAroundProbe", { label: "reason" });
    const seen = (await observations(kernel)).find((o) => o.label === "reason");
    // This is the whole point of the value being the reason rather than `true`:
    // a `noSuspend` reader has a sentence to print at the refusal.
    expect(seen!.attributes[0].attributes.noSuspend).toMatch(/cannot outlive this process/);
    await kernel.teardown();
  });

  it("reports an empty record for a zone whose slot declares no attributes", async () => {
    const kernel = await bootKernel(false);
    // `Ambient` provides an uncorrelated zone with the bare `true` spelling,
    // which says nothing about its contents.
    await kernel.invoke("ZoneFixture.Ambient.ambientBatch", { label: "bare" });
    const seen = (await observations(kernel)).find((o) => o.label === "bare");
    expect(seen!.attributes).toEqual([{ kind: "ZoneFixture.Ambient", attributes: {} }]);
    await kernel.teardown();
  });

  it("is empty outside every zone", async () => {
    const kernel = await bootKernel(false);
    await kernel.invoke("ZoneFixture.Probe.probe", { label: "unzoned" });
    const seen = (await observations(kernel)).find((o) => o.label === "unzoned");
    expect(seen!.attributes).toEqual([]);
    await kernel.teardown();
  });
});

describe("execution zones — instance identity", () => {
  it("gives every live instance a distinct, stable handle", async () => {
    const kernel = await bootKernel(false);
    const { handleOfInstance } = await import("../src/resource-handle.js");
    const ha = handleOfInstance(instanceOf(kernel, "sessionA"));
    const hb = handleOfInstance(instanceOf(kernel, "sessionB"));
    expect(ha?.id).toBeTruthy();
    expect(ha?.id).not.toBe(hb?.id);
    // Stable across reads: the handle is minted once, at create().
    expect(handleOfInstance(instanceOf(kernel, "sessionA"))?.id).toBe(ha?.id);
    // `ref` carries the declaration site, which is what a diagnostic prints —
    // the id itself is never shown to an author.
    expect(ha?.ref).toEqual({ kind: "ZoneFixture.Session", name: "sessionA" });
    await kernel.teardown();
  });

  it("exposes no reverse handle→instance direction", async () => {
    const mod = await import("../src/resource-handle.js");
    // A handle must not be turnable back into someone else's live instance —
    // that is what keeps the ambient stack from leaking instances across
    // module boundaries.
    expect(Object.keys(mod).sort()).toEqual(["handleOfInstance", "mintResourceHandle"]);
  });
});
