import { describe, expect, it } from "vitest";
import {
  collapseTopology,
  deriveGraph,
  deriveInvocations,
  subtreeGraph,
  traceSubgraph,
} from "./graph.js";
import type { DebugFrame } from "./wire.js";

let seq = 0;
const ev = (event: string, payload?: unknown): DebugFrame => ({
  timestamp: `2026-01-01T00:00:00.${String(seq++).padStart(3, "0")}Z`,
  event,
  payload,
});

const created = (kind: string, name: string, deps: { kind: string; name: string }[] = []) =>
  ev(`${kind}.${name}.Created`, { resource: { kind, name }, dependencies: deps });

type Owner = { kind: string; name: string; id: string };
const idOf = (kind: string, name: string, ownerId?: string) =>
  ownerId ? `${ownerId}/${kind}.${name}` : `${kind}.${name}`;

/** A `Created` carrying the hierarchical `id` (and `owner`, for a spawned child)
 *  the current kernel emits — the shape that disambiguates two instances of the
 *  same templated kind. */
const createdR = (
  kind: string,
  name: string,
  opts: { owner?: Owner; deps?: { kind: string; name: string; id?: string }[] } = {},
) =>
  ev(`${kind}.${name}.Created`, {
    resource: { kind, name, id: idOf(kind, name, opts.owner?.id) },
    ...(opts.owner ? { owner: opts.owner } : {}),
    dependencies: opts.deps ?? [],
  });

/** A terminal dispatch event whose `ref` carries the hierarchical `id`. */
const dispId = (
  name: string,
  kind: string,
  id: string,
  outcome: Outcome,
  suffix: string,
  detail: Record<string, unknown> = {},
): DebugFrame =>
  ev(`${name}.${suffix}`, { capability: "invoke", phase: "end", outcome, ref: { kind, name, id }, ...detail });

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

describe("owner grouping", () => {
  const todos: Owner = { kind: "Crud.Resource", name: "todos", id: "Crud.Resource.todos" };
  const users: Owner = { kind: "Crud.Resource", name: "users", id: "Crud.Resource.users" };

  it("keeps same-named children of two templated instances from colliding", () => {
    const { nodes } = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("Crud.Resource", "users"),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
      createdR("SqlRepo.Read", "reader", { owner: users }),
    ]);
    const readers = nodes.filter((n) => n.name === "reader");
    expect(readers.map((n) => n.id).sort()).toEqual([
      "Crud.Resource.todos/SqlRepo.Read.reader",
      "Crud.Resource.users/SqlRepo.Read.reader",
    ]);
    expect(readers.map((n) => n.ownerId).sort()).toEqual([
      "Crud.Resource.todos",
      "Crud.Resource.users",
    ]);
  });

  it("attributes an invocation to the right instance via ref.id", () => {
    const { nodes } = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("Crud.Resource", "users"),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
      createdR("SqlRepo.Read", "reader", { owner: users }),
      dispId("reader", "SqlRepo.Read", "Crud.Resource.todos/SqlRepo.Read.reader", "ok", "Invoked", {
        inputs: {},
        outputs: 1,
      }),
    ]);
    expect(nodes.find((n) => n.id === "Crud.Resource.todos/SqlRepo.Read.reader")?.invokeCount).toBe(1);
    expect(nodes.find((n) => n.id === "Crud.Resource.users/SqlRepo.Read.reader")?.invokeCount).toBe(0);
  });

  it("collapseTopology hides children until their owner is expanded", () => {
    const graph = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
      createdR("SqlRepo.Create", "creator", { owner: todos }),
    ]);

    const collapsedDefault = collapseTopology(graph, new Set());
    expect(collapsedDefault.nodes.map((n) => n.id)).toEqual(["Crud.Resource.todos"]);
    expect(collapsedDefault.nodes[0]).toMatchObject({ childCount: 2, expanded: false });

    const expanded = collapseTopology(graph, new Set(["Crud.Resource.todos"]));
    expect(expanded.nodes.map((n) => n.id).sort()).toEqual([
      "Crud.Resource.todos",
      "Crud.Resource.todos/SqlRepo.Create.creator",
      "Crud.Resource.todos/SqlRepo.Read.reader",
    ]);
    expect(expanded.nodes.find((n) => n.id === "Crud.Resource.todos")).toMatchObject({ expanded: true });

    // Revealed children stay attached to their owner via ownership edges.
    const owns = expanded.edges.filter((e) => e.ownership);
    expect(owns.map((e) => e.target).sort()).toEqual([
      "Crud.Resource.todos/SqlRepo.Create.creator",
      "Crud.Resource.todos/SqlRepo.Read.reader",
    ]);
    expect(owns.every((e) => e.source === "Crud.Resource.todos")).toBe(true);
  });

  it("adds no ownership edges while the owner is collapsed", () => {
    const graph = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
    ]);
    expect(collapseTopology(graph, new Set()).edges.some((e) => e.ownership)).toBe(false);
  });

  it("collapseTopology folds a hidden child's edge onto its owner", () => {
    const graph = deriveGraph([
      createdR("Sql.Connection", "db"),
      createdR("Crud.Resource", "todos"),
      createdR("SqlRepo.Read", "reader", {
        owner: todos,
        deps: [{ kind: "Sql.Connection", name: "db", id: "Sql.Connection.db" }],
      }),
    ]);
    const collapsed = collapseTopology(graph, new Set());
    expect(collapsed.edges).toContainEqual({
      id: "Crud.Resource.todos->Sql.Connection.db",
      source: "Crud.Resource.todos",
      target: "Sql.Connection.db",
    });
    // The child node itself is hidden while collapsed.
    expect(collapsed.nodes.some((n) => n.id.endsWith("SqlRepo.Read.reader"))).toBe(false);
  });
});

