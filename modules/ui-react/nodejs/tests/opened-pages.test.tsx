// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SpecNode } from "../src/browser/nodes.js";
import { HEADER_NAVIGATION, render, wireText, type Page, type Rendered } from "./harness.js";
import { address, dialogSurface, filterField, filtersNode, listingNode, navigateTo, openPageAt, pressOpening, recordPages, todoColumns, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const dismiss = { escape: true, outside: true, closeButton: true };
/** The end drawer the posts open in, kept under the name `post`. */
const postDrawer = { type: "drawer", side: "end", size: "medium", modal: true, dismiss, address: { name: "post" } };
const hello = address("/posts/{id}", { id: { value: "hello" } });

/** A pressed box opening a post in the drawer, and a link to the post's full page. */
const postCard = (id = "hello") => ({
  type: "box",
  press: { to: openPageAt(address("/posts/{id}", { id: { value: id } }), postDrawer, false), label: `Open ${id}` },
  children: [
    { type: "text", text: `Post ${id}` },
    { type: "link", text: "Full page", to: navigateTo(address("/posts/{id}", { id: { value: id } })) },
  ],
});

const pages: Record<string, Page> = {
  "/": { title: "Posts", children: [postCard("hello"), postCard("other")] },
  "/posts/{id}": {
    title: "Post",
    children: [
      { type: "text", text: "The post page" },
      // No surface: the author's page replaces the post in the drawer it is open in.
      { type: "link", text: "About the author", to: openPageAt(address("/authors/{id}", { id: { value: "ada" } }, { from: { value: "hello" } })) },
      { type: "link", text: "In a dialog", to: openPageAt(address("/authors/ada"), dialogSurface, false) },
      { type: "link", text: "In the same drawer", to: openPageAt(address("/authors/ada"), postDrawer, false) },
      // A name a reload of the posts page finds nowhere.
      { type: "link", text: "Elsewhere", to: openPageAt(address("/authors/ada"), { ...postDrawer, address: { name: "aside" } }, false) },
    ],
  },
  "/authors/{id}": {
    title: "Author",
    children: [
      { type: "text", text: "The author page" },
      { type: "link", text: "All posts", to: navigateTo(address("/")) },
    ],
  },
};

/** The surface an opened page is drawn in, what it holds, and its title. */
const surface = () => document.querySelector<HTMLElement>('[data-telo-part="surface"][data-state="open"]');
const shown = () => {
  const at = surface();
  return at && { kind: at.getAttribute("data-surface"), title: at.querySelector('[data-telo-part="surface-title"]')?.textContent, text: at.querySelector('[data-telo-part="text"]')?.textContent };
};
const address_ = () => decodeURIComponent(window.location.pathname + window.location.search);
/** The test listing's columns that draw values alone. */
const columns = todoColumns.filter((column) => column.cell === undefined);
const press = (name: string) => rendered!.parts("press").find((each) => each.getAttribute("aria-label") === name) as HTMLElement;
const link = (text: string) => rendered!.parts("link").find((each) => each.textContent === text) as HTMLElement;

describe("an opened page", () => {
  it("opens in the surface it names, kept under its page key in a new history entry; Escape closes it, drops the key and gives the focus back", async () => {
    rendered = await render({ path: "/", pages });
    const entries = window.history.length;
    const card = press("Open hello");
    await rendered.focus(card);
    await rendered.click(card);
    expect(window.location.search).toBe("?_telo.open.post=%2Fposts%2Fhello");
    expect(window.history.length).toBe(entries + 1);
    expect(shown()).toEqual({ kind: "drawer", title: "Post", text: "The post page" });
    await rendered.escape();
    expect(shown()).toBeNull();
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(press("Open hello"));
  });

  it("is reopened from its key in the surface the first destination naming it declares", async () => {
    rendered = await render({ path: "/?_telo.open.post=%2Fposts%2Fhello", pages });
    expect(shown()).toEqual({ kind: "drawer", title: "Post", text: "The post page" });
  });

  it("pressed with no surface inside an opened page, replaces it in the same surface and rewrites the key, adding no entry", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.click(press("Open hello"));
    const drawer = surface();
    const entries = window.history.length;
    await rendered.click(link("About the author"));
    expect(surface()).toBe(drawer);
    expect(shown()).toEqual({ kind: "drawer", title: "Author", text: "The author page" });
    expect(address_()).toBe("/?_telo.open.post=/authors/ada?from=hello");
    expect(window.history.length).toBe(entries);
  });

  it("swaps in place when the surface it names equals the open one, and otherwise closes it and opens its own", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.click(press("Open hello"));
    const drawer = surface();
    await rendered.click(link("In the same drawer"));
    expect(surface()).toBe(drawer);
    expect(address_()).toBe("/?_telo.open.post=/authors/ada");
    await rendered.click(press("Open hello"));
    await rendered.click(link("In a dialog"));
    expect(shown()).toEqual({ kind: "dialog", title: "Author", text: "The author page" });
    // A dialog with no name is held in memory: the drawer's key is gone and none replaces it.
    expect(window.location.search).toBe("");
  });

  it("writes no key for a surface a reload would not restore, so a reload shows the page beneath alone", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.click(press("Open hello"));
    await rendered.click(link("Elsewhere"));
    expect(shown()).toMatchObject({ kind: "drawer", title: "Author" });
    expect(window.location.search).toBe("");
  });

  it("is closed by a destination moving the application from inside it", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.click(press("Open hello"));
    await rendered.click(link("About the author"));
    await rendered.click(link("All posts"));
    expect(shown()).toBeNull();
    expect(address_()).toBe("/");
  });

  it("is titled by the text naming what opened it when its page has no title, and draws the not-found page for a path no page declares", async () => {
    const untitled = { ...pages, "/": { title: "Posts", children: [{ type: "link", text: "Read the notes", to: openPageAt(address("/notes")) }, { type: "link", text: "Gone", to: openPageAt(address("/gone")) }] }, "/notes": { children: [{ type: "text", text: "Notes" }] } };
    rendered = await render({ path: "/", pages: untitled, notFound: [{ type: "text", text: "Nothing here" }] });
    await rendered.click(link("Read the notes"));
    expect(shown()).toEqual({ kind: "dialog", title: "Read the notes", text: "Notes" });
    await rendered.escape();
    await rendered.click(link("Gone"));
    expect(shown()).toEqual({ kind: "dialog", title: "Gone", text: "Nothing here" });
  });

  it("asks before it closes while a form inside it holds unsaved input, and stays open unless the input is dropped", async () => {
    const drawer = { ...postDrawer, address: { name: "todo" } };
    const listing = listingNode({ columns, edit: pressOpening("edit", drawer) });
    rendered = await render({ path: "/", pages: { ...pages, ...recordPages(), "/": { title: "Todos", children: [listing] } }, collections: { "/api/todos": todos } });
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.enter(rendered.part("input"), "Half written");
    const question = () => document.querySelector('[data-surface="confirmation"]');
    const answer = (part: "submit" | "cancel") => rendered!.click(question()!.querySelector(`[data-telo-part="${part}"]`)!);
    await rendered.escape();
    expect(question()).not.toBeNull();
    await answer("cancel");
    expect(shown()).toMatchObject({ kind: "drawer", title: "Edit" });
    await rendered.focus(rendered.part("input"));
    await rendered.escape();
    await answer("submit");
    expect([question(), shown(), window.location.search]).toEqual([null, null, ""]);
  });
});

