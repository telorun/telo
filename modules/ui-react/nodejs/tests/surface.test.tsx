// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixtureComponents, render, type Page, type Rendered } from "./harness.js";
import { component, dialogSurface, opener, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const dismissAll = { escape: true, outside: true, closeButton: true };
const drawer = (side: string) => ({ type: "drawer", side, size: "large", modal: true, dismiss: dismissAll });
const popover = { type: "popover", side: "top", align: "end", dismiss: { escape: true, outside: true } };
const panel = (side = "end") => ({ type: "panel", side, size: "small", dismiss: { escape: true, closeButton: true } });
const named = (surface: Record<string, unknown>, name = "todo") => ({ ...surface, address: { name } });
const probe = component("HostProbe", { basePath: { value: "/api/todos" } });

/** A page holding a table whose two forms open in `surface`, beside whatever else it is given. */
const show = (
  surface: Record<string, unknown>,
  options: { more?: Page["children"]; path?: string; narrow?: boolean; rows?: Record<string, unknown>[]; table?: Record<string, unknown>; opens?: Record<string, unknown> } = {},
) =>
  render({
    path: options.path ?? "/",
    narrow: options.narrow,
    loadModule: loadFixtureComponents,
    required: ["text"],
    collections: { "/api/todos": options.rows ?? todos },
    pages: {
      "/": {
        title: "Todos",
        children: [
          ...(options.more ?? []),
          tableNode({ create: opener({ surface, ...options.opens }), edit: opener({ surface, ...options.opens }), ...options.table }),
        ],
      },
      "/done": { title: "Done", children: [{ type: "text", text: "The done page" }] },
    },
  });

const surface = (r: Rendered) => r.parts("surface").find((part) => part.getAttribute("data-surface") !== "confirmation");
const question = (r: Rendered) => r.parts("surface").find((part) => part.getAttribute("data-surface") === "confirmation");
const answer = (r: Rendered, part: "submit" | "cancel") => r.click(question(r)!.querySelector(`[data-telo-part="${part}"]`)!);
const task = (r: Rendered) => surface(r)!.querySelector('[data-telo-part="input"]') as HTMLInputElement;
const within = (r: Rendered, part: string) => surface(r)!.querySelector(`[data-telo-part="${part}"]`) as HTMLElement;
const sent = (r: Rendered, method: string) => r.requests.filter((request) => request.startsWith(method));
const position = () => (window.history.state as { teloPosition: number }).teloPosition;
const where = () => [window.location.search, position()];

/** Two tables on one page, each opening its forms in a panel under a name of its own. */
const twoPanels = () =>
  render({
    path: "/",
    loadModule: loadFixtureComponents,
    collections: { "/api/todos": todos },
    pages: {
      "/": {
        title: "Todos",
        children: ["a", "b"].map((name) => tableNode({ create: opener({ surface: named(panel(), name) }), edit: opener({ surface: named(panel(), name) }) })),
      },
    },
  });
const tasks = (r: Rendered) => r.parts("surface").map((part) => (part.querySelector('[data-telo-part="input"]') as HTMLInputElement).value);

describe("a dialog", () => {
  it("is named by its title, holds the focus, and closes on Escape, its close button or Cancel with nothing sent", async () => {
    rendered = await show(dialogSurface);
    await rendered.click(rendered.part("table-create"));
    const dialog = surface(rendered)!;
    expect(["data-surface", "data-size", "data-modal", "role"].map((name) => dialog.getAttribute(name))).toEqual(["dialog", "medium", "true", "dialog"]);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") as string)?.textContent).toBe("New");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(rendered.parts("surface-overlay").length).toBe(1);
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.parts("row-edit")[0]);
    expect(rendered.part("surface-title").textContent).toBe("Edit");
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.part("table-create"));
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
    expect([...sent(rendered, "POST"), ...sent(rendered, "PUT")]).toEqual([]);
  });

  it("stays open through each way of dismissing that is switched off, and has no close button", async () => {
    rendered = await show({ ...dialogSurface, size: "full", dismiss: { escape: false, outside: false, closeButton: false } });
    await rendered.click(rendered.part("table-create"));
    expect(surface(rendered)!.getAttribute("data-size")).toBe("full");
    expect(rendered.parts("surface-close")).toEqual([]);
    await rendered.escape();
    await rendered.pointerDown(rendered.part("surface-overlay"));
    expect(surface(rendered)).toBeDefined();
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("leaves the page uncovered when it is not modal, and closes on a press outside it", async () => {
    rendered = await show({ ...dialogSurface, modal: false }, { opens: { unsaved: "discard" } });
    await rendered.click(rendered.part("table-create"));
    expect(surface(rendered)!.getAttribute("data-modal")).toBe("false");
    expect(rendered.parts("surface-overlay")).toEqual([]);
    expect(rendered.container.getAttribute("aria-hidden")).toBeNull();
    // A list its form opens is drawn elsewhere, and is still inside it.
    await rendered.focus(task(rendered));
    await rendered.choose(within(rendered, "select"), "blocked");
    expect([surface(rendered) !== undefined, within(rendered, "select").textContent]).toEqual([true, "blocked"]);
    await rendered.pointerDown(rendered.part("page-title"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("cannot be dismissed while its form is being sent", async () => {
    rendered = await show(dialogSurface);
    let respond: (response: Response) => void = () => {};
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "A slow task");
    rendered.answer("/api/todos", () => new Promise<Response>((resolve) => (respond = resolve)));
    await rendered.click(within(rendered, "submit"));
    expect((within(rendered, "cancel") as HTMLButtonElement).disabled).toBe(true);
    await rendered.escape();
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeDefined();
    respond(new Response(JSON.stringify({ id: 9, text: "A slow task" }), { status: 201 }));
    await rendered.settle();
    expect(surface(rendered)).toBeUndefined();
  });
});

describe("a drawer", () => {
  it.each(["start", "end", "top", "bottom"])("slides in from the %s edge, and closes once its form is saved", async (side) => {
    rendered = await show(drawer(side));
    await rendered.click(rendered.part("table-create"));
    const sheet = surface(rendered)!;
    expect(["data-surface", "data-side", "data-size", "data-modal"].map((name) => sheet.getAttribute(name))).toEqual(["drawer", side, "large", "true"]);
    await rendered.enter(task(rendered), "From a drawer");
    await rendered.click(within(rendered, "submit"));
    expect(surface(rendered)).toBeUndefined();
    expect(sent(rendered, "POST")).toEqual(["POST /api/todos"]);
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
  });
});

describe("a popover", () => {
  it("opens beside the control that opened it, saves, and closes on Escape unless that is switched off", async () => {
    rendered = await show(popover);
    await rendered.click(rendered.parts("row-edit")[1]);
    const card = surface(rendered)!;
    expect(["data-surface", "data-side", "data-align"].map((name) => card.getAttribute(name))).toEqual(["popover", "top", "end"]);
    expect(document.getElementById(card.getAttribute("aria-labelledby") as string)?.textContent).toBe("Edit");
    await rendered.enter(task(rendered), "Review it twice");
    await rendered.click(within(rendered, "submit"));
    expect(surface(rendered)).toBeUndefined();
    expect(sent(rendered, "PUT")).toEqual(["PUT /api/todos/2"]);
    await rendered.click(rendered.part("table-create"));
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    rendered.unmount();
    rendered = await show({ ...popover, dismiss: { escape: false, outside: false } });
    await rendered.click(rendered.part("table-create"));
    await rendered.escape();
    await rendered.pointerDown(rendered.part("page-title"));
    expect(surface(rendered)).toBeDefined();
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
  });
});

describe("an inline surface", () => {
  it("draws the create form above the grid and the edit form under its row", async () => {
    rendered = await show({ type: "inline" });
    await rendered.click(rendered.part("table-create"));
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("inline");
    expect(surface(rendered)!.nextElementSibling).toBe(rendered.part("table-main"));
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.parts("row-edit")[1]);
    const detail = rendered.part("table-detail");
    expect(detail.contains(surface(rendered)!)).toBe(true);
    expect(detail.parentElement?.previousElementSibling).toBe(rendered.parts("table-row")[1]);
    expect(task(rendered).value).toBe("Review the plan");
    await rendered.enter(task(rendered), "Review it in place");
    await rendered.click(within(rendered, "submit"));
    expect(rendered.parts("table-detail")).toEqual([]);
    expect(sent(rendered, "PUT")).toEqual(["PUT /api/todos/2"]);
  });
});

describe("a panel", () => {
  it.each(["start", "end"])("sits at the %s of the list, which stays usable, and closes on Escape or its close button", async (side) => {
    rendered = await show(panel(side));
    await rendered.click(rendered.parts("row-edit")[0]);
    const aside = surface(rendered)!;
    expect(["data-surface", "data-side", "data-size"].map((name) => aside.getAttribute(name))).toEqual(["panel", side, "small"]);
    expect(aside.parentElement).toBe(rendered.part("table"));
    expect(rendered.part("table-main").parentElement).toBe(rendered.part("table"));
    expect(rendered.parts("surface-overlay")).toEqual([]);
    // Another row opens in the same panel.
    await rendered.click(rendered.parts("row-edit")[1]);
    expect(task(rendered).value).toBe("Review the plan");
    await rendered.focus(task(rendered));
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.part("table-create"));
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("stays open on Escape, with no close button, when both are switched off", async () => {
    rendered = await show({ ...panel(), dismiss: { escape: false, closeButton: false } });
    await rendered.click(rendered.part("table-create"));
    await rendered.focus(task(rendered));
    await rendered.escape();
    expect(surface(rendered)).toBeDefined();
    expect(rendered.parts("surface-close")).toEqual([]);
  });
});

describe("a page surface", () => {
  it("replaces the page's content under its address, and gives it back when it closes", async () => {
    rendered = await show({ type: "page", address: { name: "todo" } }, { more: [{ type: "text", text: "Above the table" }] });
    const content = rendered.part("text").parentElement as HTMLElement;
    await rendered.click(rendered.part("table-create"));
    expect(window.location.search).toBe("?_telo.open.todo=");
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("page");
    expect(rendered.part("page").contains(surface(rendered)!)).toBe(true);
    expect(content.style.display).toBe("none");
    expect(rendered.part("page-title").textContent).toBe("Todos");
    await rendered.enter(task(rendered), "From a page");
    await rendered.click(within(rendered, "submit"));
    expect(surface(rendered)).toBeUndefined();
    expect(content.style.display).toBe("contents");
    expect(window.location.search).toBe("");
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 6");
  });
});

describe("what a form does once it is saved", () => {
  it("stays open and empty for another record under `again`, the list reloaded", async () => {
    rendered = await show(panel(), { opens: { afterSubmit: "again" } });
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "The first of two");
    await rendered.click(within(rendered, "submit"));
    expect(task(rendered).value).toBe("");
    expect(within(rendered, "form").getAttribute("data-dirty")).toBeNull();
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 6");
    await rendered.enter(task(rendered), "The second");
    await rendered.click(within(rendered, "submit"));
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 7");
  });

  it("stays open with its values under `keep`, holding nothing unsaved, the list reloaded", async () => {
    rendered = await show(panel(), { opens: { afterSubmit: "keep" } });
    await rendered.click(rendered.parts("row-edit")[1]);
    await rendered.enter(task(rendered), "Review it and stay");
    expect(within(rendered, "form").getAttribute("data-dirty")).toBe("true");
    await rendered.click(within(rendered, "submit"));
    expect(task(rendered).value).toBe("Review it and stay");
    expect(within(rendered, "form").getAttribute("data-dirty")).toBeNull();
    expect(rendered.parts("table-row")[1].children[0].textContent).toBe("Review it and stay");
    // Nothing is unsaved, so leaving asks nothing.
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
  });
});

describe("unsaved input", () => {
  it("holds a component's navigation until the user answers, and drops it when they stay", async () => {
    rendered = await show(panel(), { more: [probe] });
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.fixture("page"));
    expect(window.location.pathname).toBe("/");
    expect(question(rendered)!.getAttribute("role")).toBe("alertdialog");
    await answer(rendered, "cancel");
    expect(question(rendered)).toBeUndefined();
    expect(window.location.pathname).toBe("/");
    expect(task(rendered).value).toBe("Half written");
    await rendered.click(rendered.fixture("anchor"));
    expect(window.location.pathname).toBe("/");
    await answer(rendered, "submit");
    expect(window.location.pathname).toBe("/done");
    expect(rendered.part("text").textContent).toBe("The done page");
  });

  it("asks nothing for a move within the page that keeps the form open", async () => {
    rendered = await show(panel(), { more: [probe] });
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.fixture("query"));
    expect(window.location.search).toBe("?c=2");
    expect(question(rendered)).toBeUndefined();
    expect(task(rendered).value).toBe("Half written");
  });

  it("undoes a step back while it asks, and replays the step the user confirms", async () => {
    rendered = await show(named(dialogSurface), { more: [probe] });
    await rendered.click(rendered.part("table-create"));
    const open = position();
    // A page further on, then back to the open form: there is a forward entry.
    await rendered.click(rendered.fixture("page"));
    await rendered.traverse(-1);
    await rendered.enter(task(rendered), "Half written");
    await rendered.traverse(-1);
    expect(question(rendered)).toBeDefined();
    expect([window.location.search, position()]).toEqual(["?_telo.open.todo=", open]);
    await answer(rendered, "cancel");
    expect([window.location.search, position()]).toEqual(["?_telo.open.todo=", open]);
    expect(task(rendered).value).toBe("Half written");
    // The forward entry is still there to go to.
    await rendered.traverse(1);
    expect(window.location.pathname).toBe("/");
    await answer(rendered, "submit");
    expect([window.location.pathname, position()]).toEqual(["/done", open + 1]);
    expect(rendered.part("text").textContent).toBe("The done page");
  });

  it("arms the browser's own prompt on leaving the document only while a form holds some", async () => {
    rendered = await show(panel());
    const leaving = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await rendered.click(rendered.part("table-create"));
    expect(leaving()).toBe(false);
    await rendered.enter(task(rendered), "Half written");
    expect(leaving()).toBe(true);
    await rendered.enter(task(rendered), "");
    expect(leaving()).toBe(false);
  });

  it("asks before the surface itself closes, and closes it once the input is dropped", async () => {
    rendered = await show(dialogSurface);
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(within(rendered, "cancel"));
    expect(question(rendered)).toBeDefined();
    await answer(rendered, "cancel");
    expect(task(rendered).value).toBe("Half written");
    await rendered.click(rendered.part("surface-close"));
    await answer(rendered, "submit");
    expect(rendered.parts("surface")).toEqual([]);
    expect(sent(rendered, "POST")).toEqual([]);
  });

  it("is dropped without a question anywhere under `discard`", async () => {
    rendered = await show(panel(), { more: [probe], opens: { unsaved: "discard" } });
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.part("surface-close"));
    expect(rendered.parts("surface")).toEqual([]);
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.fixture("page"));
    expect(window.location.pathname).toBe("/done");
    expect(question(rendered)).toBeUndefined();
  });
});

