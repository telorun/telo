import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * What a native function's `use: dependency` slot may hold, at `telo check`. The
 * refusals the kernel twins are pinned both ways in `tests/check-run-agreement.yaml`;
 * these are the ones it has no reachable twin for, or that only `telo check` decides.
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

const CODES = /^(CALLABLE_|DEPENDENCY_CYCLE$)/;

async function check(app: string): Promise<Array<[string, string, string]>> {
  const files = { "/app/telo.yaml": app };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => CODES.test(String(d.code)))
    .map((d) => [String(d.code), String((d.data as { path?: string }).path), d.message]);
}

const HEAD = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Node
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    pick:
      type: string
      x-telo-eval: accessor
      x-telo-context:
        type: object
        properties:
          row: { type: object }
    next:
      x-telo-ref: { kind: Self.Node, use: schema }
---
kind: Telo.Definition
metadata:
  name: Read
capability: Telo.Callable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    source:
      x-telo-ref: { kind: Self.Node, use: dependency }
---
kind: Self.Node
metadata: { name: a }
pick: !cel "row.name"
next: !ref b
---
kind: Self.Node
metadata: { name: b }
next: !ref a
`;

const CYCLE =
  "holds 'a' at 'source' as data, but the references 'a' → 'b' → 'a' form a cycle, so its configuration would contain itself.";

describe("a native function's data site", () => {
  it("holds a referent whose accessor field is a binding, and refuses one reaching a reference cycle", async () => {
    expect(
      await check(`${HEAD}---
kind: Self.Node
metadata: { name: leaf }
pick: !cel "row.name"
---
kind: Self.Read
metadata: { name: readLeaf }
source: !ref leaf
---
kind: Self.Read
metadata: { name: readA }
source: !ref a
`),
    ).toEqual([["CALLABLE_REFERENCE_NOT_DATA", "source", `Self.Read/readA: ${CYCLE}`]]);
  });

  it("is chosen per site by a case map, whose slot keeps a function's constraint while a case calls", async () => {
    expect(
      await check(`${HEAD}---
kind: Telo.Definition
metadata:
  name: Pick
capability: Telo.Callable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    mode: { type: string, default: hold }
    source:
      x-telo-ref:
        kind: Self.Node
        use: { by: /mode, cases: { hold: dependency, call: call } }
---
kind: Self.Pick
metadata: { name: held }
source: !ref a
---
kind: Self.Pick
metadata: { name: called }
mode: call
source: !ref a
`),
    ).toEqual([
      [
        "CALLABLE_DEFINITION_INVALID",
        "schema.properties.source",
        expect.stringContaining("Pick: holds 'App.Node' at 'schema.properties.source', whose capability is 'Telo.Provider'"),
      ],
      ["CALLABLE_REFERENCE_NOT_DATA", "source", `Self.Pick/held: ${CYCLE}`],
    ]);
  });
});

describe("a native function declared in a `with:` scope", () => {
  it("is judged at its member, its reference resolving among its scope's members first", async () => {
    expect(
      await check(`${HEAD}---
kind: Telo.Definition
metadata:
  name: Late
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    greeting: { type: string, x-telo-eval: runtime }
---
kind: Telo.Definition
metadata:
  name: Box
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    members:
      type: array
      x-telo-scope: /members
---
kind: Telo.Definition
metadata:
  name: ReadLate
capability: Telo.Callable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    source:
      x-telo-ref: { kind: [Self.Late, Self.Node], use: dependency }
---
kind: Self.Node
metadata: { name: late }
---
kind: Self.Box
metadata: { name: box }
members:
  - kind: Self.Late
    metadata: { name: late }
    greeting: !cel "'hi'"
  - kind: Self.ReadLate
    metadata: { name: scopedRead }
    source: !ref late
`),
    ).toEqual([
      [
        "CALLABLE_REFERENCE_NOT_DATA",
        "members[1].source",
        "Self.ReadLate/scopedRead: holds 'late' at 'source' as data, but it holds `!cel` at 'greeting', evaluated after it is created, so its configuration is not data yet. A native function receives each dependency's configuration once, at creation: write a literal there, or an expression in a field its kind evaluates at creation.",
      ],
    ]);
  });
});

describe("a function kind with a body", () => {
  it("is refused at a data slot it inherits from a native ancestor", async () => {
    expect(
      await check(`kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Node
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema: { type: object }
---
kind: Telo.Abstract
metadata:
  name: Holder
capability: Telo.Callable
schema:
  type: object
  properties:
    source:
      x-telo-ref: { kind: Self.Node, use: dependency }
---
kind: Telo.Definition
metadata:
  name: Bodied
extends: Self.Holder
schema:
  type: object
  properties:
    body:
      x-telo-returns-from: returns
      x-telo-context: { type: object }
