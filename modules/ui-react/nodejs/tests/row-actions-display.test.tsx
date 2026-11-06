// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeRowActions } from "../src/browser/row-actions-display.js";
import { render, type Rendered } from "./harness.js";
import { listingNode, operation, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

describe("the judgement of how a listing's record actions are drawn", () => {
  it("is inline while nothing outgrows its room, and a menu otherwise", () => {
    expect(judgeRowActions("inline", { width: 500, shortage: 0 }, 0)).toEqual({ display: "inline", needs: 0 });
    expect(judgeRowActions("inline", { width: 500, shortage: 30 }, 0)).toEqual({ display: "menu", needs: 530 });
  });

  it("does not return to inline at the width that made it a menu, only at a wider one", () => {
    const outgrown = judgeRowActions("inline", { width: 500, shortage: 30 }, 0);
    expect(judgeRowActions("menu", { width: 500, shortage: 0 }, outgrown.needs).display).toBe("menu");
    expect(judgeRowActions("menu", { width: 529, shortage: 0 }, outgrown.needs).display).toBe("menu");
    expect(judgeRowActions("menu", { width: 530, shortage: 0 }, outgrown.needs).display).toBe("inline");
  });

  it("settles when widening still outgrows, asking for the wider container each time", () => {
    let needs = 0;
    const at = (held: "inline" | "menu", width: number, shortage: number) => {
      const judged = judgeRowActions(held, { width, shortage }, needs);
      needs = judged.needs;
      return judged.display;
    };
    expect(at("inline", 500, 30)).toBe("menu");
    expect(at("menu", 530, 0)).toBe("inline");
    expect(at("inline", 530, 5)).toBe("menu");
    expect(at("menu", 530, 0)).toBe("menu");
    expect(at("menu", 535, 0)).toBe("inline");
  });
});

/** The container's, a record's and each action's width, as a layout engine would measure them. */
let containerWidth = 0;
let recordWidth = 0;
/** Whether the layout puts a record's content on the line its actions are on. */
let sameLine = false;
const BUTTON = 80;
const RECORDS = ["list-item", "card", "board-card"];
const observers: (() => void)[] = [];

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observers.push(this.callback);
  }
  disconnect() {
    observers.splice(observers.indexOf(this.callback), 1);
  }
}

const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
const scrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
const rect = Element.prototype.getBoundingClientRect;
const global = globalThis as { ResizeObserver?: unknown };
const observer = global.ResizeObserver;
const partOf = (element: Element) => element.getAttribute("data-telo-part") ?? "";

beforeEach(() => {
  global.ResizeObserver = FakeResizeObserver;
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      const part = partOf(this);
      if (part === "listing-main" || part === "table-frame") return containerWidth;
      return RECORDS.includes(part) ? recordWidth : 0;
    },
  });
  // The grid is as wide as its actions need while they are inline.
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get(this: Element) {
      return partOf(this) === "table-frame" && this.querySelector('[data-telo-part="row-action"]') ? Math.max(containerWidth, 800) : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const parent = this.parentElement;
    if (parent && partOf(parent) === "row-actions") return { width: BUTTON, top: 0, bottom: 10 } as DOMRect;
    if (partOf(this) === "row-actions") return { width: 0, top: 0, bottom: 10 } as DOMRect;
    const inRecord = parent && RECORDS.includes(partOf(parent));
    return (inRecord && !sameLine ? { width: 0, top: 20, bottom: 30 } : { width: 0, top: 0, bottom: 10 }) as DOMRect;
  };
});

afterEach(() => {
  global.ResizeObserver = observer;
  Object.defineProperty(Element.prototype, "clientWidth", clientWidth!);
  Object.defineProperty(Element.prototype, "scrollWidth", scrollWidth!);
  Element.prototype.getBoundingClientRect = rect;
});

