import type { LoadedGraph } from "@telorun/analyzer";
import type { RuntimeDiagnostic } from "@telorun/kernel";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, formatAnalysisDiagnostics, formatDiagnostics } from "../src/logger.js";
import { Output, installOutput } from "../src/output.js";

/**
 * `telo run` renders a static failure with the position `telo check` prints, and
 * falls back to naming the resource when nothing locates it — a pointer to the
 * wrong line is worse than no pointer, since it sends the reader elsewhere.
 */
describe("formatDiagnostics", () => {
  const FILE = "file:///app/telo.yaml";

  function graphWith(kind: string, name: string, line: number): LoadedGraph {
    return {
      modules: new Map([
        [
          "app",
          {
            owner: {
              source: FILE,
              requestedUrl: FILE,
              manifests: [{ kind, metadata: { name } }],
              positions: [
                {
                  sourceLine: line,
                  positionIndex: new Map([
                    ["kind", { start: { line, character: 6 }, end: { line, character: 20 } }],
                  ]),
                },
              ],
            },
            partials: [],
          },
        ],
      ]),
    } as unknown as LoadedGraph;
  }

  // Diagnostics go through the `Output` seam. The seam takes its streams as
  // constructor arguments, so this hands it a recorder rather than spying on a
  // process global — the ambient instance is swapped for the duration.
  function captureErr(fn: () => void): string[] {
    const stderr = { isTTY: false, text: "", write(c: string) { this.text += c; return true; } };
    const restore = installOutput(
      new Output({ format: "text", stdout: { write: () => true }, stderr, env: {} }),
    );
    try {
      fn();
    } finally {
      restore();
    }
    return stderr.text.split("\n").slice(0, -1);
  }

  afterEach(() => vi.restoreAllMocks());

  const log = createLogger(false);

  it("leads with file:line:col for a located static failure", () => {
    const d: RuntimeDiagnostic = {
      severity: "error",
      message: "No Telo.Definition found for kind 'Type.JsonSchema'.",
      code: "UNDEFINED_KIND",
      resource: "Type.JsonSchema.nope",
      origin: { filePath: FILE, path: "kind", resource: { kind: "Type.JsonSchema", name: "nope" } },
    };

    const [line] = captureErr(() =>
      formatDiagnostics([d], log, "telo.yaml", graphWith("Type.JsonSchema", "nope", 15)),
    );
    expect(line).toContain("telo.yaml:16:7");
    expect(line).toContain("No Telo.Definition found");
  });

  it("names the resource instead of guessing a line when nothing locates it", () => {
    const d: RuntimeDiagnostic = {
      severity: "error",
      message: "something is wrong",
      code: "UNDEFINED_KIND",
      resource: "Some.Kind.ghost",
      // Neither the resource nor the file appears in the graph.
      origin: { filePath: "file:///elsewhere/telo.yaml", path: "kind" },
    };

    const [line] = captureErr(() =>
      formatDiagnostics([d], log, "telo.yaml", graphWith("Type.JsonSchema", "nope", 15)),
    );
    expect(line).not.toContain(":1:1");
    expect(line).toContain("Some.Kind.ghost: something is wrong");
  });

  it("renders a runtime failure by resource, with no position", () => {
    const d: RuntimeDiagnostic = {
      severity: "error",
      kind: "Http.Server",
      resource: "api",
      message: "listen EADDRINUSE",
    };

    const [line] = captureErr(() => formatDiagnostics([d], log, "telo.yaml"));
    expect(line).toContain("api: listen EADDRINUSE");
    expect(line).not.toContain("telo.yaml:");
  });
});

/**
 * `-o json` on stdout is the machine surface, and the whole point of computing a
 * repair is that a consumer can apply it without re-deriving it from prose. The
 * payload used to carry `message` alone, so everything structured the analyzer
 * knew was dropped exactly where it was most useful.
 */