`),
    ).toEqual([
      [
        "CALLABLE_DEFINITION_INVALID",
        "schema.properties.source",
        expect.stringContaining("Telo.Definition/Bodied: inherits 'schema.properties.source', which holds 'App.Node'"),
      ],
    ]);
  });
});

const BODY_HEAD = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Late
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    greeting: { type: string, x-telo-eval: runtime }
    next:
      x-telo-ref: { kind: [Self.Late, Self.Plain], use: dependency }
---
kind: Telo.Definition
metadata:
  name: Plain
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema: { type: object }
---
kind: Telo.Definition
metadata:
  name: Read
capability: Telo.Callable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    source:
      x-telo-ref: { kind: Self.Late, use: dependency }
---
kind: Self.Plain
metadata: { name: plain }
`;

describe("a native function in a template body", () => {
  it("holds a sibling the template evaluates before creating it, and is refused one reaching a module resource", async () => {
    expect(
      await check(`${BODY_HEAD}---
kind: Telo.Definition
metadata:
  name: Wrap
capability: Telo.Provider
schema:
  type: object
  properties:
    who: { type: string }
resources:
  - kind: Self.Late
    metadata: { name: early }
    greeting: !cel "'hi ' + self.who"
  - kind: Self.Read
    metadata: { name: readEarly }
    source: !ref early
  - kind: Self.Late
    metadata: { name: chained }
    next: !ref plain
  - kind: Self.Read
    metadata: { name: readChained }
    source: !ref chained
`),
    ).toEqual([
      [
        "CALLABLE_REFERENCE_NOT_DATA",
        "resources[3].source",
        "Telo.Definition/Wrap: the Self.Read entry 'readChained': holds 'chained' at 'source' as data, but 'plain' is a resource of the module defining the template, which an entry of the template's body does not reach: declare it in the body's `resources:`, or hand it in through a bare `self.<field>`.",
      ],
    ]);
  });

  it("is judged at the consumer for what the consumer forwards into a sibling it holds", async () => {
    expect(
      await check(`${BODY_HEAD}---
kind: Telo.Definition
metadata:
  name: Wrap
capability: Telo.Invocable
schema:
  type: object
  properties:
    greeting: { type: string }
invoke: !ref inner
resources:
  - kind: Self.Late
    metadata: { name: inner }
    greeting: !cel "self.greeting"
  - kind: Self.Read
    metadata: { name: read }
    source: !ref inner
---
kind: Self.Wrap
metadata: { name: wrap }
greeting: !cel "variables.word"
`),
    ).toEqual([
      [
        "CALLABLE_REFERENCE_NOT_DATA",
        "greeting",
        "Self.Wrap/wrap: 'greeting' is forwarded into the Self.Late entry 'inner' as 'greeting', which checks it as its own field — the Self.Read entry 'read': holds 'inner' at 'source' as data, but it holds `!cel` at 'greeting', evaluated after it is created, so its configuration is not data yet. A native function receives each dependency's configuration once, at creation: write a literal there, or an expression in a field its kind evaluates at creation.",
      ],
    ]);
  });
});

describe("a native function in a scope a template body entry declares", () => {
  it("holds a member the template evaluates before the scope opens, and is refused one its entry's kind defers", async () => {
    expect(
      await check(`${BODY_HEAD}---
kind: Telo.Definition
metadata:
  name: Box
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    members:
      type: array
      x-telo-scope: /members
---
kind: Telo.Definition
metadata:
  name: Region
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    members:
      type: array
      x-telo-scope: /members
      x-telo-context: { type: object }
---
kind: Telo.Definition
metadata:
  name: Wrap
capability: Telo.Invocable
schema: { type: object }
invoke: !ref deferred
resources:
  - kind: Self.Box
    metadata: { name: expanded }
    members:
      - kind: Self.Late
        metadata: { name: late }
        greeting: !cel "module.version"
      - kind: Self.Read
        metadata: { name: read }
        source: !ref late
  - kind: Self.Region
    metadata: { name: deferred }
    members:
      - kind: Self.Late
        metadata: { name: late }
        greeting: !cel "module.version"
      - kind: Self.Read
        metadata: { name: read }
        source: !ref late
`),
    ).toEqual([
      [
        "CALLABLE_REFERENCE_NOT_DATA",
        "resources[1].members[1].source",
        "Telo.Definition/Wrap: the Self.Read 'read' declared in the Self.Region entry 'deferred': holds 'late' at 'source' as data, but it holds `!cel` at 'greeting', evaluated after it is created, so its configuration is not data yet. A native function receives each dependency's configuration once, at creation: write a literal there, or an expression in a field its kind evaluates at creation.",
      ],
    ]);
  });
});
