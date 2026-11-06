// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HEADER_NAVIGATION, render, type Rendered } from "./harness.js";
import { wireText } from "./ui-texts.js";
import { address, listingNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const row = (...path: string[]) => ({ root: "row", path });
const toRow = { type: "link", text: "Open", href: address("/", {}, { conversation: row("id") }) };
const content = { type: "stack", children: [toRow] };
const rowsAs = (layout: Record<string, unknown>) => listingNode({ rowStyle: undefined, create: undefined, edit: undefined, delete: false, pageSize: 5, layout });

const show = (path: string, children: unknown[]) =>
  render({ path, collections: { "/api/todos": todos }, pages: { "/": { title: "Chat", children: children as never } } });
const current = (r: Rendered) => r.parts("link").filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent);

describe("the current location", () => {
  it("marks the link to the page and the record whose link leads to the address, following the address without a reload", async () => {
    rendered = await show("/", [
      { type: "link", text: "New", href: address("/") },
      { type: "link", text: "Elsewhere", href: address("https://example.com/") },
      rowsAs({ type: "list", content, reads: {} }),
    ]);
    expect(current(rendered)).toEqual(["New"]);
    expect(rendered.parts("list-item").filter((item) => item.dataset.selected === "true")).toEqual([]);

    await rendered.click(rendered.parts("link")[3]);
    expect(window.location.search).toBe("?conversation=2");
    expect(rendered.parts("link").filter((link) => link.getAttribute("aria-current") === "page")).toEqual([rendered.parts("link")[3]]);
    expect(rendered.parts("list-item").map((item) => item.dataset.selected)).toEqual([undefined, "true", undefined, undefined, undefined]);
  });

  it("marks a table row whose column links to the address", async () => {
    const columns = [{ header: "Task", value: row("text"), present: { type: "string" }, labels: [], href: address("/", {}, { conversation: row("id") }) }];
    rendered = await show("/?conversation=3&_telo.f.bar.status=open", [rowsAs({ type: "table", columns, reads: {} })]);
    expect(current(rendered)).toEqual(["Ship the renderer"]);
    expect(rendered.parts("table-row").map((each) => each.dataset.selected)).toEqual([undefined, undefined, "true", undefined, undefined]);
  });

  it("marks a navigation link entry by the rule and a page entry by its path alone", async () => {
    const pages = { "/": { title: "Chat", children: [] }, "/other": { title: "Other", children: [] } };
    const items = [
      { type: "page", key: "chat", path: "/", text: wireText("Chat") },
      { type: "link", key: "one", href: "/?conversation=1", text: wireText("One") },
      { type: "link", key: "two", href: "/?conversation=2", text: wireText("Two") },
    ];
    rendered = await render({ path: "/?conversation=2", pages, navigation: { items, placement: HEADER_NAVIGATION } });
    const marked = rendered.parts("nav-item").filter((link) => link.getAttribute("aria-current") === "page");
    expect(marked.map((link) => link.textContent)).toEqual(["Chat", "Two"]);
  });
});
