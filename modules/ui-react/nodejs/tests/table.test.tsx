// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { filtersNode, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const cells = (r: Rendered, column: number) => r.parts("table-row").map((row) => row.children[column].textContent);
const show = (children: unknown[], rows = todos) =>
  render({ path: "/", loadModule: loadFixtureComponents, required: ["text"], collections: { "/api/todos": rows }, pages: { "/": { title: "Todos", children: children as never } } });

describe("a table", () => {
  it("pages forward and back through cursors it keeps, and reports the rows it shows", async () => {
    rendered = await show([tableNode()]);
    expect(cells(rendered, 0)).toEqual(["Write the plan", "Review the plan"]);
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 5");
    expect((rendered.part("pager-prev") as HTMLButtonElement).disabled).toBe(true);
    await rendered.click(rendered.part("pager-next"));
    await rendered.click(rendered.part("pager-next"));
    expect(cells(rendered, 0)).toEqual(["Record the demo"]);
    expect(rendered.part("pager-status").textContent).toBe("5–5 of 5");
    expect((rendered.part("pager-next") as HTMLButtonElement).disabled).toBe(true);
    await rendered.click(rendered.part("pager-prev"));
    expect(cells(rendered, 0)).toEqual(["Ship the renderer", "Write the docs"]);
    expect(rendered.part("pager-status").textContent).toBe("3–4 of 5");
  });

  it("sorts by one column per click, from the first page", async () => {
    rendered = await show([tableNode()]);
    await rendered.click(rendered.part("pager-next"));
    const priority = rendered.parts("table-sort")[1];
    await rendered.click(priority);
    expect(cells(rendered, 1)).toEqual(["1", "2"]);
    expect(rendered.parts("table-header-cell")[1].getAttribute("data-sorted")).toBe("asc");
    await rendered.click(priority);
    expect(cells(rendered, 1)).toEqual(["5", "3"]);
    expect(rendered.parts("table-header-cell")[1].getAttribute("data-sorted")).toBe("desc");
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&sort=-priority");
    expect(rendered.parts("table-header-cell")[3].querySelector("button")).toBeNull();
  });

  it("styles rows and cells by their values, and shows a date as a date", async () => {
    rendered = await show([tableNode()]);
    expect(rendered.parts("table-row").map((row) => row.getAttribute("data-style"))).toEqual(["muted", null]);
    expect(rendered.parts("table-row")[1].children[1].getAttribute("data-style")).toBe("danger");
    expect(rendered.parts("table-row")[0].children[1].getAttribute("data-style")).toBe("strong");
    expect(cells(rendered, 2)).toEqual(["Oct 1, 2026", "Oct 7, 2026"]);
    expect(cells(rendered, 3)).toEqual(["Done", "Open"]);
  });

  it("obeys the filter bar around it and its own fixed filters", async () => {
    rendered = await show([filtersNode(tableNode({ filters: { isDone: false } }))]);
    const [text, priority] = rendered.parts("filter-input");
    const [done, status] = rendered.parts("filter-select");
    await rendered.click(rendered.part("pager-next"));
    await rendered.enter(text, "the");
    await rendered.commit(text, "enter");
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&isDone=false&text.contains=the");
    await rendered.choose(status, "open");
    // The list stays open for a second choice.
    await rendered.choose(status, "blocked");
    await rendered.escape();
    expect(status.textContent).toBe("open, blocked");
    await rendered.enter(priority, "3");
    await rendered.commit(priority, "blur");
    expect(rendered.requests.at(-1)).toBe(
      "GET /api/todos?limit=2&isDone=false&text.contains=the&status.in=open&status.in=blocked&priority.gte=3",
    );
    expect(cells(rendered, 0)).toEqual(["Ship the renderer", "Record the demo"]);
    expect(await rendered.choices(done)).toEqual(["Any", "Yes", "No"]);
    await rendered.enter(text, "nothing like this");
    await rendered.commit(text, "enter");
    expect(rendered.part("table").getAttribute("data-state")).toBe("empty");
    expect(rendered.part("table-empty").textContent).toBe("No rows.");
    await rendered.click(rendered.part("filters-reset"));
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 4");
  });

  it("shows two filters on one property as one labelled range, and sends both ends", async () => {
    rendered = await show([filtersNode(tableNode())]);
    expect(rendered.parts("filter-label").map((label) => label.textContent)).toEqual(["Task", "Done", "Status", "Priority", "Due"]);
    const range = rendered.part("filter-group");
    expect(rendered.parts("filter-caption").map((caption) => caption.textContent)).toEqual(["from", "to"]);
    const [from, to] = [...range.querySelectorAll("input")];
    expect([from.type, from.getAttribute("aria-label"), to.getAttribute("aria-label")]).toEqual(["date", "Due from", "Due to"]);
    await rendered.enter(from, "2026-10-05");
    await rendered.commit(from, "enter");
    await rendered.enter(to, "2026-10-12");
    await rendered.commit(to, "blur");
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&dueOn.gte=2026-10-05&dueOn.lte=2026-10-12");
  });

  it("filters by a yes/no choice, and by none again when Any is chosen", async () => {
    rendered = await show([filtersNode(tableNode())]);
    const done = rendered.parts("filter-select")[0];
    await rendered.choose(done, "No");
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&isDone=false");
    expect(done.textContent).toBe("No");
    await rendered.choose(done, "Any");
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2");
  });

  it("creates through its form, then shows its first page", async () => {
    rendered = await show([tableNode()]);
    await rendered.click(rendered.part("pager-next"));
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(rendered.part("input"), "A new task");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("surface")).toEqual([]);
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 6");
    expect(cells(rendered, 0)).toEqual(["Write the plan", "Review the plan"]);
    expect(rendered.requests.filter((request) => request.startsWith("POST"))).toEqual(["POST /api/todos"]);
  });

  it("edits a row in place, prefilled, with a PUT to the row", async () => {
    rendered = await show([tableNode()]);
    await rendered.click(rendered.parts("row-edit")[1]);
    const task = rendered.part("input") as HTMLInputElement;
    expect(task.value).toBe("Review the plan");
    expect(rendered.part("select").textContent).toBe("open");
    await rendered.enter(task, "Review it twice");
    await rendered.click(rendered.part("submit"));
    // The record is read before it is edited; the row of the list is not what is sent back.
    expect(rendered.requests.filter((request) => request.endsWith("/api/todos/2"))).toEqual(["GET /api/todos/2", "PUT /api/todos/2"]);
    expect(cells(rendered, 0)).toEqual(["Write the plan", "Review it twice"]);
  });

  it("deletes after a confirmation whose action is marked dangerous", async () => {
    rendered = await show([tableNode()]);
    await rendered.click(rendered.parts("row-delete")[0]);
    const confirm = rendered.part("surface").querySelector('[data-telo-part="submit"]') as HTMLElement;
    expect(confirm.getAttribute("data-style")).toBe("danger");
    expect(confirm.parentElement?.getAttribute("data-telo-part")).toBe("form-actions");
    await rendered.click(rendered.part("cancel"));
    expect(rendered.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    await rendered.click(rendered.parts("row-delete")[0]);
    await rendered.click(rendered.part("surface").querySelector('[data-telo-part="submit"]') as HTMLElement);
    expect(rendered.requests).toContain("DELETE /api/todos/1");
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 4");
  });

  it.each([
    [401, "ERR_UI_UNAUTHORIZED", "You are not signed in, or your session has ended."],
    [403, "ERR_UI_FORBIDDEN", "You are not allowed to do this."],
    [500, "ERR_UI_REQUEST_FAILED", "The request failed with status 500: it broke"],
  ])("shows a %i from its collection as its own error node, the page around it intact", async (status, code, message) => {
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Todos", children: [{ type: "text", text: "Above" }, tableNode()] } },
      answers: { "/api/todos": () => new Response(JSON.stringify({ message: "it broke" }), { status }) },
    });
    expect(rendered.part("table").getAttribute("data-state")).toBe("error");
    expect(rendered.part("error-code").textContent).toBe(code);
    expect(rendered.part("error-message").textContent).toBe(message);
    expect(rendered.part("text").textContent).toBe("Above");
    expect(rendered.part("page").getAttribute("data-state")).toBe("idle");
  });

  it("asks once for a typed filter, when it is committed by Enter or by leaving the field", async () => {
    rendered = await show([filtersNode(tableNode())]);
    const text = rendered.parts("filter-input")[0];
    const lists = () => rendered!.requests.filter((request) => request.startsWith("GET /api/todos?")).length;
    const before = lists();
    for (const typed of ["t", "th", "the"]) await rendered.enter(text, typed);
    expect(lists()).toBe(before);
    await rendered.commit(text, "enter");
    expect(lists()).toBe(before + 1);
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&text.contains=the");
    // Leaving the field with nothing new typed asks for nothing.
    await rendered.commit(text, "blur");
    expect(lists()).toBe(before + 1);
    await rendered.enter(text, "plan");
    await rendered.commit(text, "blur");
    expect(lists()).toBe(before + 2);
    expect(rendered.requests.at(-1)).toBe("GET /api/todos?limit=2&text.contains=plan");
  });

  it("keeps a refused delete in its dialog, with the grid and its rows as they were", async () => {
    rendered = await show([tableNode()]);
    rendered.answer("/api/todos/1", () => new Response(JSON.stringify({ message: "It is referenced." }), { status: 409 }));
    await rendered.click(rendered.parts("row-delete")[0]);
    await rendered.click(rendered.part("surface").querySelector('[data-telo-part="submit"]') as HTMLElement);
    const dialog = rendered.part("surface");
    expect(dialog.querySelector('[data-telo-part="error-code"]')?.textContent).toBe("ERR_UI_REQUEST_FAILED");
    expect(dialog.querySelector('[data-telo-part="error-message"]')?.textContent).toContain("It is referenced.");
    expect(rendered.part("table").getAttribute("data-state")).toBe("idle");
    expect(cells(rendered, 0)).toEqual(["Write the plan", "Review the plan"]);
    await rendered.click(rendered.part("cancel"));
    expect(rendered.parts("surface")).toEqual([]);
    expect(rendered.parts("error")).toEqual([]);
  });
});