describe("subtreeGraph (drill-down pane)", () => {
  const todos: Owner = { kind: "Crud.Resource", name: "todos", id: "Crud.Resource.todos" };

  it("links the parent only to children not already reached by a sibling", () => {
    const topology = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("Http.Api", "api", {
        owner: todos,
        deps: [{ kind: "SqlRepo.Read", name: "reader", id: "Crud.Resource.todos/SqlRepo.Read.reader" }],
      }),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
    ]);
    const sub = subtreeGraph(topology, "Crud.Resource.todos");

    expect(sub.nodes.map((n) => n.id).sort()).toEqual([
      "Crud.Resource.todos",
      "Crud.Resource.todos/Http.Api.api",
      "Crud.Resource.todos/SqlRepo.Read.reader",
    ]);
    expect(sub.nodes.find((n) => n.id === "Crud.Resource.todos")?.expanded).toBe(true);

    // The parent owns `api` directly; `reader` is reached through `api`, so the
    // redundant parent→reader ownership edge is dropped.
    const owns = sub.edges.filter((e) => e.ownership);
    expect(owns.map((e) => e.target)).toEqual(["Crud.Resource.todos/Http.Api.api"]);
    expect(owns.some((e) => e.target.endsWith("SqlRepo.Read.reader"))).toBe(false);

    // The dependency edge among children (api → reader) is kept.
    expect(
      sub.edges.some(
        (e) =>
          !e.ownership &&
          e.source === "Crud.Resource.todos/Http.Api.api" &&
          e.target === "Crud.Resource.todos/SqlRepo.Read.reader",
      ),
    ).toBe(true);
  });

  it("reports each child's own childCount and drills recursively", () => {
    const reader: Owner = {
      kind: "SqlRepo.Read",
      name: "reader",
      id: "Crud.Resource.todos/SqlRepo.Read.reader",
    };
    const topology = deriveGraph([
      createdR("Crud.Resource", "todos"),
      createdR("SqlRepo.Read", "reader", { owner: todos }),
      createdR("Sql.Query", "reader-query", { owner: reader }),
    ]);

    const lvl1 = subtreeGraph(topology, "Crud.Resource.todos");
    expect(lvl1.nodes.find((n) => n.id === reader.id)?.childCount).toBe(1);

    const lvl2 = subtreeGraph(topology, reader.id);
    expect(lvl2.nodes.map((n) => n.id).sort()).toEqual([
      "Crud.Resource.todos/SqlRepo.Read.reader",
      "Crud.Resource.todos/SqlRepo.Read.reader/Sql.Query.reader-query",
    ]);
  });

  it("drops dependency edges that leave the subtree", () => {
    const topology = deriveGraph([
      createdR("Sql.Connection", "db"),
      createdR("Crud.Resource", "todos"),
      createdR("SqlRepo.Read", "reader", {
        owner: todos,
        deps: [{ kind: "Sql.Connection", name: "db", id: "Sql.Connection.db" }],
      }),
    ]);
    const sub = subtreeGraph(topology, "Crud.Resource.todos");
    expect(sub.nodes.some((n) => n.id === "Sql.Connection.db")).toBe(false);
    expect(sub.edges.some((e) => e.target === "Sql.Connection.db")).toBe(false);
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