describe("an addressed surface", () => {
  it("writes what is open into the address as a history entry, and goes back to close", async () => {
    rendered = await show(named(panel()));
    const start = position();
    const entries = window.history.length;
    await rendered.click(rendered.part("table-create"));
    expect([window.location.search, position()]).toEqual(["?_telo.open.todo=", start + 1]);
    expect(rendered.part("surface-title").textContent).toBe("New");
    await rendered.traverse(-1);
    expect([window.location.search, position(), surface(rendered)]).toEqual(["", start, undefined]);
    // One name for both forms: opening the edit form closes the create form.
    await rendered.click(rendered.part("table-create"));
    await rendered.click(rendered.parts("row-edit")[1]);
    expect([window.location.search, position()]).toEqual(["?_telo.open.todo=2", start + 1]);
    expect(rendered.part("surface-title").textContent).toBe("Edit");
    expect(rendered.parts("surface").length).toBe(1);
    await rendered.click(rendered.part("surface-close"));
    expect([window.location.search, position(), surface(rendered)]).toEqual(["", start, undefined]);
    expect(window.history.length).toBe(entries + 1);
  });

  it("opens from a cold address over the record read by its key, and closes in the same history entry", async () => {
    rendered = await show(named(dialogSurface), { path: "/?_telo.open.todo=4&c=1" });
    const [start, entries] = [position(), window.history.length];
    expect(rendered.part("surface-title").textContent).toBe("Edit");
    expect(task(rendered).value).toBe("Write the docs");
    expect(sent(rendered, "GET /api/todos/4")).toEqual(["GET /api/todos/4"]);
    await rendered.click(rendered.part("surface-close"));
    expect([window.location.search, position(), window.history.length, surface(rendered)]).toEqual(["?c=1", start, entries, undefined]);
  });

  it("takes the entry a cold address arrived in for another row, and closes in it", async () => {
    rendered = await show(named(panel()), { path: "/?_telo.open.todo=1" });
    const [start, entries] = [position(), window.history.length];
    await rendered.click(rendered.parts("row-edit")[1]);
    expect([...where(), task(rendered).value]).toEqual(["?_telo.open.todo=2", start, "Review the plan"]);
    await rendered.click(rendered.part("surface-close"));
    expect([...where(), window.history.length, surface(rendered)]).toEqual(["", start, entries, undefined]);
  });

  it("closes alone, leaving another surface open on the page as it is", async () => {
    rendered = await twoPanels();
    const edits = rendered.parts("row-edit");
    await rendered.click(edits[0]);
    expect(where()).toEqual(["?_telo.open.a=1", 1]);
    await rendered.click(edits[3]);
    expect([...where(), tasks(rendered)]).toEqual(["?_telo.open.a=1&_telo.open.b=2", 2, ["Write the plan", "Review the plan"]]);
    await rendered.click(rendered.parts("surface-close")[1]);
    expect([...where(), tasks(rendered)]).toEqual(["?_telo.open.a=1", 1, ["Write the plan"]]);
    // The one opened first is not on top: it leaves the entry both are in.
    await rendered.click(edits[3]);
    expect(where()).toEqual(["?_telo.open.a=1&_telo.open.b=2", 2]);
    await rendered.click(rendered.parts("surface-close")[0]);
    expect([...where(), tasks(rendered)]).toEqual(["?_telo.open.b=2", 2, ["Review the plan"]]);
  });

  it("closes two surfaces asked to close in one step, the second while the first is stepping back", async () => {
    rendered = await twoPanels();
    const edits = rendered.parts("row-edit");
    await rendered.click(edits[0]);
    await rendered.click(edits[3]);
    const [first, second] = rendered.parts("surface-close");
    await act(async () => {
      for (const button of [second, first]) button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await rendered.settle();
    expect([...where(), rendered.parts("surface")]).toEqual(["", 1, []]);
  });

  it("keeps a form switched to another row under a later surface, with its input, when that surface closes", async () => {
    rendered = await twoPanels();
    const edits = rendered.parts("row-edit");
    await rendered.click(edits[0]);
    await rendered.click(edits[3]);
    await rendered.click(edits[1]);
    expect(where()).toEqual(["?_telo.open.b=2&_telo.open.a=2", 2]);
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.parts("surface-close")[1]);
    expect([...where(), tasks(rendered), question(rendered)]).toEqual(["?_telo.open.a=2", 1, ["Half written"], undefined]);
  });

  it("adds an entry on a page reached by replacing the entry of an open surface", async () => {
    const table = tableNode({ create: opener({ surface: named(panel()) }) });
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Todos", children: [probe, table] }, "/done": { title: "Done", children: [table] } },
    });
    await rendered.click(rendered.part("table-create"));
    expect([window.location.pathname, ...where()]).toEqual(["/", "?_telo.open.todo=", 1]);
    await rendered.click(rendered.fixture("replace-page"));
    expect([window.location.pathname, ...where(), surface(rendered)]).toEqual(["/done", "", 1, undefined]);
    await rendered.click(rendered.part("table-create"));
    expect([window.location.pathname, ...where()]).toEqual(["/done", "?_telo.open.todo=", 2]);
    await rendered.click(rendered.part("surface-close"));
    expect([window.location.pathname, ...where(), surface(rendered)]).toEqual(["/done", "", 1, undefined]);
  });

  it("opens nothing for an empty value under a name only the edit form declares", async () => {
    rendered = await show(dialogSurface, { path: "/?_telo.open.todo=", table: { edit: opener({ surface: named(dialogSurface) }) } });
    expect(rendered.parts("surface")).toEqual([]);
  });

  it("keeps a row with an empty key open in memory, never as the create form", async () => {
    rendered = await show(named(dialogSurface), { rows: [{ code: "", text: "Has no key" }], table: { rowKey: "code" } });
    const [start, entries] = [position(), window.history.length];
    await rendered.click(rendered.part("row-edit"));
    expect(rendered.part("surface-title").textContent).toBe("Edit");
    expect([window.location.search, position(), window.history.length]).toEqual(["", start, entries]);
  });
});

