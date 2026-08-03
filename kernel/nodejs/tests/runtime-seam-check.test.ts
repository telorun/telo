import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { KernelRuntimeSeam } from "../src/runtime-seam.js";

function seamOver(memory: MemorySource): KernelRuntimeSeam {
  return new KernelRuntimeSeam(new Kernel({ sources: [memory], env: {} }));
}

/** A diamond where `app` imports shared directly and through `sub`, at two
 *  versions — the shape `load()` reconciles, here to pin what `check()` reports
 *  about it.
 *
 *  Both edges must address the same versioned ref base: reconciliation groups by
 *  `refIdentity` (the ref with its version stripped), not by what a module
 *  declares its name to be, so two differently-named sources would be two
 *  groups and never a skew. */
function diamond(memory: MemorySource, high: string, low: string): void {
  memory.set(`shared@${high}`, `kind: Telo.Library\nmetadata:\n  name: shared\n  version: ${high}\n`);
  memory.set(`shared@${low}`, `kind: Telo.Library\nmetadata:\n  name: shared\n  version: ${low}\n`);
  memory.set(
    "sub",
    `kind: Telo.Library
metadata:
  name: sub
  version: 1.0.0
imports:
  SharedLow: memory://shared@${low}
`,
  );
  memory.set(
    "app",
    `kind: Telo.Application
metadata:
  name: DiamondApp
  version: 1.0.0
imports:
  SharedHigh: memory://shared@${high}
  Sub: memory://sub
`,
  );
}

describe("RuntimeSeam.check", () => {
  it("reports a clean manifest as diagnostic-free", async () => {
    const memory = new MemorySource();
    memory.set("app", `kind: Telo.Application\nmetadata:\n  name: CleanApp\n  version: 1.0.0\n`);

    const result = await seamOver(memory).check("memory://app");

    expect(result.loadError).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("reports the parse error instead of analyzing the mangled tree", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: ParseFailApp
  version: 1.0.0
text: "unterminated
`,
    );

    const result = await seamOver(memory).check("memory://app");

    // The unterminated quote swallows the rest of the doc, leaving a tree with a
    // stray `text` key. Analyzing it yields a SCHEMA_VIOLATION that exists only
    // because the parse failed — and the real parse error is absent entirely,
    // since parse findings never reach `analyze()`.
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MANIFEST_PARSE_FAILED"]);
    expect(result.diagnostics[0].severity).toBe("error");
  });

  it("surfaces an incompatible major skew as an error", async () => {
    const memory = new MemorySource();
    diamond(memory, "2.0.0", "1.0.0");

    const result = await seamOver(memory).check("memory://app");

    // `load()` refuses to boot this graph; `check()` must not call it clean.
    const conflict = result.diagnostics.find((d) => d.code === "MODULE_VERSION_CONFLICT");
    expect(conflict?.severity).toBe("error");
  });

  it("keeps analyzer findings alongside the merged loader findings", async () => {
    const memory = new MemorySource();
    diamond(memory, "2.0.0", "1.0.0");
    // A same-major hoist resolves silently, so the conflict case above is the
    // only version diagnostic reachable here; this pins that merging them does
    // not displace what `analyze()` itself found.
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: DiamondApp
  version: 1.0.0
imports:
  SharedHigh: memory://shared@2.0.0
  Sub: memory://sub
targets:
  - !ref NoSuchResource
`,
    );

    const result = await seamOver(memory).check("memory://app");
    const codes = result.diagnostics.map((d) => d.code);

    expect(codes).toContain("MODULE_VERSION_CONFLICT");
    expect(codes.some((c) => c !== "MODULE_VERSION_CONFLICT")).toBe(true);
  });

  it("returns a graph that cannot be loaded as loadError, not a throw", async () => {
    const result = await seamOver(new MemorySource()).check("memory://missing");

    expect(result.loadError).toBeTruthy();
    expect(result.diagnostics).toEqual([]);
  });
});
