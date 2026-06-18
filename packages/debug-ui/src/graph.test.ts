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

type Outcome = "ok" | "failed" | "rejected" | "cancelled";

/** A terminal dispatch (trace) event: the name drops the kind, the payload carries
 *  the structured trace contract `{ capability, phase, outcome, ref, … }`. */
const disp = (
  name: string,
  kind: string,
  outcome: Outcome,
  suffix: string,
  detail: Record<string, unknown> = {},
): DebugFrame =>
  ev(`${name}.${suffix}`, { capability: "invoke", phase: "end", outcome, ref: { kind, name }, ...detail });

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
      disp("echo", "Js.Script", "ok", "Invoked", { inputs: { msg: "hi" }, outputs: { echoed: "hi" } }),
    ]);
    expect(nodes[0].invokeCount).toBe(1);
    expect(nodes[0].lastInvoke).toMatchObject({
      outcome: "ok",
      suffix: "Invoked",
      inputs: { msg: "hi" },
      outputs: { echoed: "hi" },
    });
  });

  it("skips a phase:start event (no outcome) — only terminal events count", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "echo"),
      ev("echo.Invoking", { capability: "invoke", phase: "start", ref: { kind: "Js.Script", name: "echo" }, inputs: {} }),
    ]);
    expect(nodes[0].invokeCount).toBe(0);
    expect(nodes[0].lastInvoke).toBeUndefined();
  });

  it("records failure, rejection and cancellation outcomes from the payload", () => {
    const base = created("Js.Script", "x");
    expect(
      deriveGraph([base, disp("x", "Js.Script", "failed", "InvokeFailed", { inputs: {}, name: "Error", message: "boom" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("failed");
    expect(
      deriveGraph([base, disp("x", "Js.Script", "rejected", "InvokeRejected", { inputs: {}, code: "E", message: "no" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("rejected");
    expect(
      deriveGraph([base, disp("x", "Js.Script", "cancelled", "InvokeCancelled", { inputs: {}, reason: "stop" })])
        .nodes[0].lastInvoke?.outcome,
    ).toBe("cancelled");
  });

  it("treats InvokeRejected.Undeclared as a rejection on the right node", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "x"),
      disp("x", "Js.Script", "rejected", "InvokeRejected.Undeclared", { inputs: {}, code: "E", message: "no" }),
    ]);
    expect(nodes[0].lastInvoke).toMatchObject({ outcome: "rejected", suffix: "Undeclared" });
  });

  it("counts repeated invocations and advances the activity index", () => {
    const { nodes } = deriveGraph([
      created("Js.Script", "x"),
      disp("x", "Js.Script", "ok", "Invoked", { inputs: {}, outputs: 1 }),
      disp("x", "Js.Script", "ok", "Invoked", { inputs: {}, outputs: 2 }),
    ]);
    expect(nodes[0].invokeCount).toBe(2);
    expect(nodes[0].lastInvoke?.outputs).toBe(2);
    expect(nodes[0].lastActivitySeq).toBeGreaterThan(0);
  });

  it("attributes an invocation to the resource named in the payload ref", () => {
    const { nodes } = deriveGraph([
      created("Http.Server", "api"),
      created("Http.Server.api", "sub"),
      disp("sub", "Http.Server.api", "ok", "Invoked", { inputs: {}, outputs: "ok" }),
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

/** A terminal dispatch event carrying trace ids — `spanId` / `parentSpanId`. */
const inv = (
  name: string,
  kind: string,
  spanId: number,
  parentSpanId: number | undefined,
  outcome: Outcome,
  suffix: string,
  detail: Record<string, unknown> = {},
): DebugFrame =>
  ev(`${name}.${suffix}`, {
    spanId,
    parentSpanId,
    capability: "invoke",
    phase: "end",
    outcome,
    ref: { kind, name },
    ...detail,
  });

describe("deriveInvocations", () => {
  it("is empty when events carry no span ids (tracing off)", () => {
    const t = deriveInvocations([disp("x", "Js.Script", "ok", "Invoked", { outputs: 1 })]);
    expect(t.roots).toHaveLength(0);
    expect(t.byId.size).toBe(0);
  });

  it("collects a root invocation with its resource, inputs and outputs", () => {
    const t = deriveInvocations([inv("api", "Http.Server", 1, undefined, "ok", "Invoked", { inputs: { a: 1 }, outputs: "ok" })]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0]).toMatchObject({ id: 1, kind: "Http.Server", name: "api", outcome: "ok", inputs: { a: 1 }, outputs: "ok" });
  });

  it("links children to parents and keeps only roots at the top", () => {
    const t = deriveInvocations([
      inv("root", "A", 1, undefined, "ok", "Invoked", { outputs: 1 }),
      inv("child", "B", 2, 1, "ok", "Invoked", { outputs: 2 }),
      inv("grand", "C", 3, 2, "ok", "Invoked", { outputs: 3 }),
    ]);
    expect(t.roots.map((r) => r.id)).toEqual([1]);
    expect(t.childrenOf.get(1)).toEqual([2]);
    expect(t.childrenOf.get(2)).toEqual([3]);
  });

  it("dedupes the InvokeRejected.Undeclared echo by id, keeping the primary", () => {
    const t = deriveInvocations([
      inv("x", "A", 1, undefined, "rejected", "InvokeRejected", { code: "E" }),
      inv("x", "A", 1, undefined, "rejected", "InvokeRejected.Undeclared", { code: "E" }),
    ]);
    expect(t.byId.size).toBe(1);
    expect(t.byId.get(1)).toMatchObject({ outcome: "rejected", suffix: "InvokeRejected" });
  });
});

describe("traceSubgraph", () => {
  it("returns only the participating resources wired by call edges", () => {
    const t = deriveInvocations([
      inv("root", "A", 1, undefined, "ok", "Invoked", { outputs: 1 }),
      inv("child", "B", 2, 1, "ok", "Invoked", { outputs: 2 }),
      inv("other", "C", 9, undefined, "ok", "Invoked", { outputs: 9 }), // a different trace
    ]);
    const g = traceSubgraph(t, 1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["A.root", "B.child"]);
    expect(g.nodes.find((n) => n.id === "A.root")?.isRoot).toBe(true);
    expect(g.edges).toEqual([{ id: "A.root->B.child", source: "A.root", target: "B.child" }]);
  });

  it("collapses repeated calls to one node holding every invocation", () => {
    const t = deriveInvocations([
      inv("root", "A", 1, undefined, "ok", "Invoked", { outputs: 1 }),
      inv("svc", "B", 2, 1, "ok", "Invoked", { outputs: 2 }),
      inv("svc", "B", 3, 1, "ok", "Invoked", { outputs: 3 }),
    ]);
    const g = traceSubgraph(t, 1);
    const svc = g.nodes.find((n) => n.id === "B.svc");
    expect(svc?.invocations.map((i) => i.id)).toEqual([2, 3]);
    expect(g.edges).toHaveLength(1);
  });
});
