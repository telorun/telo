// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { dialogSurface, filterField, filtersNode, opener, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const show = (
  bar: Record<string, unknown>,
  options: { path?: string; prefix?: string; narrow?: boolean; bars?: number; table?: Record<string, unknown> } = {},
) =>
  render({
    path: options.path ?? "/",
    prefix: options.prefix,
    narrow: options.narrow,
    loadModule: loadFixtureComponents,
    collections: { "/api/todos": todos },
    pages: { "/": { title: "Todos", children: Array.from({ length: options.bars ?? 1 }, () => filtersNode(tableNode(options.table), bar)) } },
  });

/** The query the list was last asked with, the page size aside. */
const asked = (r: Rendered) =>
  r.requests
    .filter((request) => request.startsWith("GET /api/todos?"))
    .at(-1)!
    .replace("GET /api/todos?limit=2", "")
    .replace(/^&/, "");
const lists = (r: Rendered) => r.requests.filter((request) => request.startsWith("GET /api/todos?")).length;
const labels = (r: Rendered) => r.parts("filter-label").map((label) => label.textContent);
const filterOf = (r: Rendered, label: string) => r.parts("filter").find((filter) => filter.querySelector('[data-telo-part="filter-label"]')?.textContent === label)!;
const within = (element: Element, part: string) => element.querySelector(`[data-telo-part="${part}"]`) as HTMLElement;
const pick = async (r: Rendered, part: string, text: string) => r.click(r.parts(part).find((item) => item.textContent === text)!);
const key = async (r: Rendered, element: Element, name: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await r.settle();
};
const position = () => (window.history.state as { teloPosition: number }).teloPosition;

const done = (more: Record<string, unknown> = {}) => filterField("isDone", "eq", more);
const status = (more: Record<string, unknown> = {}) => filterField("status", "in", more);
const task = (more: Record<string, unknown> = {}) => filterField("text", "contains", more);
const kept = (state: Record<string, unknown>) => ({ state: { key: "todos", address: false, store: { type: "memory" }, ...state } });
const panel = (name: string) => ({ type: "panel", side: "end", size: "medium", dismiss: { escape: true, closeButton: true }, address: { name } });
const overlay = (surface: Record<string, unknown> = {}) => ({ type: "overlay", surface: { ...dialogSurface, ...surface } });
const titles = (r: Rendered) => r.parts("surface-title").map((title) => title.textContent);
const presets = [
  { label: "All", values: [] },
  { label: "Open", values: [{ property: "isDone", operator: "eq", value: [false] }] },
];