describe("the page key", () => {
  it("is restored into the page's surface before the layout's when both declare the name", async () => {
    const layoutDrawer = { ...postDrawer, side: "start" };
    const entry = { type: "link", key: "post", to: openPageAt(hello, layoutDrawer, false), text: wireText("Hello") };
    rendered = await render({ path: "/?_telo.open.post=%2Fposts%2Fhello", pages, navigation: { items: [entry], placement: HEADER_NAVIGATION } });
    expect(surface()?.getAttribute("data-side")).toBe("end");
  });

  it("is dropped by replace when it names a surface no destination declares, and so is every key after the one that opens; a value that is no address is another's", async () => {
    rendered = await render({ path: "/?_telo.open.x=https%3A%2F%2Fevil&_telo.open.post=%2Fposts%2Fhello&_telo.open.other=%2Fposts%2Fother&keep=1", pages });
    expect(shown()).toMatchObject({ title: "Post" });
    expect(address_()).toBe("/?_telo.open.x=https://evil&_telo.open.post=/posts/hello&keep=1");
  });

  it("shares its space with a tab bar's values, told apart by what a key holds: a tab chosen under another name stays when the page closes", async () => {
    const tabs = { type: "tabs", address: { name: "section" }, tabs: [{ key: "one", text: wireText("One"), children: [] }, { key: "two", text: wireText("Two"), children: [] }] };
    rendered = await render({ path: "/?_telo.open.section=two", pages: { ...pages, "/": { title: "Posts", children: [tabs, postCard("hello")] } } });
    await rendered.click(press("Open hello"));
    expect(address_()).toBe("/?_telo.open.section=two&_telo.open.post=/posts/hello");
    await rendered.escape();
    expect(address_()).toBe("/?_telo.open.section=two");
  });

  it("is the only address an opened page writes: its filter bar keeps its value in memory, and the page a press opens replaces it", async () => {
    const filtered = filtersNode(listingNode({ columns, edit: pressOpening("edit", { ...dialogSurface, address: { name: "todo" } }) }), {
      fields: [filterField("text", "contains")],
      state: { key: "todos", address: true, store: { type: "memory" }, fields: ["text"] },
    });
    const withTodos = { ...pages, ...recordPages(), "/posts/{id}": { title: "Post", children: [filtered] } };
    rendered = await render({ path: "/", pages: withTodos, collections: { "/api/todos": todos } });
    await rendered.click(press("Open hello"));
    const input = rendered.part("filter-input");
    await rendered.enter(input, "plan");
    await rendered.commit(input, "enter");
    expect(rendered.requests.some((request) => request.startsWith("GET /api/todos?") && request.includes("plan"))).toBe(true);
    await rendered.click(rendered.parts("row-edit")[0]);
    expect(rendered.parts("form")).toHaveLength(1);
    // The page the listing opens replaces the post in the one opened page there is; no document of the page beneath declares its name, so it is held in memory.
    expect(address_()).toBe("/");
  });
});

