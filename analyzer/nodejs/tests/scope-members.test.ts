import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/**
 * A member of an `x-telo-scope` array is a declaration of its holder's module:
 * every pass a top-level resource runs through reaches it, names resolve scope
 * first, and what is found about it is reported once, inside the resource
 * declaring the scope.
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

type Found = [code: string, resource: string, path: string];

async function check(body: string): Promise<Found[]> {
  const files = { "/app/telo.yaml": `${HEAD}${body}` };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => {
      const data = d.data as { resource?: { kind: string; name: string }; path?: string; filePath?: string };
      expect(data.filePath).toBe("/app/telo.yaml");
      return [
        String(d.code),
        `${data.resource?.kind}/${data.resource?.name}`,
        String(data.path),
      ] as Found;
    });
}

// A holder whose scope is declared on a field named `members` — never `with` —
// visible in its `steps`, and two closed kinds to declare there.
const HEAD = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
variables:
  limit:
    env: LIMIT
    type: integer
    default: 3
---
kind: Telo.Definition
metadata:
  name: Host
capability: Telo.Runnable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    members:
      type: array
      x-telo-scope: /steps
      items: { type: object }
    steps:
      type: array
      items:
        type: object
        properties:
          call:
            x-telo-ref: { kind: Self.Target, use: call }
---
kind: Telo.Definition
metadata:
  name: Target
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    answer:
      x-telo-eval: runtime
    target:
      x-telo-ref: { kind: Self.Target, use: call }
---
kind: Telo.Definition
metadata:
  name: Other
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    answer:
      x-telo-eval: runtime
`;

describe("scope members", () => {
  it("reports a misspelled field, an unresolved reference and a CEL typo once each, at the member", async () => {
    expect(
      await check(`---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Target
    metadata:
      name: spelled
    answr: 1
  - kind: Self.Target
    metadata:
      name: dangling
    target: !ref nowhere
  - kind: Self.Target
    metadata:
      name: typo
    answer: !cel "variables.limt"
steps:
  - call: !ref spelled
`),
    ).toEqual([
      ["SCHEMA_VIOLATION", "Self.Host/host", "members[0]"],
      ["CEL_UNKNOWN_FIELD", "Self.Host/host", "members[2].answer"],
      ["UNRESOLVED_REFERENCE", "Self.Host/host", "members[1].target"],
    ]);
  });

  it("reports a member of a member's scope at its place inside the top-level holder", async () => {
    expect(
      await check(`---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Host
    metadata:
      name: inner
    members:
      - kind: Self.Target
        metadata:
          name: deep
        target: !ref nowhere
`),
    ).toEqual([["UNRESOLVED_REFERENCE", "Self.Host/host", "members[0].members[0].target"]]);
  });

  it("lets a member share a top-level resource's name, which it shadows inside its scope only", async () => {
    expect(
      await check(`---
kind: Self.Other
metadata:
  name: shared
answer: !cel "resources.shared"
---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Target
    metadata:
      name: shared
    answer: !cel "resources.shared"
  - kind: Self.Target
    metadata:
      name: sibling
    target: !ref shared
steps:
  - call: !ref shared
`),
    ).toEqual([]);
  });

  it("types a binding a holder's region reads off a member that shadows a module-level name", async () => {
    // `result` is typed from the `outputType` of what the step's `call` names:
    // read in the scope's region, `shared` is the member.
    expect(
      await check(`---
kind: Telo.Definition
metadata:
  name: Answer
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    outputType: { type: object }
---
kind: Telo.Definition
metadata:
  name: Caller
capability: Telo.Runnable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    members:
      type: array
      x-telo-scope: /steps
      items: { type: object }
    steps:
      type: array
      items:
        type: object
        properties:
          call:
            x-telo-ref: { kind: Self.Answer, use: call }
          show:
            x-telo-context:
              type: object
              properties:
                result:
                  x-telo-context-ref-from: call/outputType
---
kind: Self.Answer
metadata:
  name: shared
outputType:
  type: object
  additionalProperties: false
  properties:
    outer: { type: string }
---
kind: Self.Caller
metadata:
  name: caller
members:
  - kind: Self.Answer
    metadata:
      name: shared
    outputType:
      type: object
      additionalProperties: false
      properties:
        inner: { type: string }
steps:
  - call: !ref shared
    show: !cel "result.inner"
`),
    ).toEqual([]);
  });

  it("refuses a top-level read of a name only a scope declares", async () => {
    expect(
      await check(`---
kind: Self.Other
metadata:
  name: outside
answer: !cel "resources.scoped"
---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Target
    metadata:
      name: scoped
steps:
  - call: !ref scoped
`),
    ).toEqual([["CEL_UNKNOWN_FIELD", "Self.Other/outside", "answer"]]);
  });

  it("reports two members of one scope sharing a name", async () => {
    expect(
      await check(`---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Target
    metadata:
      name: twice
  - kind: Self.Target
    metadata:
      name: twice
`),
    ).toEqual([["DUPLICATE_RESOURCE_NAME", "Self.Host/host", "members[1].metadata.name"]]);
  });

  it("reports members of one scope holding each other as a cycle", async () => {
    const found = await check(`---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Self.Target
    metadata:
      name: first
    target: !ref second
  - kind: Self.Target
    metadata:
      name: second
    target: !ref first
`);
    expect(found).toEqual([["DEPENDENCY_CYCLE", "Self.Host/host", "members[0].metadata.name"]]);
  });

  it("warns at a sink declared in a scope, which no `sinks:` list can name", async () => {
    const files = {
      "/app/telo.yaml": `${HEAD}---
kind: Self.Host
metadata:
  name: host
members:
  - kind: Telo.LogTraceSink
    metadata:
      name: traces
`,
    };
    const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", {
      desugarImports: true,
    });
    const found = new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
      .filter((d) => d.code === "SINK_UNATTACHED")
      .map((d) => [(d.data as { resource: { name: string } }).resource.name, (d.data as { path: string }).path]);
    expect(found).toEqual([["host", "members[0]"]]);
  });
});
