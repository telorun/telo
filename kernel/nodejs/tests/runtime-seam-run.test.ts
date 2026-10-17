import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { classifyInitFailures, summarizeInitFailures } from "../src/init-failure-diagnostics.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { KernelRuntimeSeam, refusedRunText } from "../src/runtime-seam.js";

async function refusedStderr(memory: MemorySource): Promise<string[]> {
  const seam = new KernelRuntimeSeam(new Kernel({ sources: [memory], env: {} }));
  const run = await seam.run("memory://app");
  let text = "";
  for await (const chunk of run.stderr) text += chunk;
  expect(await run.exitCode).not.toBe(0);
  return text.split("\n");
}

describe("RuntimeSeam.run — what a refused child writes to stderr", () => {
  it("writes the headline, then each analysis diagnostic as [<CODE>] <message>", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: RefusedApp
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Thing
capability: Telo.Invokable
`,
    );

    expect(await refusedStderr(memory)).toEqual([
      "Manifest validation failed",
      "  [CAPABILITY_UNKNOWN] Telo.Definition 'Thing': 'Telo.Invokable' is not a capability. Did you mean 'Telo.Invocable'? A capability names a lifecycle role — one of: Telo.Callable, Telo.Invocable, Telo.Mount, Telo.Provider, Telo.Runnable, Telo.Service, Telo.Sink, Telo.Type.",
      "",
    ]);
  });

  it("writes an import's nested root cause one level further in", async () => {
    const memory = new MemorySource();
    memory.set(
      "lib",
      `kind: Telo.Library
metadata:
  name: Lib
  version: 1.0.0
exports:
  resources: [thing]
---
kind: Telo.Definition
metadata:
  name: Thing
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./missing.mjs#Thing
---
kind: Self.Thing
metadata:
  name: thing
`,
    );
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: ImportingApp
  version: 1.0.0
imports:
  Lib: memory://lib
`,
    );

    const lines = await refusedStderr(memory);

    expect(lines[0]).toBe("1 resource failed to initialize:");
    const carried = lines.indexOf("  [ERR_RESOURCE_INITIALIZATION_FAILED] 1 resource failed to initialize");
    expect(carried).toBeGreaterThan(0);
    expect(lines[carried + 1]).toMatch(
      /^ {4}\[ERR_CONTROLLER_NOT_FOUND\] RuntimeError: kind 'Lib\.Thing': No controller resolved/,
    );
  });

  it("leaves derived entries out", () => {
    const diagnostics = classifyInitFailures([
      { resource: "db", message: "connect ECONNREFUSED", details: "host: db.internal", deps: [] },
      { resource: "store", message: "not initialized yet", code: "ERR_LOCAL_REF_PENDING", deps: ["db"] },
    ]);
    const err = new RuntimeError(
      "ERR_RESOURCE_INITIALIZATION_FAILED",
      summarizeInitFailures(diagnostics),
      diagnostics,
    );

    expect(refusedRunText(err)).toBe(
      "2 resources failed to initialize (1 root cause, rest blocked)\n" +
        "  connect ECONNREFUSED\n" +
        "    host: db.internal\n",
    );
  });
});