const row = (...path: string[]) => ({ root: "row", path });
const archive = {
  action: operation("/api/todos/archive", "Archive", { type: "object", properties: { id: { type: "integer" } } }),
  inputs: { id: row("id") },
  enabled: { at: row("isDone"), matches: { const: false }, disabledText: "Already done." },
};
const rename = {
  action: operation("/api/todos/rename", "Rename", { type: "object", properties: { text: { type: "string" } } }),
  inputs: { text: row("text") },
  confirm: "Rename this task?",
};
// The widest record holds five elements of 80 — the failing condition's text among them — so the container must be 800 wide.
const acting = (overrides: Record<string, unknown> = {}) => listingNode({ rowActions: [archive, rename], create: undefined, ...overrides });
const show = (children: unknown[]) =>
  render({ path: "/", required: ["text"], collections: { "/api/todos": todos }, pages: { "/": { title: "Todos", children: children as never } } });

const resize = (width: number, record = recordWidth) =>
  act(async () => {
    containerWidth = width;
    recordWidth = record;
    for (const callback of [...observers]) callback();
  });
const displays = (r: Rendered) => r.parts("row-actions").map((each) => each.getAttribute("data-display"));
/** The one display every record shares. */
const drawn = (r: Rendered) => [...new Set(displays(r))];
const content = { type: "value", value: row("text"), present: { type: "string" } };
const statuses = { property: "status", values: "all", enum: ["open", "blocked", "done"], labels: [] };
const layouts: Record<string, Record<string, unknown>> = {
  list: { type: "list", content, reads: {} },
  cards: { type: "cards", content, size: "medium", reads: {} },
  board: { type: "board", content, reads: { groups: statuses } },
};

describe("a listing's record actions", () => {
  it("are inline in a table whose grid fits its frame and one menu button per record when it does not, switching once each way", async () => {
    containerWidth = 900;
    rendered = await show([acting()]);
    expect(displays(rendered)).toEqual(["inline", "inline"]);
    expect(rendered.parts("row-action")).toHaveLength(4);
    expect(rendered.parts("row-menu")).toHaveLength(0);

    await resize(500);
    expect(displays(rendered)).toEqual(["menu", "menu"]);
    expect(rendered.parts("row-menu")).toHaveLength(2);
    expect(rendered.parts("row-action")).toHaveLength(0);
    expect(rendered.part("row-menu").getAttribute("aria-label")).toBe("Actions");

    await resize(799);
    expect(displays(rendered)).toEqual(["menu", "menu"]);
    await resize(800);
    expect(displays(rendered)).toEqual(["inline", "inline"]);
  });

  // The widest record holds five elements of 80 — the failing condition's text among them — so its actions are 400 wide.
  it.each([
    ["list", "a list row, whose content shares the line and keeps half the row", true, 1600, 700],
    ["cards", "a card, whose actions have a line of their own", false, 1000, 399],
    ["board", "a board card, whose actions have a line of their own", false, 1000, 399],
  ])("in a %s layout judge the room of %s, not the listing's width", async (type, name, shares, enough, short) => {
    sameLine = shares;
    // A wide listing, as a small card in a large listing would be: the record's room decides.
    containerWidth = 1000;
    rendered = await show([acting({ layout: layouts[type] })]);
    await resize(1000, enough);
    expect(drawn(rendered)).toEqual(["inline"]);

    await resize(1000, short);
    expect(drawn(rendered)).toEqual(["menu"]);
    expect(rendered.parts("row-menu").length).toBe(rendered.parts("row-actions").length);

    // Not back at the width that made it a menu, only at a wider one.
    await resize(1000, enough);
    expect(drawn(rendered)).toEqual(["menu"]);
    await resize(1500, enough);
    expect(drawn(rendered)).toEqual(["inline"]);
  });

  it("are a menu of the actions, edit and delete when written so, a failing condition a disabled entry with its hint", async () => {
    containerWidth = 900;
    rendered = await show([acting({ rowActionsDisplay: "menu", edit: undefined, delete: true })]);
    expect(rendered.parts("row-edit")).toHaveLength(0);
    await rendered.click(rendered.parts("row-menu")[0]);
    const items = [...document.querySelectorAll<HTMLElement>('[data-telo-part="menu-item"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Archive", "Rename", "Delete"]);
    // The first record is done: archiving is not offered it.
    expect(items.map((item) => item.getAttribute("aria-disabled"))).toEqual(["true", null, null]);
    expect(items[0].getAttribute("title")).toBe("Already done.");

    await rendered.click(items[1]);
    expect(document.querySelector('[data-surface="confirmation"]')).not.toBeNull();
    expect(rendered.sent).toEqual([]);
  });
});