describe("a filter bar", () => {
  it("turns the browser's autocomplete off on every control typed into", async () => {
    rendered = await show({ fields: [task(), filterField("priority", "gte"), filterField("dueOn", "gte"), filterField("dueOn", "lte"), status({ control: "tags" })] });
    expect(rendered.parts("filter-input").map((input) => [input.getAttribute("type"), input.getAttribute("autocomplete")])).toEqual([
      ["text", "off"],
      ["number", "off"],
      ["date", "off"],
      ["date", "off"],
      ["text", "off"],
    ]);
  });

  it("shows the filters pinned, added or holding a value under `show: chosen`, and clears the one removed", async () => {
    rendered = await show({ show: "chosen", fields: [task({ pinned: true }), done(), status({ default: ["open"] }), filterField("priority", "gte")] });
    expect(labels(rendered)).toEqual(["Task", "Status"]);
    expect(asked(rendered)).toBe("status.in=open");
    // A pinned filter is never removable.
    expect(within(filterOf(rendered, "Task"), "filter-remove")).toBeNull();
    const add = rendered.part("filters-add");
    expect(add.hasAttribute("data-state")).toBe(false);
    await rendered.open(add);
    expect(rendered.parts("menu-item").map((item) => item.textContent)).toEqual(["Done", "Priority"]);
    await pick(rendered, "menu-item", "Done");
    expect(rendered.parts("menu")).toEqual([]);
    expect(labels(rendered)).toEqual(["Task", "Done", "Status"]);
    await rendered.choose(within(filterOf(rendered, "Done"), "filter-select"), "No");
    expect(asked(rendered)).toBe("isDone=false&status.in=open");
    await rendered.click(within(filterOf(rendered, "Done"), "filter-remove"));
    expect(labels(rendered)).toEqual(["Task", "Status"]);
    expect(asked(rendered)).toBe("status.in=open");
    // One removed with its declared default cleared is offered again, holding nothing.
    await rendered.click(within(filterOf(rendered, "Status"), "filter-remove"));
    expect(labels(rendered)).toEqual(["Task"]);
    expect(asked(rendered)).toBe("");
    await rendered.open(rendered.part("filters-add"));
    await pick(rendered, "menu-item", "Status");
    expect(labels(rendered)).toEqual(["Task", "Status"]);
    expect(within(filterOf(rendered, "Status"), "filter-select").textContent).toBe("Any");
  });

  it.each([
    [{ type: "above" }, null],
    [{ type: "aside", side: "start" }, "start"],
    [{ type: "aside", side: "end" }, "end"],
  ])("draws its controls in a bar beside what it filters: %o", async (placement, side) => {
    rendered = await show({ placement });
    const bar = rendered.part("filters");
    expect([bar.getAttribute("data-placement"), bar.getAttribute("data-side")]).toEqual([placement.type, side]);
    expect([...bar.children].map((child) => child.getAttribute("data-telo-part"))).toEqual(["filters-bar", "filters-content"]);
    expect(rendered.part("filters-bar").contains(rendered.part("filter"))).toBe(true);
    expect(rendered.part("filters-content").contains(rendered.part("table"))).toBe(true);
    expect(rendered.parts("filters-toggle")).toEqual([]);
  });

  it("folds behind a toggle counting the filters that hold a value, pinned ones staying outside", async () => {
    const fields = [task({ pinned: true }), done({ default: [false] }), status()];
    rendered = await show({ placement: { type: "collapsible", open: false }, fields });
    const toggle = rendered.part("filters-toggle");
    const bar = rendered.part("filters-bar");
    expect(rendered.part("filters").getAttribute("data-placement")).toBe("collapsible");
    expect([bar.getAttribute("data-state"), toggle.getAttribute("aria-expanded")]).toEqual(["closed", "false"]);
    expect(rendered.part("filters-count").textContent).toBe("1");
    expect(filterOf(rendered, "Task").parentElement).toBe(rendered.part("filters"));
    expect(bar.contains(filterOf(rendered, "Task"))).toBe(false);
    expect(bar.contains(filterOf(rendered, "Done"))).toBe(true);
    await rendered.click(toggle);
    expect([bar.getAttribute("data-state"), toggle.getAttribute("aria-expanded")]).toEqual(["open", "true"]);
    await rendered.choose(within(filterOf(rendered, "Done"), "filter-select"), "Any");
    expect(rendered.parts("filters-count")).toEqual([]);
    rendered.unmount();
    rendered = await show({ placement: { type: "collapsible", open: true }, fields });
    expect(rendered.part("filters-bar").getAttribute("data-state")).toBe("open");
  });

  it.each([
    ["dialog", dialogSurface],
    ["drawer", { type: "drawer", side: "end", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } }],
    ["popover", { type: "popover", side: "bottom", align: "start", dismiss: { escape: true, outside: true } }],
  ])("opens its controls in a %s that Done closes, pinned ones staying on the page", async (type, surface) => {
    rendered = await show({ placement: { type: "overlay", surface }, fields: [task({ pinned: true }), done({ control: "toggle" })] });
    expect(rendered.part("filters").getAttribute("data-placement")).toBe("overlay");
    expect(rendered.parts("filters-bar")).toEqual([]);
    expect(labels(rendered)).toEqual(["Task"]);
    expect(filterOf(rendered, "Task").parentElement).toBe(rendered.part("filters"));
    await rendered.click(rendered.part("filters-toggle"));
    const opened = rendered.part("surface");
    expect([opened.getAttribute("data-surface"), within(opened, "surface-title").textContent]).toEqual([type, "Filters"]);
    expect(within(opened, "filters-bar").contains(filterOf(rendered, "Done"))).toBe(true);
    expect(opened.contains(filterOf(rendered, "Task"))).toBe(false);
    await rendered.click(within(opened, "filter-toggle"));
    expect(asked(rendered)).toBe("isDone=true");
    const doneButton = within(opened, "submit");
    expect(doneButton.textContent).toBe("Done");
    await rendered.click(doneButton);
    expect(rendered.parts("surface")).toEqual([]);
    expect(rendered.part("filters-count").textContent).toBe("1");
  });

  it("opens an addressed overlay under its name with an empty value, as a history entry that back closes", async () => {
    const bar = { placement: { type: "overlay", surface: { ...dialogSurface, address: { name: "filters" } } } };
    rendered = await show(bar);
    await rendered.click(rendered.part("filters-toggle"));
    expect([window.location.search, position()]).toEqual(["?_telo.open.filters=", 1]);
    expect(rendered.parts("surface").length).toBe(1);
    await rendered.traverse(-1);
    expect([window.location.search, position(), rendered.parts("surface").length]).toEqual(["", 0, 0]);
    rendered.unmount();
    // A cold load opens it, and closing replaces the entry it arrived in.
    rendered = await show(bar, { path: "/?_telo.open.filters=" });
    await rendered.click(within(rendered.part("surface"), "submit"));
    expect([window.location.search, position(), rendered.parts("surface").length]).toEqual(["", 0, 0]);
  });

  it("draws no toggle and no fold where a folding placement has no filter to fold", async () => {
    rendered = await show(
      { placement: overlay({ address: { name: "filters" } }), fields: [task({ pinned: true }), done({ control: "none" })] },
      { path: "/?_telo.open.filters=" },
    );
    expect([rendered.part("filters").getAttribute("data-placement"), labels(rendered)]).toEqual(["overlay", ["Task"]]);
    // Nothing folds, so nothing opens — an address naming the overlay included.
    expect([rendered.parts("filters-toggle"), rendered.parts("filters-bar"), rendered.parts("surface")]).toEqual([[], [], []]);
    expect(rendered.part("filters-reset").parentElement).toBe(rendered.part("filters"));
  });

  it("honours the compact surface of its overlay below the application's breakpoint", async () => {
    const bar = { placement: overlay({ compact: { type: "drawer", side: "bottom", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } } }) };
    rendered = await show(bar, { narrow: true });
    await rendered.click(rendered.part("filters-toggle"));
    expect([rendered.part("surface").getAttribute("data-surface"), rendered.part("surface").getAttribute("data-side")]).toEqual(["drawer", "bottom"]);
    // A change made in it stays through the swap to the surface it stands in for.
    await rendered.enter(rendered.part("filter-input"), "the");
    await rendered.setNarrow(false);
    expect([rendered.part("surface").getAttribute("data-surface"), (rendered.part("filter-input") as HTMLInputElement).value]).toEqual(["dialog", "the"]);
  });

  it.each([
    ["dialog", dialogSurface],
    ["popover", { type: "popover", side: "bottom", align: "start", dismiss: { escape: true, outside: true } }],
  ])("keeps its %s overlay open through a touch press that moves the focus inside a chip's popover, and closes it on one outside", async (type, surface) => {
    rendered = await show({ controls: "chips", placement: { type: "overlay", surface }, fields: [filterField("dueOn", "gte"), filterField("dueOn", "lte")] });
    // A touch press is judged at its click, after the focus it moved.
    const touch = async (element: HTMLElement) => {
      await act(async () => {
        const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(down, "pointerType", { value: "touch" });
        element.dispatchEvent(down);
      });
      await act(async () => element.focus());
      await rendered!.click(element);
    };
    const drawn = () => rendered!.parts("surface").map((part) => part.querySelector('[data-telo-part="surface-title"]')?.textContent ?? "chip");
    await rendered.click(rendered.part("filters-toggle"));
    await rendered.click(rendered.part("filter-chip"));
    const [from, to] = rendered.parts("filter-input");
    await rendered.focus(from);
    await touch(to);
    expect([drawn(), document.activeElement === to]).toEqual([["Filters", "chip"], true]);
    await touch(rendered.part("page-title"));
    expect(drawn()).toEqual([]);
  });

  it("uses its compact placement below the application's breakpoint", async () => {
    const bar = { placement: { type: "aside", side: "start", compact: { type: "collapsible", open: false } } };
    rendered = await show(bar, { narrow: true });
    expect([rendered.part("filters").getAttribute("data-placement"), rendered.part("filters").getAttribute("data-side")]).toEqual(["collapsible", null]);
    expect(rendered.part("filters-bar").getAttribute("data-state")).toBe("closed");
    rendered.unmount();
    rendered = await show(bar);
    expect(rendered.part("filters").getAttribute("data-placement")).toBe("aside");
    expect(rendered.parts("filters-toggle")).toEqual([]);
  });

  it("draws each filter as a chip naming it and its value, which opens its control in a popover", async () => {
    rendered = await show({ controls: "chips", fields: [task(), done({ control: "options" })] });
    expect(rendered.parts("filter")).toEqual([]);
    const chip = rendered.parts("filter-chip")[1];
    expect(rendered.parts("filter-chip").map((each) => [each.textContent, each.getAttribute("data-state"), each.getAttribute("data-active")])).toEqual([
      ["Task", "closed", null],
      ["Done", "closed", null],
    ]);
    await rendered.click(chip);
    const popover = rendered.part("surface");
    expect(popover.getAttribute("data-surface")).toBe("popover");
    expect(labels(rendered)).toEqual(["Done"]);
    await pick(rendered, "filter-option", "No");
    expect(asked(rendered)).toBe("isDone=false");
    expect([chip.textContent, chip.getAttribute("data-state"), chip.getAttribute("data-active")]).toEqual(["Done: No", "open", "true"]);
    expect(rendered.part("filter").getAttribute("data-active")).toBe("true");
  });

  it("chooses one listed value from a `select`", async () => {
    rendered = await show({ fields: [filterField("status", "eq", { control: "select" })] });
    await rendered.choose(rendered.part("filter-select"), "blocked");
    expect(asked(rendered)).toBe("status=blocked");
  });

  it("chooses from `options` drawn side by side: one under `eq`, any number under `in`", async () => {
    rendered = await show({ fields: [done({ control: "options" }), status({ control: "options" })] });
    const [one, many] = rendered.parts("filter-options");
    expect([...one.children].map((option) => option.textContent)).toEqual(["Yes", "No"]);
    await rendered.click(one.children[1]);
    expect([asked(rendered), one.children[1].getAttribute("data-state"), one.children[0].getAttribute("data-state")]).toEqual(["isDone=false", "on", "off"]);
    await rendered.click(one.children[0]);
    expect(asked(rendered)).toBe("isDone=true");
    await rendered.click(one.children[0]);
    expect(asked(rendered)).toBe("");
    await rendered.click(many.children[0]);
    await rendered.click(many.children[2]);
    expect(asked(rendered)).toBe("status.in=open&status.in=done");
  });

  it("asks for the rows where a `toggle` holds while it is on, and for nothing while it is off", async () => {
    rendered = await show({ fields: [done({ control: "toggle" })] });
    const toggle = rendered.part("filter-toggle");
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    await rendered.click(toggle);
    expect([asked(rendered), toggle.getAttribute("data-state")]).toEqual(["isDone=true", "checked"]);
    await rendered.click(toggle);
    expect(asked(rendered)).toBe("");
  });

  it("sends the number a `slider` is moved to, within the property's bounds", async () => {
    rendered = await show({ fields: [filterField("priority", "gte", { control: "slider" })] });
    const thumb = rendered.part("filter-slider").querySelector('[role="slider"]') as HTMLElement;
    expect(["aria-valuemin", "aria-valuemax", "aria-valuetext"].map((name) => thumb.getAttribute(name))).toEqual(["1", "5", "Any"]);
    await key(rendered, thumb, "ArrowRight");
    await key(rendered, thumb, "ArrowRight");
    expect(asked(rendered)).toBe("priority.gte=3");
  });

  it("collects `tags` typed one at a time, each removed on its own", async () => {
    rendered = await show({ fields: [status({ control: "tags" })] });
    const input = within(rendered.part("filter-tags"), "filter-input");
    await rendered.enter(input, "open");
    await rendered.commit(input, "enter");
    await rendered.enter(input, "done");
    await key(rendered, input, ",");
    expect(rendered.parts("filter-tag").map((tag) => tag.textContent)).toEqual(["open", "done"]);
    expect(asked(rendered)).toBe("status.in=open&status.in=done");
    await rendered.click(rendered.parts("filter-tag-remove")[0]);
    expect(asked(rendered)).toBe("status.in=done");
  });

  it("draws a filter with no control nowhere, and still asks for what its default holds", async () => {
    rendered = await show({
      placement: { type: "collapsible", open: true },
      summary: "chips",
      fields: [task(), filterField("priority", "gte", { control: "none", default: [3] })],
    });
    expect(asked(rendered)).toBe("priority.gte=3");
    expect(labels(rendered)).toEqual(["Task"]);
    expect([rendered.parts("summary-chip"), rendered.parts("filters-count")]).toEqual([[], []]);
  });

  it("applies typed text after a pause under `apply: typing`, pending until then", async () => {
    rendered = await show({ apply: "typing" });
    const before = lists(rendered);
    for (const typed of ["t", "th", "the"]) await rendered.enter(rendered.part("filter-input"), typed);
    expect([lists(rendered), rendered.part("filters").getAttribute("data-pending")]).toEqual([before, "true"]);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 350)));
    await rendered.settle();
    expect([lists(rendered), asked(rendered), rendered.part("filters").getAttribute("data-pending")]).toEqual([before + 1, "text.contains=the", null]);
  });

  it("applies nothing entered in a control until Apply under `apply: button`, pending until then", async () => {
    rendered = await show({ apply: "button" });
    const before = lists(rendered);
    await rendered.choose(rendered.parts("filter-select")[0], "No");
    await rendered.enter(rendered.part("filter-input"), "the");
    await rendered.commit(rendered.part("filter-input"), "enter");
    expect([lists(rendered), rendered.part("filters").getAttribute("data-pending")]).toEqual([before, "true"]);
    // In a bar that does not fold, Apply and Reset close the row of controls.
    expect(["filters-apply", "filters-reset"].map((part) => rendered!.part(part).parentElement)).toEqual([rendered.part("filters-bar"), rendered.part("filters-bar")]);
    await rendered.click(rendered.part("filters-apply"));
    expect([lists(rendered), asked(rendered), rendered.part("filters").getAttribute("data-pending")]).toEqual([before + 1, "text.contains=the&isDone=false", null]);
  });

  it.each([
    ["collapsible", { type: "collapsible", open: false }],
    ["overlay", overlay()],
  ])("keeps Apply and Reset beside the toggle of a folded %s bar, where a pinned filter waits for Apply and a preset does not", async (type, placement) => {
    rendered = await show({ apply: "button", placement, presets, fields: [task({ pinned: true }), done({ control: "none" }), status()] });
    const before = lists(rendered);
    const pending = () => rendered!.part("filters").getAttribute("data-pending");
    expect([...rendered.part("filters").children].map((child) => child.getAttribute("data-telo-part"))).toEqual([
      "filters-presets",
      "filter",
      "filters-toggle",
      "filters-apply",
      "filters-reset",
      ...(type === "collapsible" ? ["filters-bar"] : []),
      "filters-content",
    ]);
    // A preset is a command: it reaches the list when it is chosen.
    await pick(rendered, "filters-preset", "Open");
    expect([lists(rendered), asked(rendered), pending()]).toEqual([before + 1, "isDone=false", null]);
    // Text typed into a pinned filter waits, and Apply is on the page without unfolding.
    await rendered.enter(rendered.part("filter-input"), "the");
    await rendered.commit(rendered.part("filter-input"), "enter");
    expect([lists(rendered), pending()]).toEqual([before + 1, "true"]);
    await rendered.click(rendered.part("filters-apply"));
    expect([asked(rendered), pending()]).toEqual(["text.contains=the&isDone=false", null]);
  });

  it("acts at once on a preset, a summary chip's removal and Reset under `apply: button`, applying with each whatever was waiting", async () => {
    rendered = await show({ apply: "button", summary: "chips", presets, fields: [task(), done(), status({ default: ["open"] })] });
    const before = lists(rendered);
    const pending = () => rendered!.part("filters").getAttribute("data-pending");
    const type = async (text: string) => {
      await rendered!.enter(rendered!.part("filter-input"), text);
      await rendered!.commit(rendered!.part("filter-input"), "enter");
    };
    await type("the");
    expect([lists(rendered), pending()]).toEqual([before, "true"]);
    await pick(rendered, "filters-preset", "Open");
    expect([lists(rendered), asked(rendered), pending()]).toEqual([before + 1, "text.contains=the&isDone=false&status.in=open", null]);
    await type("plan");
    expect([lists(rendered), pending()]).toEqual([before + 1, "true"]);
    await rendered.click(rendered.parts("summary-chip-remove").at(-1)!);
    expect([lists(rendered), asked(rendered), pending()]).toEqual([before + 2, "text.contains=plan&isDone=false", null]);
    await type("docs");
    await rendered.click(rendered.part("filters-reset"));
    expect([lists(rendered), asked(rendered), pending()]).toEqual([before + 3, "status.in=open", null]);
  });

  it("has no Apply button, and is pending only while typed text is uncommitted, under `apply: commit`", async () => {
    rendered = await show({});
    expect(rendered.parts("filters-apply")).toEqual([]);
    await rendered.enter(rendered.part("filter-input"), "the");
    expect(rendered.part("filters").getAttribute("data-pending")).toBe("true");
    await rendered.commit(rendered.part("filter-input"), "enter");
    expect(rendered.part("filters").getAttribute("data-pending")).toBeNull();
  });

  it("summarises the filters holding a value as chips, each removing its own", async () => {
    rendered = await show({ summary: "chips", fields: [task(), done({ default: [false] }), status({ default: ["open", "blocked"] })] });
    expect(rendered.part("filters-summary").previousElementSibling).toBe(rendered.part("filters-bar"));
    expect(rendered.parts("summary-chip").map((chip) => chip.textContent)).toEqual(["Done is No", "Status one of open, blocked"]);
    await rendered.click(rendered.parts("summary-chip-remove")[0]);
    expect(rendered.parts("summary-chip").map((chip) => chip.textContent)).toEqual(["Status one of open, blocked"]);
    expect(asked(rendered)).toBe("status.in=open&status.in=blocked");
  });

  it("returns to the declared defaults on Reset", async () => {
    rendered = await show({ fields: [task(), done({ default: [false] })] });
    await rendered.choose(rendered.part("filter-select"), "Yes");
    await rendered.enter(rendered.part("filter-input"), "plan");
    await rendered.commit(rendered.part("filter-input"), "enter");
    expect(asked(rendered)).toBe("text.contains=plan&isDone=true");
    await rendered.click(rendered.part("filters-reset"));
    expect([asked(rendered), rendered.part("filter-select").textContent, (rendered.part("filter-input") as HTMLInputElement).value]).toEqual(["isDone=false", "No", ""]);
  });

  it("sets the filters its presets name between them, and marks the preset its values are", async () => {
    rendered = await show({
      fields: [task(), done(), status()],
      presets: [
        { label: "Open", values: [{ property: "isDone", operator: "eq", value: [false] }, { property: "status", operator: "in", value: ["open"] }] },
        { label: "Finished", values: [{ property: "isDone", operator: "eq", value: [true] }] },
      ],
    });
    const states = () => rendered!.parts("filters-preset").map((preset) => preset.getAttribute("data-state"));
    expect(rendered.part("filters-presets").nextElementSibling).toBe(rendered.part("filters-bar"));
    expect(states()).toEqual(["off", "off"]);
    await rendered.enter(rendered.part("filter-input"), "the");
    await rendered.commit(rendered.part("filter-input"), "enter");
    await pick(rendered, "filters-preset", "Open");
    expect([asked(rendered), states()]).toEqual(["text.contains=the&isDone=false&status.in=open", ["on", "off"]]);
    // The other clears what it does not name of what the presets name, and leaves the rest.
    await pick(rendered, "filters-preset", "Finished");
    expect([asked(rendered), states()]).toEqual(["text.contains=the&isDone=true", ["off", "on"]]);
    // The active preset is read off the values, however they came to be.
    const [doneSelect, statusSelect] = rendered.parts("filter-select");
    await rendered.choose(doneSelect, "No");
    expect(states()).toEqual(["off", "off"]);
    await rendered.choose(statusSelect, "open");
    await rendered.escape();
    expect(states()).toEqual(["on", "off"]);
  });
});

