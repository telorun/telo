// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import contract from "../src/contract/parts.json" with { type: "json" };
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { actionNode, component, dataNode, filterField, filtersNode, opener, operation, tableNode, todos } from "./spec-nodes.js";

const listed = Object.values(contract.parts).flat();
let rendered: Rendered | undefined;

/** Two bars that between them draw every part a filter policy adds. */
const policyBars = () => [
  filtersNode(tableNode(), {
    show: "chosen",
    placement: { type: "collapsible", open: true },
    apply: "button",
    summary: "chips",
    presets: [{ label: "Open", values: [{ property: "status", operator: "in", value: ["open"] }] }],
    fields: [
      filterField("status", "in", { control: "options", default: ["open"] }),
      filterField("isDone", "eq", { control: "toggle", default: [true] }),
      filterField("priority", "gte", { control: "slider", default: [2] }),
      filterField("text", "in", { control: "tags", default: ["plan"] }),
      filterField("dueOn", "gte"),
    ],
  }),
  filtersNode(tableNode(), { controls: "chips", fields: [filterField("isDone", "eq", { default: [false] })] }),
];
afterEach(() => rendered?.unmount());

const emitted = () => new Set([...document.querySelectorAll("[data-telo-part]")].map((element) => element.getAttribute("data-telo-part") as string));

