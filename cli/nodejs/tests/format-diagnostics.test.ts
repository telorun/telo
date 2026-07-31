import type { LoadedGraph } from "@telorun/analyzer";
import type { RuntimeDiagnostic } from "@telorun/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, formatDiagnostics } from "../src/logger.js";

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

  function captureErr(fn: () => void): string[] {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return lines;
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
