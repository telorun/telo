// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readsResult } from "../src/browser/operation.js";
import { render, type Rendered } from "./harness.js";
import { address, dialogSurface, navigateTo, openPageAt } from "./spec-nodes.js";
import { wireText } from "./ui-texts.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const author = address("/authors/{id}", { id: { value: "ada" } });
/** A press named by a text over a value of its own. */
const pressing = (to: unknown) => ({ to, label: { ...wireText("Open {$who}"), values: { who: { value: "Ada" } } } });

const pages = {
  "/": { title: "Home", children: [] },
  "/authors/{id}": { title: "Author", children: [{ type: "text", text: "The author page" }] },
};

describe("a pressed node", () => {
  it("draws its press as its first child: an empty link to the destination's address named exactly by the label, the node's own content after it", async () => {
    const pressed = (type: string) => ({ type, press: pressing(navigateTo(author)), children: [{ type: "text", text: "Ada" }, { type: "link", text: "Profile", to: navigateTo(author) }] });
    rendered = await render({ path: "/", pages: { ...pages, "/": { title: "Home", children: ["box", "stack", "columns"].map(pressed) } } });
    for (const type of ["box", "stack", "columns"]) {
      const node = rendered.part(type);
      const press = node.firstElementChild as HTMLElement;
      expect([press.tagName, press.getAttribute("data-telo-part"), press.getAttribute("href"), press.getAttribute("aria-label"), press.textContent]).toEqual([
        "A",
        "press",
        "/authors/ada",
        "Open Ada",
        "",
      ]);
      expect(node.querySelectorAll('[data-telo-part="press"]')).toHaveLength(1);
    }
    expect(rendered.parts("box")[0].querySelector('[data-telo-part="link"]')?.textContent).toBe("Profile");
    expect(await rendered.click(rendered.parts("press")[0])).toBe(true);
    expect(rendered.part("text").textContent).toBe("The author page");
  });

  it("draws no press where none is written", async () => {
    rendered = await render({ path: "/", pages: { ...pages, "/": { title: "Home", children: [{ type: "box", press: null, children: [{ type: "text", text: "Ada" }] }] } } });
    expect(rendered.parts("press")).toEqual([]);
  });
});

describe("a record leading to the page open over it", () => {
  it("is selected while that page is open, and a link opening it is current", async () => {
    const rows = [{ id: "ada", name: "Ada" }, { id: "alan", name: "Alan" }];
    const list = {
      type: "list",
      rows: { value: rows },
      rowActionsDisplay: "auto",
      columns: [{ header: "Name", value: { root: "row", path: ["name"] }, present: { type: "string" }, to: openPageAt(address("/authors/{id}", { id: { root: "row", path: ["id"] } }), dialogSurface, false) }],
    };
    rendered = await render({ path: "/", pages: { ...pages, "/": { title: "Home", children: [list] } } });
    const selected = () => rendered!.parts("table-row").map((row) => row.getAttribute("data-selected"));
    expect(selected()).toEqual([null, null]);
    await rendered.click(rendered.parts("link").find((each) => each.textContent === "Ada") as Element);
    expect(rendered.part("surface-title").textContent).toBe("Author");
    expect(selected()).toEqual(["true", null]);
    expect(rendered.parts("link").find((each) => each.textContent === "Ada")?.getAttribute("aria-current")).toBe("page");
    await rendered.escape();
    expect(selected()).toEqual([null, null]);
  });
});

describe("what reads an action's answer", () => {
  it("counts a destination reading `result` at a link, a menu item, a value, a list column and a press, and the values of a press's label", () => {
    const reading = address("/projects/{id}", { id: { root: "result", path: ["id"] } });
    const fixed = address("/projects");
    const text = wireText("Open");
    const nodes = (to: unknown, label: unknown = text) => [
      { type: "link", text, to },
      { type: "menu", text, items: [{ type: "link", text, to }] },
      { type: "value", value: { value: 1 }, to },
      { type: "list", rows: { value: [] }, columns: [{ header: text, value: { value: 1 }, to }] },
      { type: "box", press: { to, label }, children: [] },
    ];
    expect(nodes(navigateTo(reading)).map(readsResult)).toEqual([true, true, true, true, true]);
    expect(nodes(navigateTo(fixed)).map(readsResult)).toEqual([false, false, false, false, false]);
    expect(readsResult({ type: "stack", press: { to: navigateTo(fixed), label: { ...text, values: { id: { root: "result", path: ["id"] } } } }, children: [] })).toBe(true);
  });
});
