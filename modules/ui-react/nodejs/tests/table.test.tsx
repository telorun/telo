// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import archiveRequest from "../../tests/__fixtures__/action/archive-request.json" with { type: "json" };
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { filtersNode, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const cells = (r: Rendered, column: number) => r.parts("table-row").map((row) => row.children[column].textContent);
const show = (children: unknown[], rows = todos) =>
  render({ path: "/", loadModule: loadFixtureComponents, required: ["text"], collections: { "/api/todos": rows }, pages: { "/": { title: "Todos", children: children as never } } });

const row = (...path: string[]) => ({ root: "row", path });
const archive = { path: "/api/todos/archive", label: "Archive", inputs: { id: row("id"), status: { value: "archived" }, reason: row("reason") } };
const rename = { path: "/api/todos/rename", label: "Rename", inputs: { text: row("text") }, confirm: "Rename this task?" };
/** A table whose rows offer two operations, and nothing else unless told. */
const acting = (overrides: Record<string, unknown> = {}) => tableNode({ rowActions: [archive, rename], create: undefined, edit: undefined, delete: false, ...overrides });
/** A table whose one row holds an address, in an application of two pages. */
const linked = (url: string, prefix: string) =>
  render({
    path: "/",
    prefix,
    collections: { "/api/todos": [{ id: 1, text: "Write the plan", url }] },
    pages: {
      "/": { title: "Todos", children: [tableNode({ rowStyle: undefined, columns: [{ header: "File", value: row("url"), present: { type: "string", format: "uri-reference" } }] })] },
      "/reports": { title: "Reports", children: [] },
    },
  });
const lists = (r: Rendered) => r.requests.filter((request) => request.startsWith("GET /api/todos?"));
const confirmation = () => document.querySelector<HTMLElement>('[data-surface="confirmation"]');
const confirming = () => confirmation()?.querySelector<HTMLButtonElement>('[data-telo-part="submit"]') as HTMLButtonElement;

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

  it.each([
    ["/files/a.pdf", "/admin/files/a.pdf"],
    ["https://example.com/a", "https://example.com/a"],
    ["mailto:ada@example.com", "mailto:ada@example.com"],
    ["//host/x", undefined],
    ["javascript:alert(1)", undefined],
    ["/files/\ta.pdf", undefined],
    ["files/a.pdf", undefined],
  ])("shows %j, in a column the model calls an address, as a link only where a link may hold it", async (url, href) => {
    rendered = await render({
      path: "/",
      prefix: "/admin",
      collections: { "/api/todos": [{ id: 1, text: "Write the plan", url }] },
      pages: { "/": { title: "Todos", children: [tableNode({ rowStyle: undefined, columns: [{ header: "Task", value: row("text"), present: { type: "string" } }, { header: "File", value: row("url"), present: { type: "string", format: "uri" } }] })] } },
    });
    const [task, file] = [...rendered.part("table-row").children];
    expect(file.textContent).toBe(url);
    // None of these is a page of the application, so each opens beside it.
    expect([...file.querySelectorAll("a")].map((link) => [link.getAttribute("data-telo-part"), link.getAttribute("href"), link.textContent, link.getAttribute("target"), link.getAttribute("rel")])).toEqual(
      href === undefined ? [] : [["link", href, url, "_blank", "noopener"]],
    );
    // A value the model does not call an address is never a link.
    expect(task.querySelector("a")).toBeNull();
  });

  it.each(["/admin", ""])("leaves a click on a cell's link to a file under the mount %j to the browser", async (prefix) => {
    rendered = await linked("/files/a.pdf", prefix);
    const link = rendered.part("link");
    expect(link.getAttribute("href")).toBe(`${prefix}/files/a.pdf`);
    expect(await rendered.click(link)).toBe(false);
    expect(window.location.pathname).toBe(`${prefix}/`);
    expect(rendered.part("page-title").textContent).toBe("Todos");
  });

  it("moves within the application on a cell's link to one of its pages", async () => {
    rendered = await linked("/reports", "/admin");
    const link = rendered.part("link");
    expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["/admin/reports", null, null]);
    expect(await rendered.click(link)).toBe(true);
    expect(window.location.pathname).toBe("/admin/reports");
    expect(rendered.part("page-title").textContent).toBe("Reports");
    expect(rendered.reloads).toBe(0);
  });

  it("offers each row's operations as labelled buttons in the order declared, before edit and delete", async () => {
    rendered = await show([acting({ edit: tableNode().edit, delete: true })]);
    const actions = rendered.part("row-actions");
    expect([...actions.children].map((button) => [button.getAttribute("data-telo-part"), button.textContent])).toEqual([
      ["row-action", "Archive"],
      ["row-action", "Rename"],
      ["row-edit", ""],
      ["row-delete", ""],
    ]);
    rendered.unmount();
    // Operations alone are enough for the column.
    rendered = await show([acting()]);
    expect(rendered.parts("row-actions")).toHaveLength(2);
    expect(rendered.parts("table-header-cell")).toHaveLength(5);
  });

  it("sends a row's operation at once with what it binds of the row, then reloads every table over the collection where it was", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show([acting(), acting()]);
    rendered.answer("/api/todos/archive", () => new Promise<Response>((resolve) => (finish = resolve)));
    await rendered.click(rendered.parts("pager-next")[1]);
    const before = lists(rendered).length;
    // The second row of the first table.
    const pressedButton = rendered.parts("row-action").filter((button) => button.textContent === "Archive")[1];
    await rendered.click(pressedButton);
    // `reason` names nothing in the row, so it is left out.
    expect(rendered.sent).toEqual([{ request: "POST /api/todos/archive", contentType: "application/json", body: archiveRequest }]);
    expect([pressedButton.getAttribute("data-state"), (pressedButton as HTMLButtonElement).disabled]).toEqual(["submitting", true]);
    expect(rendered.parts("row-action").filter((button) => button.hasAttribute("data-state"))).toEqual([pressedButton]);
    expect(confirmation()).toBeNull();
    // The body of a success is not read.
    finish(new Response("done", { status: 200 }));
    await rendered.settle();
    expect(pressedButton.getAttribute("data-state")).toBeNull();
    expect(lists(rendered).slice(before)).toHaveLength(2);
    expect(rendered.parts("pager-status").map((status) => status.textContent)).toEqual(["1–2 of 5", "3–4 of 5"]);
    expect(rendered.parts("error")).toEqual([]);
  });

  it("sends one row write at a time: while a row's operation is in flight every operation and delete of the table waits", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show([acting({ delete: true })]);
    const held = () => new Promise<Response>((resolve) => (finish = resolve));
    const writes = () => [...rendered!.parts("row-action"), ...rendered!.parts("row-delete")] as HTMLButtonElement[];
    const archives = () => rendered!.parts("row-action").filter((button) => button.textContent === "Archive");
    const submitting = () => rendered!.parts("row-action").filter((button) => button.getAttribute("data-state") === "submitting");
    const before = lists(rendered).length;

    rendered.answer("/api/todos/archive", held);
    // Two presses before anything is drawn again: the second finds no disabled
    // button to stop it, and still sends nothing.
    const [first, second] = archives();
    await act(async () => {
      for (const button of [first, second]) button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(rendered.sent).toHaveLength(1);
    expect(writes().map((button) => button.disabled)).toEqual([true, true, true, true, true, true]);
    expect(submitting()).toEqual([archives()[0]]);
    await rendered.click(archives()[1]);
    expect(rendered.sent).toHaveLength(1);
    finish(new Response(null, { status: 204 }));
    await rendered.settle();
    expect(writes().map((button) => button.disabled)).toEqual([false, false, false, false, false, false]);
    expect(lists(rendered)).toHaveLength(before + 1);

    await rendered.click(archives()[0]);
    await rendered.click(archives()[1]);
    expect(rendered.sent).toHaveLength(2);
    finish(new Response(JSON.stringify({ message: "It is referenced." }), { status: 409 }));
    await rendered.settle();
    expect(confirmation()?.querySelector('[data-telo-part="error-message"]')?.textContent).toBe("The request failed with status 409: It is referenced.");
    // Both requests were the first row's; the second row's press sent nothing.
    expect(rendered.sent.map((each) => each.body)).toEqual([{ id: 1, status: "archived" }, { id: 1, status: "archived" }]);
    expect(lists(rendered)).toHaveLength(before + 1);
    expect([writes().map((button) => button.disabled).includes(true), submitting()]).toEqual([false, []]);
  });

  it("asks a row operation's question first, in a confirmation whose button is the operation, and closes it once it is done", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show([acting()]);
    rendered.answer("/api/todos/rename", () => new Promise<Response>((resolve) => (finish = resolve)));
    await rendered.click(rendered.parts("row-action")[1]);
    expect(confirmation()?.querySelector('[data-telo-part="surface-title"]')?.textContent).toBe("Rename this task?");
    expect([confirming().textContent, confirming().getAttribute("data-style")]).toEqual(["Rename", null]);
    expect(rendered.sent).toEqual([]);
    await rendered.click(confirming());
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([["POST /api/todos/rename", { text: "Write the plan" }]]);
    expect(confirming().disabled).toBe(true);
    const before = lists(rendered).length;
    finish(new Response(null, { status: 204 }));
    await rendered.settle();
    expect(confirmation()).toBeNull();
    expect(lists(rendered)).toHaveLength(before + 1);
  });

  it("does not send an operation whose question is declined", async () => {
    rendered = await show([acting()]);
    await rendered.click(rendered.parts("row-action")[1]);
    await rendered.click(rendered.part("cancel"));
    expect(confirmation()).toBeNull();
    expect(rendered.sent).toEqual([]);
  });

  it.each([
    ["a 401", () => new Response(null, { status: 401 }), "ERR_UI_UNAUTHORIZED", "You are not signed in, or your session has ended."],
    ["a 403", () => new Response(null, { status: 403 }), "ERR_UI_FORBIDDEN", "You are not allowed to do this."],
    ["a 409", () => new Response(JSON.stringify({ message: "It is referenced." }), { status: 409 }), "ERR_UI_REQUEST_FAILED", "The request failed with status 409: It is referenced."],
    [
      "no answer at all",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "ERR_UI_REQUEST_FAILED",
      "The request failed: Failed to fetch",
    ],
    [
      "a 400",
      () => new Response(JSON.stringify({ error: "ValidationError", message: "Request validation failed", details: [{ location: "body", path: "id", message: "must be integer" }, { location: "body", path: "status", message: "is not allowed" }] }), { status: 400 }),
      "ERR_UI_REQUEST_FAILED",
      "The request was refused: id must be integer status is not allowed",
    ],
  ])("shows %s to a row operation in a confirmation that opens for it, reloads nothing, and sends it again on confirm", async (name, respond, code, message) => {
    rendered = await show([acting()]);
    rendered.answer("/api/todos/archive", respond);
    const before = lists(rendered).length;
    await rendered.click(rendered.parts("row-action")[0]);
    const dialog = confirmation() as HTMLElement;
    expect(dialog.querySelector('[data-telo-part="surface-title"]')?.textContent).toBe("Archive");
    expect([dialog.querySelector('[data-telo-part="error-code"]')?.textContent, dialog.querySelector('[data-telo-part="error-message"]')?.textContent]).toEqual([code, message]);
    expect(confirming().textContent).toBe("Archive");
    expect(lists(rendered)).toHaveLength(before);
    expect(rendered.part("table").getAttribute("data-state")).toBe("idle");
    rendered.answer("/api/todos/archive", () => new Response(null, { status: 204 }));
    await rendered.click(confirming());
    expect(rendered.sent.map((each) => each.request)).toEqual(["POST /api/todos/archive", "POST /api/todos/archive"]);
    expect(confirmation()).toBeNull();
    expect(lists(rendered)).toHaveLength(before + 1);
  });

  it("dismisses a refused row operation when its confirmation is closed", async () => {
    rendered = await show([acting()]);
    rendered.answer("/api/todos/archive", () => new Response(null, { status: 500 }));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(rendered.part("cancel"));
    expect(confirmation()).toBeNull();
    expect(rendered.parts("error")).toEqual([]);
    expect(rendered.sent).toHaveLength(1);
  });
});