describe("the styling contract", () => {
  it("is emitted whole, and nothing outside it is", async () => {
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos, "/api/empty": [] },
      pages: {
        "/": {
          title: "Everything",
          children: [
            { type: "stack", style: ["strong"], children: [{ type: "text", text: "Heading", style: "heading" }, { type: "badge", text: "New" }] },
            { type: "columns", children: [{ type: "box", children: [{ type: "link", text: "Docs", href: "/docs" }] }, { type: "image", src: "/logo.png", alt: "" }] },
            { type: "svg", markup: "<svg xmlns='http://www.w3.org/2000/svg'/>", alt: "Chart" },
            filtersNode(tableNode()),
            ...policyBars(),
            tableNode({ basePath: "/api/empty" }),
            component("Counter", { step: { value: 1 } }),
            { type: "error", code: "ERR_EXAMPLE", message: "An error node." },
          ],
        },
      },
    });
    const seen = emitted();
    // The list of filters to add is drawn while it is open.
    await rendered.open(rendered.part("filters-add"));
    for (const part of emitted()) seen.add(part);
    await rendered.escape();
    // Open each dialog, and refuse a submission, to reach the parts they hold.
    await rendered.click(rendered.part("table-create"));
    for (const part of emitted()) seen.add(part);
    await rendered.click(rendered.part("submit"));
    for (const part of emitted()) seen.add(part);
    rendered.answer("/api/todos", () => new Response(JSON.stringify({ details: [{ location: "body", path: "elsewhere", message: "is refused" }] }), { status: 400 }));
    await rendered.enter(rendered.part("input"), "Long enough");
    await rendered.click(rendered.part("submit"));
    for (const part of emitted()) seen.add(part);
    await rendered.open(rendered.part("select"));
    for (const part of emitted()) seen.add(part);
    await rendered.escape();
    // Closing over what was typed asks first, in a confirmation.
    await rendered.click(rendered.part("surface-close"));
    await rendered.click(document.querySelector('[data-surface="confirmation"] [data-telo-part="submit"]') as HTMLElement);
    // The confirmation has parts of its own, and a focused icon button its tooltip.
    await rendered.click(rendered.part("row-delete"));
    for (const part of emitted()) seen.add(part);
    await rendered.click(rendered.part("cancel"));
    await rendered.focus(rendered.part("row-edit"));
    for (const part of emitted()) seen.add(part);
    // A form opened in line is drawn in a cell of its own, under its row.
    rendered.unmount();
    rendered = await render({
      path: "/",
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Inline", children: [tableNode({ columns: [], edit: opener({ surface: { type: "inline" } }) })] } },
    });
    await rendered.click(rendered.part("row-edit"));
    for (const part of emitted()) seen.add(part);
    // An action that has answered, with a typed list item, beside a table whose rows offer an operation.
    rendered.unmount();
    rendered = await render({
      path: "/",
      collections: { "/api/todos": todos },
      answers: { "/api/reports": () => new Response(JSON.stringify({ files: [{ name: "a.pdf", url: "/files/a.pdf" }] }), { status: 200 }) },
      pages: {
        "/": {
          title: "Action",
          children: [actionNode(), tableNode({ columns: [], rowActions: [{ action: operation("/api/todos/archive", "Archive", { type: "object", properties: { id: { type: "integer" } } }), inputs: { id: { root: "row", path: ["id"] } } }] })],
        },
      },
    });
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.enter(rendered.parts("input")[2], "ada@example.com");
    await rendered.commit(rendered.parts("input")[2], "enter");
    await rendered.click(rendered.part("submit"));
    for (const part of emitted()) seen.add(part);
    // An action that failed, beside a table whose rows' operations answered and failed.
    rendered.unmount();
    const id = { type: "object", properties: { id: { type: "integer" } } };
    rendered = await render({
      path: "/",
      collections: { "/api/todos": todos },
      answers: {
        "/api/reports": () => new Response(null, { status: 500 }),
        "/api/todos/archive": () => new Response(null, { status: 204 }),
        "/api/todos/reject": () => new Response(null, { status: 500 }),
      },
      pages: {
        "/": {
          title: "Answers",
          children: [
            actionNode(),
            tableNode({
              columns: [],
              rowActions: [
                { action: operation("/api/todos/archive", "Archive", id, { result: { type: "text", text: "Archived" } }), inputs: { id: { root: "row", path: ["id"] } } },
                { action: operation("/api/todos/reject", "Reject", id), inputs: { id: { root: "row", path: ["id"] } } },
              ],
            }),
          ],
        },
      },
    });
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    await rendered.click(rendered.parts("row-action").find((button) => button.textContent === "Archive") as HTMLElement);
    await rendered.click(rendered.parts("row-action").find((button) => button.textContent === "Reject") as HTMLElement);
    for (const part of emitted()) seen.add(part);
    // A reader that has answered draws its values and a list; an action whose
    // condition does not hold says why its button is disabled.
    rendered.unmount();
    rendered = await render({
      path: "/",
      answers: {
        "/api/account": () =>
          new Response(JSON.stringify({ authorized: true, email: "ada@example.com", files: [{ name: "a.pdf" }] }), { status: 200 }),
      },
      pages: {
        "/": {
          title: "Data",
          children: [
            dataNode(),
            actionNode({ enabled: { at: { root: "values", path: ["month"] }, matches: { minLength: 7 }, disabledText: "Choose a month first." } }),
          ],
        },
      },
    });
    for (const part of emitted()) seen.add(part);
    // Every field kind, in a group, over an option source with hints and links.
    rendered.unmount();
    const people = {
      type: "collection",
      schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, team: { type: "string" }, page: { type: "string" } } },
      value: { root: "row", path: ["id"] },
      label: { root: "row", path: ["name"] },
      hint: { root: "row", path: ["team"] },
      href: { root: "row", path: ["page"] },
      basePath: "/api/people",
      filters: {},
      pageSize: 1,
      search: { property: "name", operator: "contains" },
    };
    const kinds = {
      type: "object",
      properties: {
        urgent: { type: "boolean" },
        effort: { type: "integer", minimum: 1, maximum: 5 },
        owner: { type: "string" },
        watchers: { type: "array", items: { type: "string" } },
        reviewers: { type: "array", items: { type: "string" } },
        period: { type: "object", properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
      },
    };
    rendered = await render({
      path: "/",
      collections: { "/api/people": [{ id: "p1", name: "Ada", team: "red", page: "/people/p1" }, { id: "p2", name: "Alan", team: "red", page: "/people/p2" }], "/api/nobody": [] },
      pages: {
        "/": {
          title: "Fields",
          children: [
            operation("/api/tasks", "Send", kinds, {
              groups: [{ name: "how", label: "How", description: "How it is done." }],
              fields: [
                { type: "input", property: "urgent", label: "Urgent", description: "Drop everything else.", control: "toggle", group: "how" },
                { type: "input", property: "effort", label: "Effort", control: "slider", group: "how" },
                { type: "choice", property: "owner", label: "Owner", control: "options", options: people },
                { type: "picker", property: "watchers", label: "Watchers", options: people, surface: { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } } },
                {
                  type: "picker",
                  property: "reviewers",
                  label: "Reviewers",
                  options: { ...people, basePath: "/api/nobody" },
                  surface: { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } },
                },
                {
                  type: "dateRange",
                  property: "period",
                  label: "Period",
                  presets: [{ label: "Today", unit: "day", offset: 0 }],
                  weekStart: "monday",
                  warnLongerThan: { unit: "day", count: 1 },
                },
              ],
            }),
          ],
        },
      },
    });
    await rendered.enter(rendered.part("date-range-from"), "2026-01-01");
    await rendered.enter(rendered.part("date-range-to"), "2026-01-05");
    await rendered.click(rendered.part("picker-trigger"));
    await rendered.click(rendered.part("picker-option"));
    await rendered.click(rendered.part("picker-trigger"));
    for (const part of emitted()) seen.add(part);
    await rendered.escape();
    // A picker over a source offering nothing says so.
    await rendered.click(rendered.parts("picker-trigger")[1]);
    for (const part of emitted()) seen.add(part);
    // A table whose first page has not arrived shows the loading part.
    rendered.unmount();
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Slow", children: [tableNode()] } },
      answers: { "/api/todos": () => new Promise<Response>(() => {}) },
    });
    for (const part of emitted()) seen.add(part);
    expect([...seen].filter((part) => !listed.includes(part))).toEqual([]);
    expect(listed.filter((part) => !seen.has(part))).toEqual([]);
  });

  it("lists exactly the states the renderer sets", async () => {
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos },
      narrow: true,
      pages: {
        "/": {
          title: "States",
          children: [
            filtersNode(tableNode()),
            // A dialog and a popover between them carry every attribute a surface takes.
            tableNode({ create: opener({ surface: { type: "popover", side: "bottom", align: "start", dismiss: { escape: true, outside: false } } }) }),
            ...policyBars(),
            component("Counter", { step: { value: 1 } }),
            dataNode(),
          ],
        },
        "/other": { title: "Other", children: [] },
      },
    });
    await rendered.click(rendered.parts("table-sort")[0]);
    // Text typed and not yet committed leaves its bar pending.
    await rendered.enter(rendered.part("filter-input"), "the");
    await rendered.click(rendered.parts("table-create")[1]);
    await rendered.click(rendered.parts("table-create")[0]);
    await rendered.click(rendered.part("submit"));
    await rendered.enter(rendered.part("input"), "x");
    await rendered.open(rendered.part("select"));
    for (const [attribute, { values, on }] of Object.entries(contract.states)) {
      const carriers = [...document.querySelectorAll(`[${attribute}]`)].filter((carrier) => on.includes(carrier.getAttribute("data-telo-part") as string));
      expect(carriers.length, attribute).toBeGreaterThan(0);
      for (const carrier of carriers) expect(values, attribute).toContain(carrier.getAttribute(attribute));
    }
    // Every other carrier is a primitive's, with the primitive's own values.
    const stated = [...document.querySelectorAll("[data-state]")].filter((carrier) => !contract.states["data-state"].on.includes(carrier.getAttribute("data-telo-part") as string));
    expect(stated.length).toBeGreaterThan(0);
    for (const carrier of stated) {
      const part = carrier.getAttribute("data-telo-part");
      const primitive = contract.primitiveStates.find((entry) => entry.on.includes(part as string));
      expect(primitive, `data-state on '${part}'`).toBeDefined();
      expect(primitive?.values).toContain(carrier.getAttribute("data-state"));
    }
    for (const attribute of ["data-invalid", "data-sorted", "data-current", "data-dirty", "data-compact", "data-surface", "data-modal", "data-placement", "data-active", "data-pending"] as const) {
      for (const carrier of document.querySelectorAll(`[${attribute}]`)) expect(contract.states[attribute].on, attribute).toContain(carrier.getAttribute("data-telo-part"));
    }
  });
});
