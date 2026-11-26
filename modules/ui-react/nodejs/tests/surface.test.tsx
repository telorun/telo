// @vitest-environment jsdom
import { act, useRef } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Surface } from "../src/browser/surface.js";
import { loadFixtureComponents, render, type Page, type Rendered } from "./harness.js";
import { address, asideOf, component, decisionSchema, dialogSurface, buttonOf, call, listingNode, literals, navigateTo, openPageAt, querySpec, recordPages, recordPresses, todoSchema, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const dismissAll = { escape: true, outside: true, closeButton: true };
const drawer = (side: string) => ({ type: "drawer", side, size: "large", modal: true, dismiss: dismissAll });
const popover = { type: "popover", side: "top", align: "end", dismiss: { escape: true, outside: true } };
const panel = (side = "end") => ({ type: "panel", side, size: "small", dismiss: { escape: true, closeButton: true } });
const named = (surface: Record<string, unknown>, name = "todo") => ({ ...surface, address: { name } });
const probe = component("HostProbe", { basePath: { value: "/api/todos" } });
/** The address a record's page is kept under. */
const key = (path: string) => `_telo.open.todo=${encodeURIComponent(path)}`;

/** A page holding a table whose `create` and `edit` open their pages in `surface`, beside whatever else it is given; `forms` replaces members of both pages' forms. */
const show = (
  surface: Record<string, unknown>,
  options: { more?: Page["children"]; path?: string; narrow?: boolean; rows?: Record<string, unknown>[]; table?: Record<string, unknown>; forms?: Record<string, unknown> } = {},
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
        children: [...(options.more ?? []), listingNode({ ...recordPresses(surface), ...options.table })],
      },
      "/done": { title: "Done", children: [{ type: "text", text: "The done page" }] },
      ...recordPages(options.forms, options.forms),
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

describe("a dialog", () => {
  it("is named by its title, holds the focus, and closes on Escape, its close button or Cancel with nothing sent", async () => {
    rendered = await show(dialogSurface);
    await rendered.click(rendered.part("listing-create"));
    const dialog = surface(rendered)!;
    expect(["data-surface", "data-size", "data-modal", "role"].map((name) => dialog.getAttribute(name))).toEqual(["dialog", "medium", "true", "dialog"]);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") as string)?.textContent).toBe("Create");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(rendered.parts("surface-overlay").length).toBe(1);
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.parts("row-edit")[0]);
    expect(rendered.part("surface-title").textContent).toBe("Edit");
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.part("listing-create"));
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
    expect([...sent(rendered, "POST"), ...sent(rendered, "PATCH")]).toEqual([]);
  });

  it("stays open through each way of dismissing that is switched off, and has no close button", async () => {
    rendered = await show({ ...dialogSurface, size: "full", dismiss: { escape: false, outside: false, closeButton: false } });
    await rendered.click(rendered.part("listing-create"));
    expect(surface(rendered)!.getAttribute("data-size")).toBe("full");
    expect(rendered.parts("surface-close")).toEqual([]);
    await rendered.escape();
    await rendered.pointerDown(rendered.part("surface-overlay"));
    expect(surface(rendered)).toBeDefined();
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("leaves the page uncovered when it is not modal, and closes on a press outside it", async () => {
    rendered = await show({ ...dialogSurface, modal: false }, { forms: { unsaved: "discard" } });
    await rendered.click(rendered.part("listing-create"));
    expect(surface(rendered)!.getAttribute("data-modal")).toBe("false");
    expect(rendered.parts("surface-overlay")).toEqual([]);
    expect(rendered.container.getAttribute("aria-hidden")).toBeNull();
    // A list its form opens is drawn elsewhere, and is still inside it.
    await rendered.focus(task(rendered));
    await rendered.choose(within(rendered, "select"), "blocked");
    expect([surface(rendered) !== undefined, within(rendered, "select").textContent]).toEqual([true, "blocked"]);
    await rendered.pointerDown(rendered.part("page"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("cannot be dismissed while its form is being sent", async () => {
    rendered = await show(dialogSurface);
    let respond: (response: Response) => void = () => {};
    await rendered.click(rendered.part("listing-create"));
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
    await rendered.click(rendered.part("listing-create"));
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
    expect(sent(rendered, "PATCH")).toEqual(["PATCH /api/todos/2"]);
    await rendered.click(rendered.part("listing-create"));
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    rendered.unmount();
    rendered = await show({ ...popover, dismiss: { escape: false, outside: false } });
    await rendered.click(rendered.part("listing-create"));
    await rendered.escape();
    await rendered.pointerDown(rendered.part("page"));
    expect(surface(rendered)).toBeDefined();
    await rendered.click(within(rendered, "cancel"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("is a dialog on a cold load when a listing's record opened it, and anchored to the node that declares it when that node is what is pressed", async () => {
    rendered = await show(named(popover), { path: `/?${key("/todos/2")}` });
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("dialog");
    expect(task(rendered).value).toBe("Review the plan");
    rendered.unmount();
    const link = { type: "link", text: "Open", to: openPageAt(address("/todos/{id}", { id: { value: "2" } }), named(popover), false) };
    rendered = await show(named(popover), { path: `/?${key("/todos/2")}`, more: [link], table: { edit: null, press: null } });
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("popover");
  });
});

describe("what a surface holds", () => {
  it("is still inside it when a press there moves the focus within it before the press reaches the page", async () => {
    // A component's own list, drawn unmarked at the end of <body>, whose press focuses the
    // component's search input; the surface's initial focus is on the input before it.
    function Picker() {
      const input = useRef<HTMLInputElement>(null);
      return (
        <>
          <input />
          <input id="search" ref={input} />
          {createPortal(
            <button id="pick" type="button" onPointerDown={() => input.current?.focus()}>
              Pick
            </button>,
            document.body,
          )}
        </>
      );
    }
    document.body.innerHTML = "";
    const container = document.body.appendChild(document.createElement("div"));
    const anchor = { current: container };
    const closes: string[] = [];
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Surface spec={popover as never} title="Held" anchor={anchor} onClose={() => closes.push("closed")}>
          <Picker />
        </Surface>,
      ),
    );
    await act(async () => {
      document.getElementById("pick")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect([closes, document.activeElement?.id]).toEqual([[], "search"]);
    await act(async () => root.unmount());
  });
});

describe("an inline surface", () => {
  it("draws the page under its record in a listing, and after the control that opened it elsewhere", async () => {
    rendered = await show({ type: "inline" }, { more: [{ type: "link", text: "New in line", to: openPageAt(address("/todos/new"), { type: "inline" }, false) }] });
    await rendered.click(rendered.parts("row-edit")[1]);
    const detail = rendered.part("table-detail");
    expect(detail.contains(surface(rendered)!)).toBe(true);
    expect(detail.parentElement?.previousElementSibling).toBe(rendered.parts("table-row")[1]);
    expect(task(rendered).value).toBe("Review the plan");
    await rendered.enter(task(rendered), "Review it in place");
    await rendered.click(within(rendered, "submit"));
    expect(rendered.parts("table-detail")).toEqual([]);
    expect(sent(rendered, "PATCH")).toEqual(["PATCH /api/todos/2"]);
    // The create button is not a record: the page is drawn right after it.
    await rendered.click(rendered.part("listing-create"));
    expect(rendered.part("listing-create").nextElementSibling?.contains(surface(rendered)!)).toBe(true);
    await rendered.click(within(rendered, "cancel"));
    // So is a link outside any listing.
    const button = rendered.parts("link").find((each) => each.textContent === "New in line") as HTMLElement;
    await rendered.click(button);
    expect(button.nextElementSibling?.contains(surface(rendered)!)).toBe(true);
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("inline");
  });

  it("is a dialog on a cold load when a listing's record opened it, and drawn after the link that declares it when that is what is pressed", async () => {
    rendered = await show(named({ type: "inline" }), { path: `/?${key("/todos/2")}` });
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("dialog");
    rendered.unmount();
    const link = { type: "link", text: "Open", to: openPageAt(address("/todos/{id}", { id: { value: "2" } }), named({ type: "inline" }), false) };
    rendered = await show(named({ type: "inline" }), { path: `/?${key("/todos/2")}`, more: [link], table: { edit: null, press: null } });
    const opener = rendered.parts("link").find((each) => each.textContent === "Open") as HTMLElement;
    expect([surface(rendered)!.getAttribute("data-surface"), opener.nextElementSibling?.contains(surface(rendered)!)]).toEqual(["inline", true]);
  });
});

describe("a panel", () => {
  it.each(["start", "end"])("sits at the %s of the list, which stays usable, and closes on Escape or its close button", async (side) => {
    rendered = await show(panel(side));
    await rendered.click(rendered.parts("row-edit")[0]);
    const aside = surface(rendered)!;
    expect(["data-surface", "data-side", "data-size"].map((name) => aside.getAttribute(name))).toEqual(["panel", side, "small"]);
    expect(aside.parentElement).toBe(rendered.part("listing"));
    expect(rendered.part("listing-main").parentElement).toBe(rendered.part("listing"));
    expect(rendered.parts("surface-overlay")).toEqual([]);
    // Another row opens in the same panel.
    await rendered.click(rendered.parts("row-edit")[1]);
    expect(task(rendered).value).toBe("Review the plan");
    await rendered.focus(task(rendered));
    await rendered.escape();
    expect(surface(rendered)).toBeUndefined();
    await rendered.click(rendered.part("listing-create"));
    await rendered.click(rendered.part("surface-close"));
    expect(surface(rendered)).toBeUndefined();
  });

  it("stays open on Escape, with no close button, when both are switched off", async () => {
    rendered = await show({ ...panel(), dismiss: { escape: false, closeButton: false } });
    await rendered.click(rendered.part("listing-create"));
    await rendered.focus(task(rendered));
    await rendered.escape();
    expect(surface(rendered)).toBeDefined();
    expect(rendered.parts("surface-close")).toEqual([]);
  });

  it("is a dialog on a cold load when the composite declaring it is not drawn yet, a query still pending", async () => {
    const declaring = { type: "query", query: { ...querySpec({ id: "pending", url: address("/api/todos/1") }) }, content: [listingNode({ ...recordPresses(named(panel())) })], loading: [], failure: [], fill: false };
    rendered = await render({
      path: `/?${key("/todos/2")}`,
      loadModule: loadFixtureComponents,
      required: ["text"],
      collections: { "/api/todos": todos },
      answers: { "/api/todos/1": () => new Promise<Response>(() => {}) },
      pages: { "/": { title: "Todos", children: [declaring as never] }, ...recordPages() },
    });
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("dialog");
  });

  it("is a dialog where no composite holds what was pressed", async () => {
    const link = { type: "link", text: "Open", to: openPageAt(address("/todos/new"), panel(), false) };
    rendered = await show(dialogSurface, { more: [link] });
    await rendered.click(rendered.parts("link").find((each) => each.textContent === "Open") as HTMLElement);
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("dialog");
  });
});

describe("a record's page", () => {
  it("opens from a row's edit in a panel under the page's address, and again on a reload; below the breakpoint it is a bottom drawer under the same address", async () => {
    const declared = named({ ...panel(), compact: drawer("bottom") }, "task");
    rendered = await show(declared);
    await rendered.click(rendered.parts("row-edit")[1]);
    expect([window.location.search, surface(rendered)!.getAttribute("data-surface"), task(rendered).value]).toEqual(["?_telo.open.task=%2Ftodos%2F2", "panel", "Review the plan"]);
    rendered.unmount();
    rendered = await show(declared, { path: "/?_telo.open.task=%2Ftodos%2F2" });
    // Cold, the listing declaring the surface stands in for what opened it: the panel sits beside it, and the record whose page is open is selected.
    expect([task(rendered).value, surface(rendered)!.getAttribute("data-surface"), surface(rendered)!.parentElement === rendered.part("listing")]).toEqual(["Review the plan", "panel", true]);
    expect(rendered.parts("table-row").map((row) => row.getAttribute("data-selected"))).toEqual([null, "true"]);
    rendered.unmount();
    rendered = await show(declared, { path: "/?_telo.open.task=%2Ftodos%2F2", narrow: true });
    expect([surface(rendered)!.getAttribute("data-surface"), surface(rendered)!.getAttribute("data-side"), window.location.search]).toEqual(["drawer", "bottom", "?_telo.open.task=%2Ftodos%2F2"]);
  });

  it("saves only what changed against the validator it was read with, closes the panel and reloads the listing; reached by its own address it saves and stays", async () => {
    const edits = [] as { body: unknown; ifMatch: string | null }[];
    rendered = await show(panel());
    const platform = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") edits.push({ body: JSON.parse(String(init.body)), ifMatch: new Headers(init.headers).get("if-match") });
      return platform(input, init);
    }) as typeof fetch;
    await rendered.click(rendered.parts("row-edit")[1]);
    await rendered.enter(task(rendered), "Review it twice");
    const lists = sent(rendered, "GET /api/todos?").length;
    await rendered.click(within(rendered, "submit"));
    expect(edits).toEqual([{ body: { text: "Review it twice" }, ifMatch: expect.stringMatching(/^"[A-Za-z0-9_-]+"$/) }]);
    expect([surface(rendered), sent(rendered, "GET /api/todos?").length]).toEqual([undefined, lists + 1]);
    rendered.unmount();
    rendered = await render({ path: "/todos/2", required: ["text"], collections: { "/api/todos": todos }, pages: recordPages() });
    await rendered.enter(rendered.part("input"), "Review it again");
    await rendered.click(rendered.part("submit"));
    expect(sent(rendered, "PATCH")).toEqual(["PATCH /api/todos/2"]);
    expect([rendered.parts("form").length, rendered.part("form").getAttribute("data-dirty"), window.location.pathname]).toEqual([1, null, "/todos/2"]);
  });

  it("is opened by a press on a record when the listing has an edit and no other press", async () => {
    rendered = await show(dialogSurface, { table: { press: recordPresses().edit, columns: undefined } });
    await rendered.click(rendered.parts("press")[0]);
    expect([rendered.part("surface-title").textContent, task(rendered).value]).toEqual(["Edit", "Write the plan"]);
  });
});

describe("what a form does once it is saved", () => {
  it("stays open and empty for another record under `again`, the list reloaded; pressing create twice makes two records", async () => {
    rendered = await show(panel(), { forms: { afterSubmit: "again" } });
    await rendered.click(rendered.part("listing-create"));
    await rendered.enter(task(rendered), "The first of two");
    await rendered.click(within(rendered, "submit"));
    expect(task(rendered).value).toBe("");
    expect(within(rendered, "form").getAttribute("data-dirty")).toBeNull();
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 6");
    await rendered.enter(task(rendered), "The second");
    await rendered.click(within(rendered, "submit"));
    expect(rendered.part("pager-status").textContent).toBe("1–2 of 7");
    expect(sent(rendered, "POST")).toEqual(["POST /api/todos", "POST /api/todos"]);
  });

  it("stays open with its values under `keep`, holding nothing unsaved, the list reloaded", async () => {
    rendered = await show(panel(), { forms: { afterSubmit: "keep" } });
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

  it("returns an edit page to the record it saved under `again`", async () => {
    rendered = await show(panel(), { forms: { afterSubmit: "again" } });
    await rendered.click(rendered.parts("row-edit")[1]);
    await rendered.enter(task(rendered), "Review it and again");
    await rendered.click(within(rendered, "submit"));
    expect([task(rendered).value, within(rendered, "form").getAttribute("data-dirty")]).toEqual(["Review it and again", null]);
  });
});

describe("unsaved input", () => {
  it("holds a component's navigation until the user answers, and drops it when they stay", async () => {
    rendered = await show(panel(), { more: [probe] });
    await rendered.click(rendered.part("listing-create"));
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
    await rendered.click(rendered.part("listing-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.fixture("query"));
    expect(window.location.search).toBe("?c=2");
    expect(question(rendered)).toBeUndefined();
    expect(task(rendered).value).toBe("Half written");
  });

  it("undoes a step back while it asks, and replays the step the user confirms", async () => {
    rendered = await show(named(dialogSurface), { more: [probe] });
    await rendered.click(rendered.part("listing-create"));
    const open = position();
    // A page further on, then back to the open form: there is a forward entry.
    await rendered.click(rendered.fixture("page"));
    await rendered.traverse(-1);
    await rendered.enter(task(rendered), "Half written");
    await rendered.traverse(-1);
    expect(question(rendered)).toBeDefined();
    expect([window.location.search, position()]).toEqual([`?${key("/todos/new")}`, open]);
    await answer(rendered, "cancel");
    expect([window.location.search, position()]).toEqual([`?${key("/todos/new")}`, open]);
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
    await rendered.click(rendered.part("listing-create"));
    expect(leaving()).toBe(false);
    await rendered.enter(task(rendered), "Half written");
    expect(leaving()).toBe(true);
    await rendered.enter(task(rendered), "");
    expect(leaving()).toBe(false);
  });

  it("asks before the surface itself closes, and closes it once the input is dropped", async () => {
    rendered = await show(dialogSurface);
    await rendered.click(rendered.part("listing-create"));
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

  it("asks before another record opens in the same surface, and keeps the first if the user stays", async () => {
    rendered = await show(panel());
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.parts("row-edit")[1]);
    expect(question(rendered)).toBeDefined();
    await answer(rendered, "cancel");
    expect(task(rendered).value).toBe("Half written");
    await rendered.click(rendered.parts("row-edit")[1]);
    await answer(rendered, "submit");
    expect(task(rendered).value).toBe("Review the plan");
  });

  it("is dropped without a question anywhere under `discard`", async () => {
    rendered = await show(panel(), { more: [probe], forms: { unsaved: "discard" } });
    await rendered.click(rendered.part("listing-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.part("surface-close"));
    expect(rendered.parts("surface")).toEqual([]);
    await rendered.click(rendered.part("listing-create"));
    await rendered.enter(task(rendered), "Half written");
    await rendered.click(rendered.fixture("page"));
    expect(window.location.pathname).toBe("/done");
    expect(question(rendered)).toBeUndefined();
  });

  it("is held for a form on a page of its own, which the application leaves only once the user answers", async () => {
    rendered = await render({
      path: "/todos/new",
      collections: { "/api/todos": todos },
      pages: {
        ...recordPages(),
        "/todos/new": { children: [...recordPages()["/todos/new"].children, { type: "link", text: "Leave", to: navigateTo(address("/done")) }] },
        "/done": { title: "Done", children: [{ type: "text", text: "The done page" }] },
      },
      layouts: false,
    });
    await rendered.enter(rendered.part("input"), "Half written");
    await rendered.click(rendered.parts("link").find((each) => each.textContent === "Leave") as HTMLElement);
    expect([window.location.pathname, question(rendered) === undefined]).toEqual(["/todos/new", false]);
    await answer(rendered, "submit");
    expect(window.location.pathname).toBe("/done");
  });
});

describe("a form restarting", () => {
  /** A page whose query reads the record its `record` parameter names, with a form over `data` and a link to the other record. */
  const bySection = () => {
    const edit = recordPages()["/todos/{id}"].children[0] as unknown as { content: unknown[] };
    const query = {
      type: "query",
      query: {
        id: "section",
        schema: { type: "object", properties: { id: { type: "integer" }, text: { type: "string" } } },
        method: "GET",
        url: address("/api/todos/{id}", { id: { root: "query", path: ["record"] } }),
        input: null,
        query: { record: { type: "string" } },
        form: null,
        reloadOn: ["focus"],
      },
      content: [{ ...(edit.content[0] as object), record: { basePath: "/api/todos", key: { root: "data", path: ["id"] }, answer: todoSchema } }],
      loading: [],
      failure: [],
      fill: false,
    };
    return { "/": { title: "Todo", children: [{ type: "link", text: "Second", to: navigateTo(address("/", {}, { record: { value: "2" } })) }, query] } };
  };
  const typed = (r: Rendered) => (r.part("input") as HTMLInputElement).value;
  const start = async () => {
    rendered = await render({ path: "/?record=1", required: ["text"], collections: { "/api/todos": todos }, pages: bySection(), layouts: false });
    await rendered.enter(rendered.part("input"), "Half written");
    return rendered;
  };

  it("starts again from the record read at another address once the unsaved input is dropped", async () => {
    const r = await start();
    await r.click(r.part("link"));
    expect([question(r) === undefined, typed(r)]).toEqual([false, "Half written"]);
    await answer(r, "submit");
    expect([typed(r), r.part("form").getAttribute("data-dirty")]).toEqual(["Review the plan", null]);
  });

  it("keeps what was typed where the user stays", async () => {
    const r = await start();
    await r.click(r.part("link"));
    await answer(r, "cancel");
    expect([typed(r), r.part("form").getAttribute("data-dirty")]).toEqual(["Half written", "true"]);
  });

  it("keeps what was typed when its query reads the same address again", async () => {
    const r = await start();
    const reads = sent(r, "GET /api/todos/1").length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await r.settle();
    expect([sent(r, "GET /api/todos/1").length, typed(r), question(r)]).toEqual([reads + 1, "Half written", undefined]);
  });
});

describe("a surface opened by a button node", () => {
  const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const decide = (surfaceSpec: Record<string, unknown>) =>
    call("/api/plans/p7/decisions", "Approve", decisionSchema, {
      inputs: literals({ id: "p7", decision: "approve", revision: 3, author: "Ada" }),
      onSuccess: [openPageAt(address("/todos/new"), surfaceSpec, false)],
    });
  const button = (surfaceSpec: Record<string, unknown>) => buttonOf(decide(surfaceSpec));
  const showing = (children: unknown[], path = "/") => {
    const pending = render({
      path,
      loadModule: loadFixtureComponents,
      required: ["text"],
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Plan", children: children as never }, ...recordPages() },
    });
    return pending.then((made) => {
      made.answer("/api/plans/p7/decisions", () => json({ state: "approved" }));
      return made;
    });
  };
  const approve = (r: Rendered) => r.part("button");
  const newKey = key("/todos/new");

  it.each([
    ["popover", popover],
    ["inline", { type: "inline" }],
  ])("anchors a %s to the button, opened warm and again on a reload", async (type, spec) => {
    rendered = await showing([button(named(spec))]);
    await rendered.click(approve(rendered));
    expect(surface(rendered)!.getAttribute("data-surface")).toBe(type);
    if (type === "inline") expect(approve(rendered).nextElementSibling?.contains(surface(rendered)!)).toBe(true);
    rendered.unmount();
    rendered = await showing([button(named(spec))], `/?${newKey}`);
    expect(surface(rendered)!.getAttribute("data-surface")).toBe(type);
    if (type === "inline") expect(approve(rendered).nextElementSibling?.contains(surface(rendered)!)).toBe(true);
  });

  it("sits a panel beside the composite holding the button, on a reload", async () => {
    const split = { type: "split", aside: asideOf({ type: "text", text: "Aside" }), content: button(named(panel())) };
    rendered = await showing([split], `/?${newKey}`);
    expect(surface(rendered)!.getAttribute("data-surface")).toBe("panel");
    expect(surface(rendered)!.parentElement).toBe(rendered.part("split"));
  });
});
