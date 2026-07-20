import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

function analyze(manifests: unknown[]) {
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests as ResourceManifest[]));
}

/**
 * `telo check` catches the two `logging:` mistakes `kernel/specs/logging.md`
 * calls statically detectable — §14.1 (redaction paths) and §10.3 (`on_full:
 * block`) — so they fail before boot rather than at runtime.
 */
describe("validateLogging", () => {
  it("flags an invalid redaction path on the root logging block", () => {
    const diagnostics = analyze([
      {
        kind: "Telo.Application",
        metadata: { name: "app", module: "app" },
        logging: { redact: { paths: ["a[b-c]"] } },
      },
    ]).filter((d) => d.code === "INVALID_REDACTION_PATH");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/Invalid redaction path/);
    expect((diagnostics[0].data as { path?: string }).path).toBe("logging.redact.paths[0]");
  });

  it("flags an invalid redaction path on a per-import override", () => {
    const diagnostics = analyze([
      {
        kind: "Telo.Application",
        metadata: { name: "app", module: "app" },
        imports: { Db: { source: "./db", logging: { redact: { paths: ["ok.path", "bad["] } } } },
      },
    ]).filter((d) => d.code === "INVALID_REDACTION_PATH");

    expect(diagnostics).toHaveLength(1);
    expect((diagnostics[0].data as { path?: string }).path).toBe("imports.Db.logging.redact.paths[1]");
  });

  it("accepts a valid multi-wildcard path", () => {
    const diagnostics = analyze([
      {
        kind: "Telo.Application",
        metadata: { name: "app", module: "app" },
        logging: { redact: { paths: ["items[*].tokens[*].value", 'a["b-c"].d'] } },
      },
    ]).filter((d) => d.code === "INVALID_REDACTION_PATH");

    expect(diagnostics).toHaveLength(0);
  });

  it("flags on_full: block on an inline sink", () => {
    const diagnostics = analyze([
      {
        kind: "Telo.Application",
        metadata: { name: "app", module: "app" },
        logging: {
          sinks: [{ kind: "Telo.FileSink", destination: "/tmp/x.jsonl", on_full: "block" }],
        },
      },
    ]).filter((d) => d.code === "LOG_SINK_ON_FULL_UNSUPPORTED");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/on_full: block is not supported/);
  });

  it("accepts drop_new and drop_old", () => {
    const diagnostics = analyze([
      {
        kind: "Telo.Application",
        metadata: { name: "app", module: "app" },
        logging: {
          sinks: [
            { kind: "Telo.FileSink", destination: "/a.jsonl", on_full: "drop_new" },
            { kind: "Telo.FileSink", destination: "/b.jsonl", on_full: "drop_old" },
          ],
        },
      },
    ]).filter((d) => d.code === "LOG_SINK_ON_FULL_UNSUPPORTED");

    expect(diagnostics).toHaveLength(0);
  });
});
