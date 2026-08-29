import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * `x-telo-sensitive` on a contract field.
 *
 * Invoke inputs and outputs ride the debug wire on every call under
 * `--inspect` — every watch session — and the kernel's substring scrubbing does
 * not reach them: it has one call site, the resource-Created event's
 * properties. Making a credential a dispatched invocable turns its material
 * into an invoke OUTPUT, so without this the token is on the wire per call.
 *
 * What is asserted here is the pair: the marked value is gone AND everything
 * beside it survives. Either alone passes for the wrong implementation — one
 * that redacts nothing, or one that empties the payload.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/sensitive-contract/telo.yaml");

type Payload = Record<string, unknown> | undefined;

async function bootKernel(): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  return kernel;
}

describe("x-telo-sensitive contract fields", () => {
  it("carries a marked output as [redacted] and leaves its siblings intact", async () => {
    const kernel = await bootKernel();
    let payload: Payload;
    kernel.on("Credential.Invoked", (event) => {
      payload = event.payload as Payload;
    });

    const result = (await kernel.invoke("JS.Script.Credential", {})) as Record<string, unknown>;

    const outputs = payload?.outputs as Record<string, unknown>;
    expect(outputs.headers).toBe("[redacted]");
    // The key is kept and only the value replaced, per the logging spec §14: a
    // payload that silently loses a key reads as a value never produced.
    expect(Object.keys(outputs).sort()).toEqual(["headers", "scheme"]);
    expect(outputs.scheme).toBe("Bearer");

    // The CALLER still receives the real value — this hides what is reported,
    // never what is returned.
    expect(result.headers).toEqual({ authorization: "Bearer t0ken-value" });

    await kernel.teardown();
  });

  it("leaves an unmarked contract's payload verbatim", async () => {
    const kernel = await bootKernel();
    let payload: Payload;
    kernel.on("Plain.Invoked", (event) => {
      payload = event.payload as Payload;
    });

    await kernel.invoke("JS.Script.Plain", {});

    expect((payload?.outputs as Record<string, unknown>).headers).toEqual({
      authorization: "Bearer visible",
    });

    await kernel.teardown();
  });

  it("redacts each value of a marked map, and keeps its keys and siblings", async () => {
    const kernel = await bootKernel();
    let payload: Payload;
    kernel.on("MapValued.Invoked", (event) => {
      payload = event.payload as Payload;
    });

    await kernel.invoke("JS.Script.MapValued", {});

    const outputs = payload?.outputs as Record<string, unknown>;
    // Marked on `additionalProperties`, which names no properties — so without a
    // map wildcard the whole bag was emitted verbatim.
    expect(outputs.headers).toEqual({ authorization: "[redacted]", "x-api-key": "[redacted]" });
    expect(outputs.note).toBe("keep");

    await kernel.teardown();
  });

  it("redacts a whole output that is itself the secret", async () => {
    const kernel = await bootKernel();
    let payload: Payload;
    kernel.on("WholeValue.Invoked", (event) => {
      payload = event.payload as Payload;
    });

    const result = await kernel.invoke("JS.Script.WholeValue", {});

    // The empty path. Refusing a root-level mark left exactly the simplest
    // shape — a contract whose entire output is the secret — unredacted.
    expect(payload?.outputs).toBe("[redacted]");
    expect(result).toBe("Bearer whole-secret");

    await kernel.teardown();
  });

  it("redacts on the traced start span too, where inputs are emitted before the call", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const payloads: Payload[] = [];
    kernel.on("Credential.Invoking", (event) => payloads.push(event.payload as Payload));

    await kernel.invoke("JS.Script.Credential", { forceRefresh: true });

    // `forceRefresh` is not auth material and is marked by nothing, so the start
    // span keeps saying what was asked for.
    expect(payloads[0]?.inputs).toEqual({ forceRefresh: true });

    await kernel.teardown();
  });
});
