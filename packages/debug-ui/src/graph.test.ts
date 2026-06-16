import { describe, expect, it } from "vitest";
import { deriveGraph, deriveInvocations, traceSubgraph } from "./graph.js";
import type { DebugFrame } from "./wire.js";

let seq = 0;
const ev = (event: string, payload?: unknown): DebugFrame => ({
  timestamp: `2026-01-01T00:00:00.${String(seq++).padStart(3, "0")}Z`,
  event,
  payload,
});

const created = (kind: string, name: string, deps: { kind: string; name: string }[] = []) =>
  ev(`${kind}.${name}.Created`, { resource: { kind, name }, dependencies: deps });

describe("deriveGraph", () => {
  it("creates a gray (created) node on Created", () => {
    const { nodes } = deriveGraph([created("Http.Server", "api")]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "api", kind: "Http.Server", name: "api", status: "created", invokeCount: 0 });
  });

  it("brightens the node on Initialized", () => {
    const { nodes } = deriveGraph([
      created("Http.Server", "api"),
      ev("Http.Server.api.Initialized", { resource: { kind: "Http.Server", name: "api" } }),
    ]);
    expect(nodes[0].status).toBe("initialized");
  });

  it("marks the node torndown on Teardown", () => {
    const { nodes } = deriveGraph([
      created("Http.Server", "api"),
      ev("Http.Server.api.Teardown", { resource: { kind: "Http.Server", name: "api" } }),
    ]);
    expect(nodes[0].status).toBe("torndown");
  });

  it("wires edges from Created dependencies", () => {
    const { edges } = deriveGraph([
      created("Sql.Pool", "db"),
      created("Http.Server", "api", [{ kind: "Sql.Pool", name: "db" }]),
    ]);
    expect(edges).toEqual([{ id: "api->db", source: "api", target: "db" }]);
  });

  it("dedupes repeated dependency edges", () => {
    const dep = [{ kind: "Sql.Pool", name: "db" }];
    const { edges } = deriveGraph([created("Http.Server", "api", dep), created("Http.Server", "api", dep)]);
    expect(edges).toHaveLength(1);
  });

  it("records an ok invocation with inputs and outputs", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "echo"),
      ev("Js.Script.echo.Invoked", { inputs: { msg: "hi" }, outputs: { echoed: "hi" } }),
    ]);
    expect(nodes[0].invokeCount).toBe(1);
    expect(nodes[0].lastInvoke).toMatchObject({
      outcome: "ok",
      suffix: "Invoked",
      inputs: { msg: "hi" },
      outputs: { echoed: "hi" },
    });
  });

  it("classifies failure, rejection and cancellation outcomes", () => {
    const base = created("Js.Script", "x");
    expect(
      deriveGraph([base, ev("Js.Script.x.InvokeFailed", { inputs: {}, name: "Error", message: "boom" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("failed");
    expect(
      deriveGraph([base, ev("Js.Script.x.InvokeRejected", { inputs: {}, code: "E", message: "no" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("rejected");
    expect(
      deriveGraph([base, ev("Js.Script.x.InvokeCancelled", { inputs: {}, reason: "stop" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("cancelled");
  });

  it("treats InvokeRejected.Undeclared as a rejection on the right node", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "x"),
      ev("Js.Script.x.InvokeRejected.Undeclared", { inputs: {}, code: "E", message: "no" }),
    ]);
    expect(nodes[0].lastInvoke).toMatchObject({ outcome: "rejected", suffix: "InvokeRejected.Undeclared" });
  });

  it("counts repeated invocations and advances the activity index", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "x"),
      ev("Js.Script.x.Invoked", { inputs: {}, outputs: 1 }),
      ev("Js.Script.x.Invoked", { inputs: {}, outputs: 2 }),
    ]);
    expect(nodes[0].invokeCount).toBe(2);
    expect(nodes[0].lastInvoke?.outputs).toBe(2);
    expect(nodes[0].lastActivitySeq).toBeGreaterThan(0);
  });

  it("attributes an invocation to the longest matching resource prefix", () => {
    // `Http.Server.api` and `Http.Server.api.sub` share a prefix; the event must
    // land on the deeper node, not the shorter one.
    const { nodes } = deriveGraph([
      created("Http.Server", "api"),
      created("Http.Server.api", "sub"),
      ev("Http.Server.api.sub.Invoked", { inputs: {}, outputs: "ok" }),
    ]);
    expect(nodes.find((n) => n.name === "sub")?.invokeCount).toBe(1);
    expect(nodes.find((n) => n.name === "api")?.invokeCount).toBe(0);
  });

  it("ignores log frames and non-resource events", () => {
    const { nodes, edges } = deriveGraph([
      { kind: "log", timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", line: "hello" },
      ev("Kernel.Started", {}),
      created("Js.Script", "x"),
    ]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});

const inv = (
  event: string,
  invocationId: number,
  parentInvocationId: number | undefined,
  payload: unknown,
): DebugFrame => ({
  timestamp: `2026-01-01T00:00:00.${String(seq++).padStart(3, "0")}Z`,
  event,
  payload,
  metadata: { invocationId, ...(parentInvocationId !== undefined ? { parentInvocationId } : {}) },
});

describe("deriveInvocations", () => {
  it("is empty when events carry no invocation metadata (tracing off)", () => {
    const t = deriveInvocations([ev("Js.Script.x.Invoked", { outputs: 1 })]);
    expect(t.roots).toHaveLength(0);
    expect(t.byId.size).toBe(0);
  });

  it("collects a root invocation with its resource, inputs and outputs", () => {
    const t = deriveInvocations([inv("Http.Server.api.Invoked", 1, undefined, { inputs: { a: 1 }, outputs: "ok" })]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0]).toMatchObject({ id: 1, kind: "Http.Server", name: "api", outcome: "ok", inputs: { a: 1 }, outputs: "ok" });
  });

  it("links children to parents and keeps only roots at the top", () => {
    const t = deriveInvocations([
      inv("A.root.Invoked", 1, undefined, { outputs: 1 }),
      inv("B.child.Invoked", 2, 1, { outputs: 2 }),
      inv("C.grand.Invoked", 3, 2, { outputs: 3 }),
    ]);
    expect(t.roots.map((r) => r.id)).toEqual([1]);
    expect(t.childrenOf.get(1)).toEqual([2]);
    expect(t.childrenOf.get(2)).toEqual([3]);
  });

  it("dedupes the InvokeRejected.Undeclared echo by id", () => {
    const t = deriveInvocations([
      inv("A.x.InvokeRejected", 1, undefined, { code: "E" }),
      inv("A.x.InvokeRejected.Undeclared", 1, undefined, { code: "E" }),
    ]);
    expect(t.byId.size).toBe(1);
    expect(t.byId.get(1)).toMatchObject({ outcome: "rejected", suffix: "InvokeRejected" });
  });
});

describe("traceSubgraph", () => {
  it("returns only the participating resources wired by call edges", () => {
    const t = deriveInvocations([
      inv("A.root.Invoked", 1, undefined, { outputs: 1 }),
      inv("B.child.Invoked", 2, 1, { outputs: 2 }),
      inv("C.other.Invoked", 9, undefined, { outputs: 9 }), // a different trace
    ]);
    const g = traceSubgraph(t, 1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["A.root", "B.child"]);
    expect(g.nodes.find((n) => n.id === "A.root")?.isRoot).toBe(true);
    expect(g.edges).toEqual([{ id: "A.root->B.child", source: "A.root", target: "B.child" }]);
  });

  it("collapses repeated calls to one node holding every invocation", () => {
    const t = deriveInvocations([
      inv("A.root.Invoked", 1, undefined, { outputs: 1 }),
      inv("B.svc.Invoked", 2, 1, { outputs: 2 }),
      inv("B.svc.Invoked", 3, 1, { outputs: 3 }),
    ]);
    const g = traceSubgraph(t, 1);
    const svc = g.nodes.find((n) => n.id === "B.svc");
    expect(svc?.invocations.map((i) => i.id)).toEqual([2, 3]);
    expect(g.edges).toHaveLength(1);
  });
});
