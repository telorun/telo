// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";
import { dialogSurface, memoryState, operation, opener, tableNode } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  localStorage.clear();
});

const people = [
  { id: "p1", name: "Ada", team: "red" },
  { id: "p2", name: "Alan", team: "red" },
  { id: "p3", name: "Grace", team: "blue" },
  { id: "p4", name: "Edsger", team: "blue" },
  { id: "p5", name: "Barbara", team: "blue" },
];

const source = (overrides: Record<string, unknown> = {}) => ({
  type: "collection",
  schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, team: { type: "string" } } },
  value: { root: "row", path: ["id"] },
  label: { root: "row", path: ["name"] },
  basePath: "/api/people",
  filters: {},
  pageSize: 2,
  search: { property: "name", operator: "contains" },
  ...overrides,
});

const taskSchema = {
  type: "object",
  properties: {
    month: { type: "string", title: "Month", minLength: 7 },
    team: { type: "string", title: "Team" },
    owners: { type: "array", title: "Owners", items: { type: "string" } },
    watchers: { type: "array", title: "Watchers", items: { type: "string" } },
    period: { type: "object", title: "Period", properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
  },
};

const input = (property: string, label: string) => ({ type: "input", property, label, control: "auto" });
const picker = (overrides: Record<string, unknown> = {}) => ({
  type: "picker",
  property: "watchers",
  label: "Watchers",
  options: source(),
  surface: dialogSurface,
  ...overrides,
});

/** An action whose form shows `fields`, posted to /api/tasks. */
const action = (fields: Record<string, unknown>[], overrides: Record<string, unknown> = {}) =>
  operation("/api/tasks", "Send", taskSchema, { fields, state: memoryState(fields.map((field) => field.property as string)), ...overrides });

const show = (children: Record<string, unknown>[], answers?: Record<string, () => Response>, path = "/") =>
  render({ path, collections: { "/api/people": people }, answers, pages: { "/": { title: "Tasks", children: children as never } } });

const peopleRequests = () => rendered!.requests.filter((request) => request.startsWith("GET /api/people"));

describe("a picker", () => {
  it("reads one page per scroll to the end of its list, however often it is scrolled", async () => {
    rendered = await show([action([picker()])]);
    expect(peopleRequests()).toEqual([]);
    await rendered.click(rendered.part("picker-trigger"));
    expect(peopleRequests()).toEqual(["GET /api/people?limit=2"]);
    const list = rendered.part("picker-list");
    await act(async () => {
      for (let turn = 0; turn < 3; turn++) list.dispatchEvent(new Event("scroll"));
    });
    await rendered.settle();
    expect(peopleRequests()).toHaveLength(2);
    expect(rendered.parts("picker-option").map((option) => option.textContent)).toEqual(["Ada", "Alan", "Grace", "Edsger"]);
    await act(async () => list.dispatchEvent(new Event("scroll")));
    await rendered.settle();
    expect(peopleRequests()).toHaveLength(3);
  });

  it("discards the answer to an older search", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    rendered = await show([action([picker()])]);
    const platform = globalThis.fetch;
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      if (String(request).includes("name.contains=A")) await held;
      return platform(request, init);
    }) as typeof fetch;
    await rendered.click(rendered.part("picker-trigger"));
    const search = rendered.part("picker-search");
    await rendered.enter(search, "A");
    await rendered.commit(search, "enter");
    await rendered.enter(search, "Gr");
    await rendered.commit(search, "enter");
    expect(rendered.parts("picker-option").map((option) => option.textContent)).toEqual(["Grace"]);
    release();
    await rendered.settle();
    expect(rendered.parts("picker-option").map((option) => option.textContent)).toEqual(["Grace"]);
  });

  it("labels the values an edited record holds with one lookup, and shows each", async () => {
    const form = {
      type: "form",
      schema: taskSchema,
      basePath: "/api/tasks",
      fields: [picker({ options: source({ pageSize: 25 }) })],
      groups: [],
      state: memoryState(["watchers"]),
    };
    rendered = await render({
      path: "/",
      collections: { "/api/people": people, "/api/tasks": [{ id: 1, text: "Plan", watchers: ["p1", "p3", "p5"] }] },
      pages: { "/": { title: "Tasks", children: [tableNode({ basePath: "/api/tasks", columns: [], edit: opener({ form }) })] } },
    });
    await rendered.click(rendered.part("row-edit"));
    expect(peopleRequests()).toEqual(["GET /api/people?limit=25&id.in=p1&id.in=p3&id.in=p5"]);
    expect(rendered.parts("picker-chosen").map((chosen) => chosen.textContent)).toEqual(["Ada", "Grace", "Barbara"]);
  });
});