describe("a filter bar's state", () => {
  const stored = (storage: Storage) => Object.fromEntries(Object.keys(storage).map((name) => [name, JSON.parse(storage.getItem(name) as string)]));
  const noDone = async (r: Rendered) => r.choose(r.parts("filter-select")[0], "No");

  it("is written nowhere when the bar declares no `state`", async () => {
    rendered = await show({});
    await noDone(rendered);
    expect([asked(rendered), window.location.search, stored(localStorage), stored(sessionStorage)]).toEqual(["isDone=false", "", {}, {}]);
  });

  it("is written into the address alone under `address: true`, replacing the entry and never adding one", async () => {
    rendered = await show({ ...kept({ address: true }), fields: [task(), done({ default: [true] }), status(), filterField("dueOn", "gte")] });
    const entries = window.history.length;
    expect(window.location.search).toBe("?_telo.f.todos.isDone=true");
    await rendered.choose(rendered.parts("filter-select")[1], "open");
    await rendered.choose(rendered.parts("filter-select")[1], "done");
    await rendered.escape();
    await rendered.enter(rendered.parts("filter-input")[1], "2026-10-05");
    await rendered.commit(rendered.parts("filter-input")[1], "enter");
    expect(window.location.search).toBe("?_telo.f.todos.isDone=true&_telo.f.todos.status.in=open&_telo.f.todos.status.in=done&_telo.f.todos.dueOn.gte=2026-10-05");
    // A default the user cleared is present and empty.
    await rendered.choose(rendered.parts("filter-select")[0], "Any");
    expect(window.location.search).toContain("?_telo.f.todos.isDone=&");
    expect([window.history.length, position(), stored(localStorage), stored(sessionStorage)]).toEqual([entries, 0, {}, {}]);
  });

  it("starts from the address when it carries any of the bar's keys, matched whole against the declared filters", async () => {
    localStorage.setItem("telo.ui:/:f:todos", JSON.stringify({ v: 1, values: { "text.contains": ["plan"] }, open: false }));
    rendered = await show(
      { ...kept({ address: true, store: { type: "local" } }), fields: [task(), done({ default: [false] }), status(), filterField("priority", "gte")] },
      { path: "/?x=1&_telo.f.todos.isDone=&_telo.f.todos.status.in=open&_telo.f.todos.status.in=done&_telo.f.todos.priority.gte=many&_telo.f.todos.status.in.more=1" },
    );
    expect(asked(rendered)).toBe("status.in=open&status.in=done");
    // A value its filter cannot hold is dropped; a key that is no declared filter's is not the bar's to touch.
    expect(window.location.search).toBe("?x=1&_telo.f.todos.status.in.more=1&_telo.f.todos.isDone=&_telo.f.todos.status.in=open&_telo.f.todos.status.in=done");
  });

  it.each([
    ["local", () => localStorage, () => sessionStorage],
    ["session", () => sessionStorage, () => localStorage],
  ] as const)("is written to %s storage alone under that store, and read from it at the next start", async (type, own, other) => {
    const bar = { ...kept({ store: { type } }), fields: [task(), done({ default: [true] })] };
    rendered = await show(bar);
    expect(stored(own())).toEqual({});
    await noDone(rendered);
    expect([stored(own()), stored(other()), window.location.search]).toEqual([{ "telo.ui:/:f:todos": { v: 1, values: { isDone: ["false"] }, open: false } }, {}, ""]);
    rendered.unmount();
    rendered = await show(bar);
    expect(asked(rendered)).toBe("isDone=false");
  });

  it("drops `false` read for a filter entered with a toggle, which holds true or nothing", async () => {
    sessionStorage.setItem("telo.ui:/:f:kept", JSON.stringify({ v: 1, values: { isDone: ["false"] }, open: false }));
    const fields = [done({ control: "toggle" })];
    rendered = await show({ ...kept({ address: true }), fields }, { path: "/?_telo.f.todos.isDone=false" });
    const drawn = () => [
      window.location.search,
      asked(rendered!),
      rendered!.part("filter-toggle").getAttribute("data-state"),
      rendered!.part("filter").getAttribute("data-active"),
    ];
    expect(drawn()).toEqual(["", "", "unchecked", null]);
    rendered.unmount();
    rendered = await show({ state: { key: "kept", address: false, store: { type: "session" } }, fields });
    expect([...drawn(), stored(sessionStorage)]).toEqual(["", "", "unchecked", null, { "telo.ui:/:f:kept": { v: 1, values: {}, open: false } }]);
  });

  it("is written to both the address and the store when the bar declares both", async () => {
    rendered = await show(kept({ address: true, store: { type: "session" } }));
    await noDone(rendered);
    expect([window.location.search, stored(sessionStorage), stored(localStorage)]).toEqual([
      "?_telo.f.todos.isDone=false",
      { "telo.ui:/:f:todos": { v: 1, values: { isDone: ["false"] }, open: false } },
      {},
    ]);
  });

  it("brings the entry an addressed overlay closes back to up to what was applied inside it", async () => {
    rendered = await show({
      ...kept({ address: true }),
      placement: overlay({ address: { name: "filters" } }),
      fields: [done({ control: "toggle" })],
    });
    await rendered.click(rendered.part("filters-toggle"));
    await rendered.click(rendered.part("filter-toggle"));
    expect(window.location.search).toBe("?_telo.open.filters=&_telo.f.todos.isDone=true");
    await rendered.click(within(rendered.part("surface"), "submit"));
    expect([window.location.search, position(), rendered.parts("surface").length]).toEqual(["?_telo.f.todos.isDone=true", 0, 0]);
  });

  it.each(["its close button", "a step back"])("keeps what was applied while a form was open in the address the form leaves by %s", async (how) => {
    rendered = await show({ ...kept({ address: true }), fields: [done()] }, { table: { edit: opener({ surface: panel("todo") }) } });
    await rendered.click(rendered.parts("row-edit")[0]);
    expect([window.location.search, position()]).toEqual(["?_telo.open.todo=1", 1]);
    await noDone(rendered);
    expect(window.location.search).toBe("?_telo.open.todo=1&_telo.f.todos.isDone=false");
    if (how === "a step back") await rendered.traverse(-1);
    else await rendered.click(rendered.part("surface-close"));
    expect([window.location.search, position(), rendered.parts("surface").length, asked(rendered)]).toEqual(["?_telo.f.todos.isDone=false", 0, 0, "isDone=false"]);
  });

  it("closes its overlay alone on Done: a form open beside it keeps its unsaved input, and nothing is asked", async () => {
    rendered = await show(
      { placement: overlay({ modal: false, address: { name: "filters" } }), fields: [done()] },
      { table: { edit: opener({ surface: panel("todo") }) } },
    );
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.enter(rendered.part("input"), "Half written");
    await rendered.click(rendered.part("filters-toggle"));
    expect([window.location.search, position(), titles(rendered)]).toEqual(["?_telo.open.todo=1&_telo.open.filters=", 2, ["Edit", "Filters"]]);
    await pick(rendered, "submit", "Done");
    expect([window.location.search, position(), titles(rendered), (rendered.part("input") as HTMLInputElement).value]).toEqual([
      "?_telo.open.todo=1",
      1,
      ["Edit"],
      "Half written",
    ]);
  });

  it("opens and closes together with a create form that shares its overlay's name", async () => {
    rendered = await show(
      { placement: overlay({ modal: false, address: { name: "todo" } }), fields: [done()] },
      { table: { create: opener({ surface: panel("todo") }) } },
    );
    await rendered.click(rendered.part("filters-toggle"));
    expect([window.location.search, position(), titles(rendered)]).toEqual(["?_telo.open.todo=", 1, ["New", "Filters"]]);
    await pick(rendered, "submit", "Done");
    expect([window.location.search, position(), titles(rendered)]).toEqual(["", 0, []]);
  });

  it("drops what a stored entry holds that the bar no longer declares or cannot hold, and rewrites it", async () => {
    const bar = { ...kept({ store: { type: "local" } }), placement: { type: "collapsible", open: false }, fields: [done(), filterField("priority", "gte")] };
    localStorage.setItem("telo.ui:/:f:todos", JSON.stringify({ v: 1, values: { isDone: ["false"], gone: ["x"], "priority.gte": ["many"] }, open: true }));
    rendered = await show(bar);
    expect(asked(rendered)).toBe("isDone=false");
    expect(stored(localStorage)).toEqual({ "telo.ui:/:f:todos": { v: 1, values: { isDone: ["false"] }, open: true } });
    // The fold the user chose is kept with it, and overrides the placement's own.
    expect(rendered.part("filters-bar").getAttribute("data-state")).toBe("open");
    await rendered.click(rendered.part("filters-toggle"));
    expect(stored(localStorage)["telo.ui:/:f:todos"].open).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("stores the fold its placement declares until the viewer chooses one", async () => {
    const bar = { ...kept({ store: { type: "local" } }), placement: { type: "collapsible", open: true }, fields: [done()] };
    rendered = await show(bar);
    await noDone(rendered);
    expect(stored(localStorage)).toEqual({ "telo.ui:/:f:todos": { v: 1, values: { isDone: ["false"] }, open: true } });
    rendered.unmount();
    rendered = await show(bar);
    expect([asked(rendered), rendered.part("filters-bar").getAttribute("data-state")]).toEqual(["isDone=false", "open"]);
  });

  it("discards an entry of another version", async () => {
    localStorage.setItem("telo.ui:/:f:todos", JSON.stringify({ v: 2, values: { isDone: ["false"] } }));
    rendered = await show({ ...kept({ store: { type: "local" } }), fields: [done({ default: [true] })] });
    expect(asked(rendered)).toBe("isDone=true");
    expect(stored(localStorage)).toEqual({ "telo.ui:/:f:todos": { v: 1, values: { isDone: ["true"] }, open: false } });
  });

  it("is kept apart for two applications mounted under different paths of one origin", async () => {
    const bar = kept({ store: { type: "local" } });
    rendered = await show(bar, { prefix: "/a" });
    await noDone(rendered);
    rendered.unmount();
    rendered = await show(bar, { prefix: "/b" });
    expect(asked(rendered)).toBe("");
    await rendered.choose(rendered.parts("filter-select")[0], "Yes");
    expect(stored(localStorage)).toEqual({
      "telo.ui:/a:f:todos": { v: 1, values: { isDone: ["false"] }, open: false },
      "telo.ui:/b:f:todos": { v: 1, values: { isDone: ["true"] }, open: false },
    });
  });

  it("stays in memory, saying so once, when the browser refuses the store", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await show(kept({ store: { type: "local" } }), { bars: 2 });
    await noDone(rendered);
    expect(asked(rendered)).toBe("isDone=false");
    expect(said.mock.calls).toEqual([["The browser refuses local storage, so filters are kept in memory: The operation is insecure."]]);
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("stays in memory, saying so once, when the browser reads the store and refuses to write it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("The quota has been exceeded.");
    });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await show(kept({ store: { type: "session" } }), { bars: 2 });
    await noDone(rendered);
    await rendered.choose(rendered.parts("filter-select")[0], "Yes");
    await rendered.choose(rendered.parts("filter-select")[2], "No");
    expect([rendered.parts("filters").length, rendered.parts("error"), asked(rendered)]).toEqual([2, [], "isDone=false"]);
    expect(said.mock.calls).toEqual([["The browser refuses session storage, so filters are kept in memory: The quota has been exceeded."]]);
  });
});