describe("a non-modal opened page", () => {
  const helpDrawer = { type: "drawer", side: "end", size: "medium", modal: false, dismiss, address: { name: "help" } };
  const help = { type: "link", key: "help", to: openPageAt(address("/authors/ada"), helpDrawer, false), text: wireText("Help") };
  const withHelp = (children: SpecNode[]) => ({ ...pages, "/": { title: "Posts", children } });

  it("takes a press from the page beneath: one naming an equal surface swaps its content and takes its entry, another closes it and opens its own", async () => {
    const same = { type: "link", text: "Same drawer", to: openPageAt(hello, helpDrawer, false) };
    const other = { type: "link", text: "Other drawer", to: openPageAt(hello, postDrawer, false) };
    rendered = await render({ path: "/", pages: withHelp([same, other, postCard("hello")]), navigation: { items: [help], placement: HEADER_NAVIGATION } });
    await rendered.click(rendered.part("nav-item"));
    expect(rendered.part("nav-item").getAttribute("aria-current")).toBe("page");
    const drawer = surface();
    const entries = window.history.length;
    await rendered.click(link("Same drawer"));
    expect(surface()).toBe(drawer);
    expect(shown()).toMatchObject({ title: "Post" });
    expect(address_()).toBe("/?_telo.open.help=/posts/hello");
    expect(window.history.length).toBe(entries);
    await rendered.click(link("Other drawer"));
    expect(document.querySelectorAll('[data-telo-part="surface"][data-state="open"]').length).toBe(1);
    expect(surface()?.getAttribute("data-modal")).toBe("true");
    expect(address_()).toBe("/?_telo.open.post=/posts/hello");
  });
});
