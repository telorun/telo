import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A kind that extends another without `base:` and declares no schema of its own
 * means exactly what its parent means: reaching `Telo.Sequence` through such a
 * child gives the same findings at the same places as naming it directly.
 */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const file = url in files ? url : `${url.replace(/\/$/, "")}/telo.yaml`;
      const text = files[file];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: file };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

const MODULE = `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.Definition
metadata: { name: Seq }
extends: Telo.Sequence
---
kind: Telo.Definition
metadata: { name: Counter }
capability: Telo.Runnable
controllers: [pkg:npm/none@0.0.0]
schema: { type: object, additionalProperties: false }
status:
  type: object
  properties: { runs: { type: integer } }
---
kind: Telo.Function
metadata: { name: sign }
params: [{ name: text, schema: { type: string } }]
returns: { schema: { type: string } }
body: !cel "text"
`;

async function findings(body: string, kind: string): Promise<string[]> {
  const files = { "/app/telo.yaml": MODULE + "---\n" + body.replaceAll("SEQ", kind) };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code} @ ${String((d.data as { path?: string } | undefined)?.path)}`)
    .sort();
}

async function expectInvariant(body: string, codes: string[]): Promise<void> {
  const direct = await findings(body, "Telo.Sequence");
  expect([...new Set(direct.map((f) => f.split(" @ ")[0]))].sort()).toEqual([...codes].sort());
  expect(await findings(body, "Self.Seq")).toEqual(direct);
}

describe("an empty merge-form child of a kind", () => {
  it("is judged by its parent's step grammar, step references, rethrow placement and scope members", async () => {
    await expectInvariant(
      `kind: SEQ
metadata: { name: sequence }
with:
  - kind: Self.Counter
    metadata: { name: member }
    answr: 1
steps:
  - name: missing
    invoke: !ref nowhere
  - name: callable
    invoke: !ref sign
  - name: outside
    rethrow: {}
  - name: guarded
    try:
      - name: fail
        throw: { code: FAILED }
    finally:
      - name: again
        rethrow: {}
  - name: typo
    value: !cel "steps.frist.result"
  - !for-each
    name: repeated
    in: !cel "[1, 2]"
    emit: { value: 1 }
`,
      [
        "CEL_UNKNOWN_FIELD",
        "REFERENCE_KIND_MISMATCH",
        "REPEAT_OUTSIDE_TEMPLATE",
        "RETHROW_WITHOUT_CAUGHT_ERROR",
        "SCHEMA_VIOLATION",
        "UNRESOLVED_REFERENCE",
      ],
    );
  });

  it("holds a template body's family members and their reads as its parent does", async () => {
    await expectInvariant(
      `kind: Telo.Definition
metadata: { name: Pipeline }
capability: Telo.Invocable
schema:
  type: object
  required: [jobs]
  properties: { jobs: { type: object, additionalProperties: { type: object } } }
resources:
  - !for-each
    metadata: { name: counters }
    in: !cel "self.jobs"
    emit: { kind: Self.Counter }
  - kind: SEQ
    metadata: { name: pipeline }
    steps:
      - !for-each
        name: ran
        in: !cel "self.jobs"
        emit:
          invoke: !ref counters[each.key]
      - !for-each
        name: seen
        in: !cel "self.jobs"
        emit:
          value: !cel "resources.counters[each.key].status.runz"
      - __emitted: { repeat: runs, key: a }
        value: 1
invoke: !ref pipeline
---
kind: Self.Pipeline
metadata: { name: pipeline }
jobs: { alpha: {} }
`,
      ["CEL_UNKNOWN_FIELD", "REPEAT_POSITION_INVALID"],
    );
  });
});
