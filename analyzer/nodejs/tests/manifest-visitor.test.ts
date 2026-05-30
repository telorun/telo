import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry, visitManifest } from "../src/index.js";

function definition(
  name: string,
  capability: string,
  properties: Record<string, unknown>,
): ResourceDefinition {
  return {
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    capability,
    schema: { type: "object", properties },
  } as unknown as ResourceDefinition;
}

/** Builds a registry whose only non-builtin kind is `demo.Job`, with a ref
 *  slot `backend`, a scope field `tasks`, and a CEL-bearing `cmd` field. */
function registry(): AnalysisRegistry {
  const reg = new AnalysisRegistry();
  reg.registerDefinition(
    definition("Job", "Telo.Runnable", {
      backend: { "x-telo-ref": "demo#Job" },
      cmd: { type: "string" },
      tasks: {
        "x-telo-scope": "/tasks",
        type: "array",
        items: { type: "object" },
      },
    }),
  );
  return reg;
}

describe("visitManifest", () => {
  it("emits resource enter/exit bookends and ref sites", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      { kind: "demo.Job", metadata: { name: "a" }, backend: { kind: "demo.Job", name: "b" } },
      { kind: "demo.Job", metadata: { name: "b" } },
    ] as unknown as ResourceManifest[];

    const events: string[] = [];
    const refTargets: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      {
        onResourceEnter: (e) => events.push(`enter:${e.source.metadata!.name}`),
        onResourceExit: (e) => events.push(`exit:${e.source.metadata!.name}`),
        onRef: (e) => refTargets.push((e.value as { name: string }).name),
      },
      { aliases: reg._context().aliases },
    );

    expect(events).toEqual(["enter:a", "exit:a", "enter:b", "exit:b"]);
    expect(refTargets).toEqual(["b"]);
  });

  it("emits a scope boundary before that resource's ref sites, carrying enclosed names", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      {
        kind: "demo.Job",
        metadata: { name: "a" },
        tasks: [{ kind: "demo.Job", metadata: { name: "scoped" } }],
      },
    ] as unknown as ResourceManifest[];

    const seen: string[] = [];
    let enclosed: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      {
        onScope: (e) => {
          seen.push("scope");
          enclosed = [...e.enclosedNames];
        },
        onRef: () => seen.push("ref"),
      },
      { aliases: reg._context().aliases },
    );

    expect(enclosed).toEqual(["scoped"]);
    // Scope is delivered before any ref site of the same resource.
    expect(seen[0]).toBe("scope");
  });

  it("discovers CEL nodes by value-tree scan, including fields with no field-map entry", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      { kind: "demo.Job", metadata: { name: "a" }, cmd: "${{ resources.b.value }}" },
    ] as unknown as ResourceManifest[];

    const exprs: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      { onCel: (e) => exprs.push(`${e.path}=${e.expr}`) },
      { aliases: reg._context().aliases },
    );

    expect(exprs).toEqual(["cmd=resources.b.value"]);
  });

  it("discovers nested refs by value-tree scan, deduped against field-map sites", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      {
        kind: "demo.Job",
        metadata: { name: "a" },
        // `backend` is a field-map ref slot; `steps[].invoke` is not (it stands
        // in for a ref nested behind a `$ref` the field map doesn't descend).
        backend: { kind: "demo.Job", name: "b" },
        steps: [{ name: "s1", invoke: { kind: "demo.Job", name: "c" } }],
      },
      { kind: "demo.Job", metadata: { name: "b" } },
      { kind: "demo.Job", metadata: { name: "c" } },
    ] as unknown as ResourceManifest[];

    const fieldMapOnly: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      { onRef: (e) => fieldMapOnly.push(`${e.concretePath}${e.nested ? " (nested)" : ""}`) },
      { aliases: reg._context().aliases },
    );
    expect(fieldMapOnly).toEqual(["backend"]);

    const withNested: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      { onRef: (e) => withNested.push(`${e.concretePath}${e.nested ? " (nested)" : ""}`) },
      { aliases: reg._context().aliases, discoverNestedRefs: true },
    );
    // `backend` once (not re-emitted by the scan); the nested invoke discovered.
    expect(withNested).toEqual(["backend", "steps[0].invoke (nested)"]);
  });

  it("does not descend into a nested resource's own refs", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      {
        kind: "demo.Job",
        metadata: { name: "a" },
        steps: [
          {
            name: "s1",
            // Inline resource ({kind} without name) with its own nested ref —
            // that ref belongs to the inline resource, not to `a`.
            invoke: { kind: "demo.Job", connection: { kind: "demo.Job", name: "deep" } },
          },
        ],
      },
      { kind: "demo.Job", metadata: { name: "deep" } },
    ] as unknown as ResourceManifest[];

    const refs: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      { onRef: (e) => refs.push(e.concretePath) },
      { aliases: reg._context().aliases, discoverNestedRefs: true },
    );
    // The inline invoke is skipped (no name) and its `connection` is not surfaced.
    expect(refs).toEqual([]);
  });

  it("skips kinds named in skipKinds", () => {
    const reg = registry();
    const resources: ResourceManifest[] = [
      { kind: "demo.Job", metadata: { name: "a" } },
      { kind: "Telo.Definition", metadata: { name: "Job" } },
    ] as unknown as ResourceManifest[];

    const visited: string[] = [];
    visitManifest(
      resources,
      reg._context().definitions!,
      { onResourceEnter: (e) => visited.push(e.source.kind) },
      { aliases: reg._context().aliases, skipKinds: new Set(["Telo.Definition"]) },
    );

    expect(visited).toEqual(["demo.Job"]);
  });
});
