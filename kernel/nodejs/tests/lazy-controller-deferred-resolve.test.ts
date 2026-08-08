import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/**
 * Controller resolution is deferred to a kind's first instantiation, matching
 * the Rust kernel: a Telo.Definition whose candidate list nothing in this
 * environment can host registers fine, and errors — naming the kind — only when
 * a resource of it is declared. This is what lets both kernels load a
 * partially-covered module (e.g. console's stream kinds under the Rust kernel)
 * instead of rejecting it over kinds nobody uses.
 */

// `pkg:telo/local/napi` is a format the Node bundle loader cannot host, so the
// single candidate is env-missing and total resolution fails — but only when
// resolution actually runs.
const UNHOSTABLE_LIB = `kind: Telo.Library
metadata:
  name: NapiLib
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Thing
  description: A kind whose only controller candidate this kernel cannot host.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/napi?path=./thing.node
schema:
  type: object
  additionalProperties: false
`;

function memoryWith(app: string): MemorySource {
  const memory = new MemorySource();
  memory.set("napi-lib", UNHOSTABLE_LIB);
  memory.set("app", app);
  return memory;
}

describe("lazy controller resolution deferral", () => {
  it("loads a module whose kind has no hostable controller when nothing instantiates it", async () => {
    const memory = memoryWith(
      `kind: Telo.Application
metadata:
  name: DeferredApp
  version: 1.0.0
imports:
  Napi: memory://napi-lib
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
  });

  it("errors naming the kind on first instantiation", async () => {
    const memory = memoryWith(
      `kind: Telo.Application
metadata:
  name: DeferredApp
  version: 1.0.0
imports:
  Napi: memory://napi-lib
---
kind: Napi.Thing
metadata:
  name: thing
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    await expect(
      kernel.load("memory://app").then(() => kernel.start()),
    ).rejects.toThrow(/kind 'NapiLib\.Thing'/);
  });
});