describe("a compact surface", () => {
  it("stands in below the application's breakpoint, under the address of the surface it replaces", async () => {
    const declared = named({ ...panel(), compact: drawer("bottom") });
    rendered = await show(declared, { narrow: true });
    expect(rendered.mediaQueries).toEqual(["(width < 40rem)"]);
    expect(rendered.part("app").getAttribute("data-compact")).toBe("true");
    await rendered.click(rendered.part("table-create"));
    expect([surface(rendered)!.getAttribute("data-surface"), surface(rendered)!.getAttribute("data-side")]).toEqual(["drawer", "bottom"]);
    expect(window.location.search).toBe("?_telo.open.todo=");
    rendered.unmount();
    rendered = await show(declared);
    expect(rendered.part("app").getAttribute("data-compact")).toBeNull();
    await rendered.click(rendered.part("table-create"));
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("panel");
  });

  it.each([
    ["panel", panel()],
    ["inline", { type: "inline" }],
    ["popover", popover],
  ])("gives way to the %s it stands in for as the viewport crosses the breakpoint, and takes its place again, with what was entered", async (type, declared) => {
    rendered = await show({ ...declared, compact: dialogSurface }, { narrow: true });
    await rendered.click(rendered.parts("row-edit")[1]);
    const input = task(rendered);
    await rendered.enter(input, "Half written");
    await rendered.focus(input);
    const drawn = () => [
      surface(rendered!)!.getAttribute("data-surface"),
      task(rendered!) === input,
      input.value,
      within(rendered!, "form").getAttribute("data-dirty"),
      document.activeElement === input,
      question(rendered!),
      sent(rendered!, "GET /api/todos/2").length,
    ];
    expect(drawn()).toEqual(["dialog", true, "Half written", "true", true, undefined, 1]);
    await rendered.setNarrow(false);
    expect(drawn()).toEqual([type, true, "Half written", "true", true, undefined, 1]);
    await rendered.enter(input, "Half written, then more");
    await rendered.setNarrow(true);
    expect(drawn()).toEqual(["dialog", true, "Half written, then more", "true", true, undefined, 1]);
    // It is still unsaved input: closing asks.
    await rendered.click(within(rendered, "cancel"));
    expect(question(rendered)).toBeDefined();
  });

  it("lets a form being sent finish across the swap, and do what follows its save", async () => {
    rendered = await show({ ...panel(), compact: dialogSurface });
    let respond: (response: Response) => void = () => {};
    await rendered.click(rendered.part("table-create"));
    await rendered.enter(task(rendered), "A slow task");
    rendered.answer("/api/todos", () => new Promise<Response>((resolve) => (respond = resolve)));
    await rendered.click(within(rendered, "submit"));
    await rendered.setNarrow(true);
    expect([surface(rendered)!.getAttribute("data-surface"), within(rendered, "form").getAttribute("data-state")]).toEqual(["dialog", "submitting"]);
    respond(new Response(JSON.stringify({ id: 9, text: "A slow task" }), { status: 201 }));
    await rendered.settle();
    expect([surface(rendered), sent(rendered, "POST")]).toEqual([undefined, ["POST /api/todos"]]);
  });
});
