// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";
import { address, defaultFailure, formNode, listingNode, memoryState, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const form = (...path: string[]) => ({ root: "form", path });

const previewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["period", "columns", "showChart", "limit"],
  properties: {
    period: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
    columns: { type: "string", title: "Columns", enum: ["short", "full"], default: "short" },
    showChart: { type: "boolean", title: "Chart", default: false },
    limit: { type: "integer", title: "Limit", minimum: 1 },
    name: { type: "string", title: "Name" },
  },
};

/** The preview's form: a period starting this month, the display options, a limit and a name filter. */
const previewForm = (overrides: Record<string, unknown> = {}) =>
  formNode("/unused", {
    id: "Test/preview",
    schema: previewSchema,
    record: null,
    fields: [
      { type: "dateRange", property: "period", label: "Period", presets: [{ label: "This month", unit: "month", offset: 0 }], initialPreset: 0 },
      { type: "input", property: "columns", label: "Columns", control: "options" },
      { type: "input", property: "showChart", label: "Chart", control: "toggle" },
      { type: "input", property: "limit", label: "Limit", control: "auto" },
      { type: "input", property: "name", label: "Name", control: "auto" },
    ],
    state: memoryState(["period", "columns", "showChart", "limit", "name"]),
    ...overrides,
  });

const answerSchema = { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } };

/** The preview read: a `QUERY` sending what the form holds, drawing the names it answers. */
const previewQuery = (query: Record<string, unknown> = {}, node: Record<string, unknown> = {}) => ({
  type: "query",
  query: {
    id: "Test/preview-read",
    schema: answerSchema,
    method: "QUERY",
    url: address("/api/preview"),
    input: { body: { map: { period: form("period"), columns: form("columns"), showChart: form("showChart"), limit: form("limit"), name: form("name") } } },
    query: {},
    form: "Test/preview",
    reloadOn: [],
    ...query,
  },
  content: [{ type: "list", rows: { root: "data", path: ["items"] }, columns: [{ header: "Name", value: { root: "row", path: ["name"] }, present: { type: "string" } }] }],
  loading: [{ type: "text", text: "Loading…" }],
  failure: [defaultFailure],
  fill: false,
  ...node,
});

interface Preview {
  /** The bodies of every preview read, in order. */
  bodies: Record<string, unknown>[];
  /** Answer the oldest read waiting with these names. */
  answer(names: string[]): Promise<void>;
  /** Make each read wait for `answer`. */
  hold: boolean;
}

async function preview(children: unknown[], start = "/") {
  const waiting: ((response: Response) => void)[] = [];
  const server: Preview = {
    bodies: [],
    hold: false,
    async answer(names) {
      const next = waiting.shift();
      if (!next) throw new Error("no read is waiting");
      next(json({ items: names.map((name) => ({ name })) }));
      await rendered!.settle();
    },
  };
  rendered = await render({
    path: start,
    collections: { "/api/todos": todos },
    answers: {
      "/api/preview": ({ init }: { init?: RequestInit }) => {
        server.bodies.push(JSON.parse(String(init?.body)));
        if (!server.hold) return json({ items: [{ name: "Ada" }] });
        return new Promise<Response>((resolve) => waiting.push(resolve));
      },
    },
    pages: { "/": { title: "Preview", children }, "/other": { title: "Other", children: [previewQuery()] } },
  } as never);
  return server;
}

/** The typing pause, held and ended by the test. */
function holdPauses(): Array<() => void> {
  const pauses: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number) => (ms === 300 ? -pauses.push(run) : realSetTimeout(run, ms))) as typeof setTimeout);
  return pauses;
}

const names = (r: Rendered) => r.parts("table-row").map((row) => row.textContent);
const limit = (r: Rendered) => r.parts("input")[0];