describe("an option source under a mount", () => {
  it("reads its pages and labels chosen values under the mount", async () => {
    const form = { type: "form", schema: taskSchema, basePath: "/api/tasks", fields: [picker()], groups: [], state: memoryState(["watchers"]) };
    rendered = await render({
      path: "/",
      prefix: "/admin",
      collections: { "/api/people": people, "/api/tasks": [{ id: 1, text: "Plan", watchers: ["p5"] }] },
      pages: { "/": { title: "Tasks", children: [tableNode({ basePath: "/api/tasks", columns: [], edit: opener({ form }) })] } },
    });
    await rendered.click(rendered.part("row-edit"));
    await rendered.click(rendered.part("picker-trigger"));
    expect(rendered.requests.filter((request) => request.includes("/api/people"))).toEqual(["GET /admin/api/people?limit=2&id.in=p5", "GET /admin/api/people?limit=2"]);
    expect(rendered.parts("picker-chosen").map((chosen) => chosen.textContent)).toEqual(["Barbara"]);
  });
});

describe("an option source reading the form's values", () => {
  const owners = {
    type: "choice",
    property: "owners",
    label: "Owners",
    control: "options",
    options: source({ filters: { team: { root: "values", path: ["team"] } }, pageSize: 10 }),
  };

  it("reads nothing and offers nothing while a value it reads is absent", async () => {
    rendered = await show([action([input("team", "Team"), owners])]);
    expect(peopleRequests()).toEqual([]);
    expect(rendered.parts("option")).toEqual([]);
    await rendered.enter(rendered.part("input"), "red");
    expect(peopleRequests()).toEqual(["GET /api/people?limit=10&team=red"]);
    expect(rendered.parts("option").map((option) => option.textContent)).toEqual(["Ada", "Alan"]);
  });

  it("keeps the chosen values a changed filter still offers, and drops the rest", async () => {
    // A person of two teams: the fake reads one team per row, so the second is answered here.
    rendered = await show([action([input("team", "Team"), owners])]);
    const platform = globalThis.fetch;
    const answered: string[] = [];
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), window.location.href);
      if (url.pathname === "/api/people") answered.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/people" && url.searchParams.get("team") === "warm") {
        const ids = url.searchParams.getAll("id.in");
        const warm = [people[0], people[2]].filter((person) => ids.length === 0 || ids.includes(person.id));
        return new Response(JSON.stringify({ rows: warm, total: warm.length, next: null }), { headers: { "content-type": "application/json" } });
      }
      return platform(request, init);
    }) as typeof fetch;
    await rendered.enter(rendered.part("input"), "red");
    for (const option of rendered.parts("option")) await rendered.click(option);
    await rendered.enter(rendered.part("input"), "warm");
    expect(answered).toContain("/api/people?limit=10&team=warm&id.in=p1&id.in=p2");
    await rendered.click(rendered.part("submit"));
    expect(rendered.sent.at(-1)?.body).toEqual({ team: "warm", owners: ["p1"] });
  });
});

describe("a form's values", () => {
  it("are kept in the declared store and read back after a reload", async () => {
    const state = { key: "report", address: true, store: { type: "local" }, fields: ["month"] };
    const node = action([input("month", "Month")], { state });
    rendered = await show([node]);
    await rendered.enter(rendered.part("input"), "2026-05");
    expect(JSON.parse(localStorage.getItem("telo.ui:/:v:report")!)).toEqual({ v: 1, values: { month: "2026-05" } });
    expect(new URLSearchParams(window.location.search).get("_telo.v.report.month")).toBe('"2026-05"');
    rendered.unmount();
    rendered = await show([node]);
    expect((rendered.part("input") as HTMLInputElement).value).toBe("2026-05");
  });
});

describe("live validation", () => {
  it("reports a field's own finding once it is touched, then the server's issue on that field", async () => {
    rendered = await show([action([input("month", "Month")])], {
      "/api/tasks": () =>
        new Response(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues: [{ pointer: "/body/month", keyword: "pattern", params: { pattern: "^[0-9]{4}-[0-9]{2}$" } }] } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(rendered.parts("field-error")).toEqual([]);
    await rendered.enter(rendered.part("input"), "20");
    expect(rendered.part("field-error").textContent).toBe("Must be at least 7 characters");
    await rendered.enter(rendered.part("input"), "2026-05");
    expect(rendered.parts("field-error")).toEqual([]);
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("field-error").textContent).toBe("Is not in the expected format");
  });

  it("lands an issue about a member of a property on the field entering it", async () => {
    const range = { type: "dateRange", property: "period", label: "Period", presets: [], weekStart: "monday" };
    rendered = await show([action([range])], {
      "/api/tasks": () =>
        new Response(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues: [{ pointer: "/body/period/from", keyword: "format", params: { format: "date" } }] } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    await rendered.enter(rendered.part("date-range-from"), "2026-01-02");
    await rendered.enter(rendered.part("date-range-to"), "2026-01-01");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("field-error").textContent).toBe("Must not start after it ends");
    expect(rendered.requests.some((request) => request.startsWith("POST"))).toBe(false);
    await rendered.enter(rendered.part("date-range-to"), "2026-01-31");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("field-error").textContent).toBe("Is not a valid date");
    expect(rendered.parts("form-error")).toEqual([]);
  });
});
