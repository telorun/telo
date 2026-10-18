import {
  Loader,
  StaticAnalyzer,
  assembleGraphDiagnostics,
  collectModuleDocuments,
  flattenForAnalyzer,
  locateDiagnostic,
} from "@telorun/analyzer";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeCelHandlers } from "../src/cel-handlers.js";
import { nodeHostVersions } from "../src/host-versions.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { KernelRuntimeSeam } from "../src/runtime-seam.js";
import { defaultTransportRegistry } from "../src/transports/transport-registry.js";

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

  it("returns an unreadable entry as loadError, not a throw", async () => {
    const result = await seamOver(new MemorySource()).check("memory://missing");

    expect(result.loadError).toBeTruthy();
    expect(result.diagnostics).toEqual([]);
  });

  it("returns a failed import as its coded diagnostic at the import's line, with no loadError", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: App
imports:
  Lib: memory://absent
`,
    );

    const result = await seamOver(memory).check("memory://app");

    expect(result.loadError).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "INVALID_IMPORT_SOURCE",
        severity: "error",
        path: "imports.Lib",
        line: 4,
        message: expect.stringContaining("Cannot resolve import 'Lib' → 'memory://absent'"),
      }),
    ]);
  });
});

const FIXTURES = fileURLToPath(new URL("../../../tests/__fixtures__/", import.meta.url));

/** What `telo check` reports for a manifest: the shared assembler over the same
 *  load and analysis, each diagnostic located by the shared rule. */
async function assembled(source: string) {
  const graph = await new Loader(defaultTransportRegistry().sources(), {
    celHandlers: nodeCelHandlers,
  })
    .register(new LocalFileSource())
    .loadGraph(source, { desugarImports: true, migrate: true });
  const analysis = new StaticAnalyzer({ celHandlers: nodeCelHandlers }).analyze(
    flattenForAnalyzer(graph),
    { moduleDocuments: collectModuleDocuments(graph), hostVersions: nodeHostVersions() },
  );
  return assembleGraphDiagnostics(graph, analysis).diagnostics.map((d) => ({
    code: String(d.code),
    message: d.message,
    path: (d.data as { path?: string } | undefined)?.path,
    line: locateDiagnostic(graph, d)?.range.start.line,
  }));
}

describe("RuntimeSeam.check over the import refusals", () => {
  it.each([
    ["check-run-agreement/builtin-vocabulary/telo.yaml", "INVALID_IMPORT_TARGET", "imports.Builtins"],
    ["check-run-agreement/reserved-prefix/telo.yaml", "KIND_PREFIX_RESERVED", "imports.Lib"],
    ["check-run-agreement/reserved-prefix/alias-telo/telo.yaml", "KIND_PREFIX_RESERVED", "imports.Telo"],
    ["imports-an-application.yaml", "INVALID_IMPORT_TARGET", "imports.ForbiddenApp"],
    ["imports-a-non-library.yaml", "INVALID_IMPORT_TARGET", "imports.NonLibrary"],
  ])("answers %s exactly as the shared assembler does", async (fixture, code, path) => {
    const source = pathToFileURL(join(FIXTURES, fixture)).href;

    const result = await new KernelRuntimeSeam(new Kernel({ sources: [new LocalFileSource()], env: {} })).check(source);
    const expected = await assembled(source);

    expect(result.loadError).toBeUndefined();
    expect(expected).toEqual([expect.objectContaining({ code, path, line: 5 })]);
    expect(
      result.diagnostics.map(({ code, message, path, line }) => ({ code, message, path, line })),
    ).toEqual(expected);
  });
});