describe("a query following a form", () => {
  it("draws nothing and reads nothing until the form first holds a valid record, then reads once with what it holds", async () => {
    const server = await preview([previewQuery(), previewForm()]);
    expect([server.bodies, rendered!.parts("query"), rendered!.parts("text").filter((text) => text.textContent === "Loading…")]).toEqual([[], [], []]);
    await rendered!.enter(limit(rendered!), "5");
    await rendered!.commit(limit(rendered!), "enter");
    expect(server.bodies).toHaveLength(1);
    expect(Object.keys(server.bodies[0])).toEqual(["period", "columns", "showChart", "limit"]);
    expect(server.bodies[0]).toMatchObject({ columns: "short", showChart: false, limit: 5 });
    expect(names(rendered!)).toEqual(["Ada"]);
  });

  it("reads once at start when the form starts valid, at once for a choice, and after the typing pause for typed text", async () => {
    const pauses = holdPauses();
    const server = await preview([previewForm({ schema: { ...previewSchema, required: ["period", "columns", "showChart"] } }), previewQuery()]);
    expect(server.bodies).toHaveLength(1);
    await rendered!.click(rendered!.part("switch"));
    expect(server.bodies.map((body) => body.showChart)).toEqual([false, true]);
    for (const typed of ["A", "Ad", "Ada"]) await rendered!.enter(rendered!.parts("input")[1], typed);
    expect(server.bodies).toHaveLength(2);
    await act(async () => pauses[pauses.length - 1]());
    await rendered!.settle();
    expect(server.bodies.map((body) => body.name)).toEqual([undefined, undefined, "Ada"]);
  });

  it("draws only the answer to the last request of quick changes, keeping the drawn one while it waits", async () => {
    const server = await preview([previewForm({ schema: { ...previewSchema, required: ["period", "columns", "showChart"] } }), previewQuery()]);
    expect(names(rendered!)).toEqual(["Ada"]);
    server.hold = true;
    for (let press = 0; press < 3; press++) await rendered!.click(rendered!.part("switch"));
    expect([server.bodies.length, names(rendered!)]).toEqual([4, ["Ada"]]);
    // The earlier reads were let go: only the last is answered and drawn.
    await server.answer(["Stale"]);
    expect(names(rendered!)).toEqual(["Ada"]);
    await server.answer(["Stale too"]);
    await server.answer(["Grace"]);
    expect(names(rendered!)).toEqual(["Grace"]);
  });

  it("reads nothing for a record the model refuses, keeps the last preview, and shows the finding on the field", async () => {
    const server = await preview([previewForm(), previewQuery()]);
    await rendered!.enter(limit(rendered!), "5");
    await rendered!.commit(limit(rendered!), "enter");
    await rendered!.enter(limit(rendered!), "0");
    await rendered!.commit(limit(rendered!), "enter");
    expect([server.bodies.length, names(rendered!), rendered!.part("field-error").textContent]).toEqual([1, ["Ada"], "Must be at least 1"]);
  });

  it("reads the same placed above the form, and nothing on a page that does not place the form", async () => {
    const server = await preview([previewQuery(), { type: "columns", children: [previewForm({ schema: { ...previewSchema, required: ["period"] } })] }]);
    expect(server.bodies).toHaveLength(1);
    rendered!.unmount();
    const alone = await preview([], "/other");
    expect([alone.bodies, rendered!.parts("query")]).toEqual([[], []]);
  });

  it("follows one record for a form placed twice: editing either changes both, read once per change", async () => {
    const valid = { schema: { ...previewSchema, required: ["period"] } };
    const server = await preview([previewForm(valid), previewQuery(), previewForm(valid)]);
    expect(server.bodies).toHaveLength(1);
    const [first, second] = rendered!.parts("form");
    await rendered!.click(second.querySelector<HTMLElement>('[data-telo-part="switch"]')!);
    expect(first.querySelector('[data-telo-part="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(server.bodies.map((body) => body.showChart)).toEqual([false, true]);
    await rendered!.click(first.querySelector<HTMLElement>('[data-telo-part="switch"]')!);
    expect(second.querySelector('[data-telo-part="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(server.bodies.map((body) => body.showChart)).toEqual([false, true, false]);
  });

  it("binds form in its own trees only: a query inside it naming no form reads none", async () => {
    const inner = {
      type: "query",
      query: { id: "inner", schema: { type: "object" }, method: "GET", url: address("/api/todos/1"), input: null, query: {}, form: null, reloadOn: [] },
      content: [{ type: "value", value: form("columns"), present: { type: "string" } }],
      loading: [],
      failure: [],
      fill: false,
    };
    await preview([previewForm({ schema: { ...previewSchema, required: ["period"] } }), previewQuery({}, { content: [{ type: "value", value: form("columns"), present: { type: "string" } }, inner] })]);
    expect(rendered!.parts("value").map((value) => value.textContent)).toEqual(["short", ""]);
  });
});

describe("a listing following a form", () => {
  const teamForm = (required: string[]) =>
    formNode("/unused", {
      id: "Test/team",
      schema: { type: "object", required, properties: { status: { type: "string", title: "Status", enum: ["open", "blocked", "done"] } } },
      record: null,
      fields: [{ type: "input", property: "status", label: "Status", control: "options" }],
      state: memoryState(["status"]),
    });
  const following = listingNode({ form: "Test/team", filters: { status: form("status") }, columns: [{ header: "Task", value: { root: "row", path: ["text"] }, present: { type: "string" } }] });
  const reads = (r: Rendered) => r.requests.filter((request) => request.startsWith("GET /api/todos?"));

  it("reads nothing while the form has never held a valid record, then once per settled change, under what it holds", async () => {
    rendered = await render({ path: "/", collections: { "/api/todos": todos }, pages: { "/": { title: "Todos", children: [teamForm(["status"]), following] } } });
    expect(reads(rendered)).toEqual([]);
    await rendered.click(rendered.parts("option")[0]);
    expect(reads(rendered)).toEqual(["GET /api/todos?limit=2&status=open"]);
    await rendered.click(rendered.parts("option")[2]);
    expect(reads(rendered)).toEqual(["GET /api/todos?limit=2&status=open", "GET /api/todos?limit=2&status=done"]);
  });
});
