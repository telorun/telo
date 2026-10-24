import type { ResourceManifest } from "@telorun/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { KERNEL_BUILTINS } from "../src/builtins.js";
import {
  capabilityProblem,
  capabilityRoster,
  declarableCapabilities,
  throwsAllowedCapabilities,
} from "../src/capability-roster.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** The vectors every runtime judging a `capability:` answers identically —
 *  `analyzer/capability-conformance/README.md`. */
const CAPABILITY_VECTORS = JSON.parse(
  readFileSync(new URL("../../capability-conformance/vectors.json", import.meta.url), "utf-8"),
).rows as Array<{
  id: string;
  capability?: unknown;
  extends: boolean;
  code: string | null;
  message: string | null;
}>;

/** The capability roster is the built-in abstracts carrying `declarable`, read
 *  from `sdk/builtins/`; every other answer about a `capability:` value derives
 *  from it. */

describe("the roster", () => {
  it("names the declarable roles, and only those", () => {
    expect(declarableCapabilities()).toEqual([
      "Telo.Callable",
      "Telo.Invocable",
      "Telo.Mount",
      "Telo.Provider",
      "Telo.Runnable",
      "Telo.Service",
      "Telo.Sink",
      "Telo.Type",
    ]);
    expect(throwsAllowedCapabilities()).toEqual(["Telo.Invocable", "Telo.Runnable"]);
    const undeclarable = capabilityRoster().filter((e) => !e.declarable);
    expect(undeclarable.map((e) => [e.name, e.role])).toEqual([
      ["Telo.Executable", false],
      ["Telo.Template", true],
    ]);
  });

  it("is what the built-in Telo.Definition and Telo.Abstract schemas derive", () => {
    for (const name of ["Definition", "Abstract"]) {
      const schema = KERNEL_BUILTINS.find(
        (d) => d.kind === "Telo.Definition" && d.metadata.name === name,
      )!.schema as Record<string, any>;
      expect(schema.properties.capability.enum).toEqual(declarableCapabilities());
      if (name === "Definition") {
        expect(schema.if.properties.capability.not.enum).toEqual(throwsAllowedCapabilities());
      }
    }
  });

  it("marks the kernel-implemented built-ins, and no built-in document kind", () => {
    const marked = KERNEL_BUILTINS.filter((d) => Array.isArray(d.controllers)).map(
      (d) => d.metadata.name,
    );
    expect(marked.sort()).toEqual(
      [
        "ConsoleSink",
        "DurableDirectory",
        "FileSink",
        "Function",
        "JsonSchema",
        "LogTraceSink",
        "PublicHostPattern",
        "PublicUrl",
      ].sort(),
    );
  });
});

describe("capabilityProblem", () => {
  it("answers every capability conformance vector", () => {
    for (const row of CAPABILITY_VECTORS) {
      const expected = row.code === null ? undefined : { code: row.code, message: row.message };
      expect(capabilityProblem(row.capability, row.extends), row.id).toEqual(expected);
    }
  });

  it("accepts every declarable role", () => {
    for (const role of declarableCapabilities()) expect(capabilityProblem(role, false)).toBeUndefined();
  });
});

describe("telo check over a capability", () => {
  const app = { kind: "Telo.Application", metadata: { name: "App" } };
  const definition = (fields: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Thing" },
    controllers: ["pkg:npm/thing@1.0.0"],
    schema: { type: "object" },
    ...fields,
  });
  const analyze = (doc: unknown) =>
    new StaticAnalyzer().analyze(withSyntheticPositions([app, doc] as ResourceManifest[]));

  it("reports each mistake once, at the capability line", () => {
    for (const [capability, code] of [
      ["Telo.Invokable", "CAPABILITY_UNKNOWN"],
      ["Invocable", "CAPABILITY_UNKNOWN"],
      ["Telo.LogSink", "CAPABILITY_UNKNOWN"],
      ["Telo.Template", "CAPABILITY_NOT_DECLARABLE"],
      ["Telo.Executable", "CAPABILITY_NOT_DECLARABLE"],
    ] as const) {
      const errors = analyze(definition({ capability })).filter((d) => d.severity === 1);
      expect(errors.map((d) => [d.code, (d.data as { path?: string }).path])).toEqual([
        [code, "capability"],
      ]);
    }
  });

  it("refuses a field the definition schema does not declare", () => {
    const errors = analyze(definition({ capability: "Telo.Invocable", controllrs: [] })).filter(
      (d) => d.severity === 1,
    );
    expect(errors.map((d) => d.code)).toEqual(["SCHEMA_VIOLATION"]);
    expect(errors[0]!.message).toContain("'controllrs' is not allowed");
  });

  it("judges a kind document declared in a scope, at the member", () => {
    const scoping = {
      kind: "Telo.Definition",
      metadata: { name: "Scoping", module: "App" },
      capability: "Telo.Runnable",
      controllers: ["pkg:npm/scoping@1.0.0"],
      schema: {
        type: "object",
        properties: { with: { type: "array", "x-telo-scope": "/with" } },
      },
    };
    const holder = {
      kind: "App.Scoping",
      metadata: { name: "holder" },
      with: [
        { ...definition({ capability: "Telo.Invokable" }), metadata: { name: "Misspelled" } },
        {
          ...definition({ capability: "Telo.Invocable", controllrs: [] }),
          metadata: { name: "Misnamed" },
        },
      ],
    };
    const errors = new StaticAnalyzer()
      .analyze(withSyntheticPositions([app, scoping, holder] as ResourceManifest[]))
      .filter((d) => d.severity === 1);
    const anchored = errors.map((d) => {
      const data = d.data as { resource?: { name: string }; path?: string };
      return [d.code, data.resource?.name, data.path];
    });
    expect(anchored).toEqual([
      ["CAPABILITY_UNKNOWN", "holder", "with[0].capability"],
      ["SCHEMA_VIOLATION", "holder", "with[1]"],
    ]);
  });
});