describe("formatAnalysisDiagnostics — structured payload", () => {
  const FILE = "file:///app/telo.yaml";
  const log = createLogger(false);

  const graph = {
    modules: new Map([
      [
        "app",
        {
          owner: {
            source: FILE,
            requestedUrl: FILE,
            manifests: [{ kind: "Run.Sequence", metadata: { name: "seq" } }],
            positions: [
              {
                sourceLine: 3,
                positionIndex: new Map([
                  ["steps[0].inputs.flag", { start: { line: 9, character: 8 }, end: { line: 9, character: 40 } }],
                ]),
              },
            ],
          },
          partials: [],
        },
      ],
    ]),
  } as unknown as LoadedGraph;

  /** Silences the prose line the formatter also writes. */
  function collect(diagnostics: Parameters<typeof formatAnalysisDiagnostics>[0]) {
    const sink = { isTTY: false, write: () => true };
    const restore = installOutput(
      new Output({ format: "json", stdout: sink, stderr: sink, env: {} }),
    );
    try {
      return formatAnalysisDiagnostics(diagnostics, graph, log, "telo.yaml").diagnostics;
    } finally {
      restore();
    }
  }

  const withFix = {
    severity: 1,
    code: "CEL_WRONG_CALL_FORM",
    source: "telo-analyzer",
    message: "`startsWith` is a method",
    data: {
      resource: { kind: "Run.Sequence", name: "seq" },
      path: "steps[0].inputs.flag",
      fix: { replacement: "key.startsWith('x')", range: { start: 0, end: 22 } },
    },
  };

  it("carries the repair, the resource and the path alongside the message", () => {
    const [d] = collect([withFix] as never);
    expect(d!.fix).toEqual({ replacement: "key.startsWith('x')", range: { start: 0, end: 22 } });
    expect(d!.resource).toBe("Run.Sequence/seq");
    expect(d!.path).toBe("steps[0].inputs.flag");
  });

  it("carries the configurations a diagnostic holds in, and none when it holds in every one", () => {
    const configurations = [{ "variables.dialect": "postgres" }, { "resources.db": "present" }];
    const [some, every] = collect([
      { severity: 1, code: "X", message: "m (when variables.dialect is postgres)", data: { configurations } },
      { severity: 1, code: "X", message: "m" },
    ] as never);
    expect(some!.configurations).toEqual(configurations);
    expect(every).not.toHaveProperty("configurations");
  });

  it("reports an info or hint diagnostic under its own severity", () => {
    const [info, hint] = collect([
      { severity: 3, code: "X", message: "an info" },
      { severity: 4, code: "Y", message: "a hint" },
    ] as never);
    expect(info!.severity).toBe("info");
    expect(hint!.severity).toBe("hint");
  });

  it("omits the fields entirely when a diagnostic has no repair to offer", () => {
    const [d] = collect([{ severity: 1, code: "X", message: "no stamp" }] as never);
    expect(d).not.toHaveProperty("fix");
    expect(d).not.toHaveProperty("resource");
    expect(d).not.toHaveProperty("path");
  });
});

describe("formatAnalysisDiagnostics — a library migration", () => {
  const ENTRY = "/work/app/telo.yaml";
  const LIBRARY = "/work/app/panel/telo.yaml";
  const log = createLogger(false);

  const file = (source: string) => ({
    source,
    requestedUrl: source,
    manifests: [{ kind: "Telo.Library", metadata: { name: "Panel" } }],
    positions: [
      {
        sourceLine: 0,
        positionIndex: new Map([["kind", { start: { line: 6, character: 8 }, end: { line: 6, character: 20 } }]]),
      },
    ],
  });
  const graph = {
    rootSource: ENTRY,
    modules: new Map([
      [ENTRY, { owner: file(ENTRY), partials: [] }],
      [LIBRARY, { owner: file(LIBRARY), partials: [] }],
    ]),
  } as unknown as LoadedGraph;

  const fired = (filePath: string) => ({
    severity: 3,
    code: "UI_DATA_REPLACED",
    message: "A read is a query.",
    data: {
      filePath,
      resource: { kind: "Telo.Library", name: "Panel" },
      path: "kind",
      libraryMigration: { module: "ui", source: "oci://ghcr.io/telorun/ui@0.16.0", modulePath: filePath },
    },
  });

  it("names the library and the command that applies it, the code on a line of its own", () => {
    const lines: string[] = [];
    const sink = { isTTY: false, write: (chunk: string) => (lines.push(chunk), true) };
    const restore = installOutput(new Output({ format: "text", stdout: sink, stderr: sink, env: {} }));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/work/app");
    try {
      formatAnalysisDiagnostics([fired(ENTRY), fired(LIBRARY)] as never, graph, log, ENTRY);
    } finally {
      cwd.mockRestore();
      restore();
    }
    expect(lines.join("").split("\n").slice(0, -1)).toEqual([
      "telo.yaml:7:9  info  A read is a query.",
      "declared by ui (oci://ghcr.io/telorun/ui@0.16.0)",
      "run `telo migrate telo.yaml` to apply",
      "UI_DATA_REPLACED",
      `${join("panel", "telo.yaml")}:7:9  info  A read is a query.`,
      "declared by ui (oci://ghcr.io/telorun/ui@0.16.0)",
      "run `telo migrate panel` to apply",
      "UI_DATA_REPLACED",
    ]);
  });
});
