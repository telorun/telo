// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtureComponents, render, wire, type Rendered } from "./harness.js";
import { address, listingNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
beforeEach(() => window.sessionStorage.clear());

const drawer = { type: "drawer", side: "start", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };
const split = (overrides: Record<string, unknown> = {}) =>
  wire({
    type: "split",
    side: "start",
    size: "medium",
    frame: "flush",
    toggle: { type: "text" },
    label: "Filters",
    aside: { actions: [], content: listingNode({ create: undefined, edit: undefined, delete: false }) },
    content: { type: "text", text: "Content" },
    collapse: { collapsed: false, state: null },
    compact: drawer,
    ...overrides,
  });
const show = (node: unknown, narrow = false) =>
  render({ path: "/", narrow, loadModule: loadFixtureComponents, required: ["text"], collections: { "/api/todos": todos }, pages: { "/": { title: "Todos", children: [node as never] } } });
const reads = (r: Rendered) => r.requests.filter((request) => request.startsWith("GET /api/todos?"));
const stored = { type: "session" };
const key = "telo.ui:/:s:filters";

describe("a split view", () => {
  it("starts no request for a folded aside until it is shown", async () => {
    rendered = await show(split({ collapse: { collapsed: true, state: null } }));
    expect(rendered.part("split").getAttribute("data-state")).toBe("collapsed");
    expect(reads(rendered)).toEqual([]);
    await rendered.click(rendered.part("split-toggle"));
    expect(reads(rendered).length).toBeGreaterThan(0);
    expect(rendered.part("split").getAttribute("data-state")).toBe("open");
  });

  it("folds to a rail that keeps the toggle in the aside's bar, and the compact surface keeps the rail and opens from it", async () => {
    rendered = await show(split({ collapse: { collapsed: false, state: null } }));
    const inBar = () => rendered!.part("split-toggle").closest('[data-telo-part="split-bar"]')?.parentElement;
    const toggle = rendered.part("split-toggle");
    expect(inBar()).toBe(rendered.part("split-aside"));
    expect(rendered.part("split-aside").getAttribute("data-state")).toBe("open");
    await rendered.click(toggle);
    expect(rendered.part("split").getAttribute("data-state")).toBe("collapsed");
    expect(rendered.part("split-aside").getAttribute("data-state")).toBe("rail");
    expect(rendered.part("split-toggle")).toBe(toggle);
    expect(inBar()).toBe(rendered.part("split-aside"));
    expect(rendered.part("split-content").contains(toggle)).toBe(false);
    expect(rendered.part("pager-status").closest("[hidden]")?.parentElement).toBe(rendered.part("split-aside"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(rendered.part("split-aside").id);
    rendered.unmount();
    rendered = await show(split(), true);
    expect(rendered.part("split-content").contains(rendered.part("split-toggle"))).toBe(false);
    expect(rendered.part("split-toggle").closest('[data-telo-part="split-bar"]')?.parentElement).toBe(rendered.part("split-aside"));
    expect(rendered.part("split-aside").getAttribute("data-state")).toBe("rail");
    expect(rendered.parts("split-toggle")).toHaveLength(1);
  });

  it("draws its actions under the bar holding the toggle, as stacked glyphs when folded, and in the rail only when compact", async () => {
    const entries = [{ type: "link", text: "New", href: address("/new"), button: { type: "icon", icon: null, label: "shown" } }];
    const withBar = { actions: entries, content: { type: "text", text: "Aside" } };
    rendered = await show(split({ aside: withBar }));
    const link = () => rendered!.part("split-actions").querySelector<HTMLElement>('[data-telo-part="link"]')!;
    expect(rendered.part("split-bar").nextElementSibling).toBe(rendered.part("split-actions"));
    expect(rendered.part("split-bar").children).toHaveLength(1);
    expect(rendered.part("split-bar").contains(rendered.part("split-toggle"))).toBe(true);
    expect(link().textContent).toBe("New");
    await rendered.click(rendered.part("split-toggle"));
    expect(rendered.part("split-aside").getAttribute("data-state")).toBe("rail");
    expect(link().textContent).toBe("");
    expect(link().getAttribute("aria-label")).toBe("New");
    expect(rendered.part("split-bar").nextElementSibling).toBe(rendered.part("split-actions"));
    rendered.unmount();
    rendered = await show(split({ aside: withBar, toggle: { type: "icon", icon: null, label: "hidden" } }), true);
    expect(rendered.part("split-aside").getAttribute("data-state")).toBe("rail");
    expect(link().getAttribute("aria-label")).toBe("New");
    await rendered.click(rendered.part("split-toggle"));
    expect(rendered.parts("link").filter((entry) => entry.closest('[data-telo-part="surface-body"]'))).toEqual([]);
  });

  it("draws its toggle as a glyph named by its text, and carries its frame", async () => {
    rendered = await show(split({ frame: "framed", toggle: { type: "icon", icon: null, label: "hidden" } }));
    const toggle = rendered.part("split-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Hide Filters");
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector('[data-telo-part="icon"]')).not.toBeNull();
    expect([rendered.part("split"), rendered.part("split-aside")].map((part) => part.getAttribute("data-frame"))).toEqual(["framed", "framed"]);
  });

  it("marks the direct content of a flush split as embedded, and of a framed one not", async () => {
    const content = listingNode({ create: undefined, edit: undefined, delete: false, layout: { type: "list", content: { type: "value", value: { root: "row", path: ["text"] }, present: { type: "string" } }, reads: {} } });
    rendered = await show(split({ content }));
    expect([rendered.part("list-layout"), rendered.part("table-frame")].map((part) => part.getAttribute("data-embedded"))).toEqual(["true", "true"]);
    rendered.unmount();
    rendered = await show(split({ content, frame: "framed" }));
    expect([rendered.part("list-layout"), rendered.part("table-frame")].map((part) => part.getAttribute("data-embedded"))).toEqual([null, null]);
  });

  it("follows its content in document order with the aside at the end", async () => {
    rendered = await show(split({ side: "end" }));
    expect(rendered.part("split-content").compareDocumentPosition(rendered.part("split-aside")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the aside's listing on its page across the breakpoint", async () => {
    rendered = await show(split());
    await rendered.click(rendered.part("pager-next"));
    expect(rendered.part("pager-status").textContent).toBe("3–4 of 5");
    await rendered.setNarrow(true);
    expect(rendered.part("split").getAttribute("data-state")).toBe("compact");
    await rendered.click(rendered.part("split-toggle"));
    expect(rendered.part("pager-status").textContent).toBe("3–4 of 5");
  });

  it("starts from a stored fold over the one it declares, and stores each change", async () => {
    window.sessionStorage.setItem(key, JSON.stringify({ v: 1, collapsed: true }));
    rendered = await show(split({ collapse: { collapsed: false, state: { key: "filters", store: stored } } }));
    expect(rendered.part("split").getAttribute("data-state")).toBe("collapsed");
    await rendered.click(rendered.part("split-toggle"));
    expect(JSON.parse(window.sessionStorage.getItem(key) as string)).toEqual({ v: 1, collapsed: false });
  });

  it("closes its compact surface on a move within the application started from inside it", async () => {
    rendered = await render({
      path: "/",
      narrow: true,
      pages: {
        "/": { title: "Home", children: [split({ aside: { actions: [], content: wire({ type: "link", text: "Other", href: address("/other") }) } })] },
        "/other": { title: "Other", children: [] },
      },
    });
    await rendered.click(rendered.part("split-toggle"));
    expect(rendered.parts("split-aside").map((part) => part.getAttribute("data-state"))).toEqual(["rail", "compact"]);
    await rendered.click(rendered.part("link"));
    expect(rendered.parts("split-aside")).toHaveLength(0);
    expect(window.location.pathname).toBe("/other");
  });
});
