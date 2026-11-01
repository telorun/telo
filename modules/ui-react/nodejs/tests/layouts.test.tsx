// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { FakeIntersections } from "./intersections.js";
import { filterField, filtersNode, listingNode, opener, operation, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  FakeIntersections.all = [];
  vi.useRealTimers();
});

// Imported before any test renders: an import begun inside a render can outlast
// the turns `render` waits for.
const fixtureLayouts = (await import("../../tests/__fixtures__/components/nodejs/src/layouts.js")) as Record<string, unknown>;

const row = (...path: string[]) => ({ root: "row", path });
const content = { type: "value", value: row("text"), present: { type: "string" } };
const inline = { type: "inline" };
const listOf = (overrides: Record<string, unknown> = {}) =>
  listingNode({ rowStyle: undefined, create: undefined, edit: undefined, delete: false, layout: { type: "list", content, reads: {} }, ...overrides });
const statuses = { property: "status", values: "all", enum: ["open", "blocked", "done"], labels: [] };
/** The move setting a record's status, posted to an operation that rewrites the record. */
const moveStatus = {
  action: operation("/api/moves", "Move", { type: "object", properties: { id: { type: "integer" }, status: { type: "string" } } }),
  inputs: { id: row("id"), status: { root: "to", path: ["status"] } },
};
const board = (overrides: Record<string, unknown> = {}) =>
  listingNode({ rowStyle: undefined, create: undefined, edit: undefined, delete: false, layout: { type: "board", content, move: moveStatus, reads: { groups: statuses } }, ...overrides });
const cardsOf = (overrides: Record<string, unknown> = {}) =>
  listingNode({ rowStyle: undefined, create: undefined, edit: undefined, delete: false, layout: { type: "cards", content, size: "medium", reads: {} }, ...overrides });
const show = (children: unknown[], rows: Record<string, unknown>[] = todos, more: Record<string, Record<string, unknown>[]> = {}) =>
  render({ path: "/", loadModule: loadFixtureComponents, required: ["text"], collections: { "/api/todos": rows, ...more }, pages: { "/": { title: "Todos", children: children as never } } });
const lists = (r: Rendered) => r.requests.filter((request) => request.startsWith("GET /api/todos?"));
const texts = (r: Rendered, part: string) => r.parts(part).map((each) => each.querySelector('[data-telo-part="value"]')?.textContent);

/** Answer the move operation by rewriting the record through the collection, as a route would. */
function movesThrough(r: Rendered) {
  r.answer("/api/moves", async () => {
    const sent = r.sent.at(-1)?.body as { id: number; status: string };
    const held = await (await fetch(`/api/todos/${sent.id}`)).json();
    const written = await (await fetch(`/api/todos/${sent.id}`, { method: "PUT", body: JSON.stringify({ ...held, status: sent.status }) })).json();
    return new Response(JSON.stringify(written), { status: 200, headers: { "content-type": "application/json" } });
  });
}

/** Drag one element and drop it on another, as a pointer does. */
async function drag(r: Rendered, from: Element, onto: Element) {
  await act(async () => {
    from.dispatchEvent(new Event("dragstart", { bubbles: true }));
    onto.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    onto.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    from.dispatchEvent(new Event("dragend", { bubbles: true }));
  });
  await r.settle();
}

describe("a list layout", () => {
  it("under scroll loads the next page when its end comes into view, and through its Load more from the keyboard", async () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersections;
    rendered = await show([listOf({ paging: "scroll" })]);
    await rendered.focus(rendered.part("load-more"));
    await act(async () => {
      rendered!.part("load-more").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      rendered!.part("load-more").click();
    });
    await rendered.settle();
    expect(rendered.parts("list-item")).toHaveLength(4);
    expect(document.activeElement).toBe(rendered.part("load-more"));
    await FakeIntersections.show(rendered.part("load-more"), true, rendered);
    expect(texts(rendered, "list-item")).toEqual(["Write the plan", "Review the plan", "Ship the renderer", "Write the docs", "Record the demo"]);
    expect(rendered.part("pager-status").textContent).toBe("1–5 of 5");
  });

  it("re-reads its three loaded pages on a write and keeps each record's element; a filter change returns it to its first page", async () => {
    rendered = await show([filtersNode(listOf({ paging: "more", edit: opener() }))]);
    await rendered.click(rendered.part("load-more"));
    await rendered.click(rendered.part("load-more"));
    const first = rendered.parts("list-item")[0];
    await rendered.click(rendered.parts("row-edit")[3]);
    await rendered.enter(rendered.part("input"), "Write the docs again");
    await rendered.click(rendered.part("submit"));
    expect(lists(rendered).slice(3)).toEqual(["GET /api/todos?limit=2", "GET /api/todos?limit=2&cursor=Mg", "GET /api/todos?limit=2&cursor=NA"]);
    expect(texts(rendered, "list-item")[3]).toBe("Write the docs again");
    expect(rendered.parts("list-item")[0]).toBe(first);
    await rendered.choose(rendered.parts("filter-select")[0], "No");
    expect(rendered.parts("list-item")).toHaveLength(2);
    expect(lists(rendered).at(-1)).toBe("GET /api/todos?limit=2&isDone=false");
  });

  it("with twelve pages loaded reloads the first alone, in place, and draws the written record from the write's answer", async () => {
    const many = Array.from({ length: 13 }, (_, index) => ({ id: index + 1, text: `Task ${index + 1}` }));
    rendered = await show([listOf({ paging: "more", pageSize: 1, edit: opener() })], many);
    for (let page = 1; page < 12; page++) await rendered.click(rendered.part("load-more"));
    const first = rendered.parts("list-item")[0];
    const before = lists(rendered).length;
    await rendered.click(rendered.parts("row-edit")[11]);
    await rendered.enter(rendered.part("input"), "Task twelve, rewritten");
    await rendered.click(rendered.part("submit"));
    expect(lists(rendered).slice(before)).toEqual(["GET /api/todos?limit=1"]);
    expect(rendered.parts("list-item")).toHaveLength(12);
    expect(rendered.parts("list-item")[0]).toBe(first);
    expect(texts(rendered, "list-item")[11]).toBe("Task twelve, rewritten");
  });

  it("sorts through its sort control, ascending then descending, from the first page", async () => {
    rendered = await show([listOf({ paging: "more" })]);
    await rendered.click(rendered.part("load-more"));
    await rendered.click(rendered.parts("listing-sort-option")[0]);
    await rendered.click(rendered.parts("listing-sort-option")[0]);
    expect(lists(rendered).slice(2)).toEqual(["GET /api/todos?limit=2&sort=text", "GET /api/todos?limit=2&sort=-text"]);
    expect(rendered.parts("listing-sort-option")[0].getAttribute("data-sorted")).toBe("desc");
  });
});

describe("a card layout", () => {
  it("as a listing's compact layout keeps an open edit form and what it holds across the breakpoint", async () => {
    rendered = await show([listingNode({ compact: { type: "cards", content, size: "small", reads: {} } })]);
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.enter(rendered.part("input"), "Still typing");
    await rendered.setNarrow(true);
    expect(rendered.parts("card")).toHaveLength(2);
    expect(rendered.part("cards-layout").getAttribute("data-size")).toBe("small");
    expect((rendered.part("input") as HTMLInputElement).value).toBe("Still typing");
    expect(lists(rendered)).toHaveLength(1);
  });
});

describe("a board layout", () => {
  it("reads a column per group, each headed by its total, and pages each column on its own", async () => {
    rendered = await show([board()]);
    expect(rendered.parts("board-heading").map((heading) => heading.textContent)).toEqual(["open (3)", "blocked (1)", "done (1)"]);
    expect(lists(rendered)).toEqual(["GET /api/todos?limit=2&status=open", "GET /api/todos?limit=2&status=blocked", "GET /api/todos?limit=2&status=done"]);
    await rendered.click(rendered.parts("board-column")[0].querySelector('[data-telo-part="load-more"]') as Element);
    expect(lists(rendered).at(-1)).toBe("GET /api/todos?limit=2&cursor=Mg&status=open");
    expect(texts(rendered, "board-card")).toEqual(["Review the plan", "Write the docs", "Record the demo", "Ship the renderer", "Write the plan"]);
  });

  it("runs the move on a drag with to.status set; every listing and present filter over the collection reads again", async () => {
    const present = filtersNode({ type: "stack", children: [board(), cardsOf()] }, { fields: [filterField("status", "in", { values: "present" })] });
    rendered = await show([present]);
    movesThrough(rendered);
    const counted = async () => rendered!.choices(rendered!.parts("filter-select")[0]);
    expect(await counted()).toEqual(["blocked (1)", "done (1)", "open (3)"]);
    const reads = lists(rendered).length;
    const card = rendered.parts("board-card").find((each) => each.textContent?.includes("Review the plan")) as HTMLElement;
    await drag(rendered, card, rendered.parts("board-column")[2]);
    expect(rendered.sent[0]).toEqual({ request: "POST /api/moves", contentType: "application/json", body: { id: 2, status: "done" } });
    // Three columns and the cards, each read again, and the facet behind the filter.
    const again = lists(rendered).slice(reads);
    expect(again.filter((request) => request.includes("status=")).length).toBeGreaterThanOrEqual(3);
    expect(again).toContain("GET /api/todos?limit=2");
    expect(again.some((request) => request.includes("facet=status"))).toBe(true);
    expect(rendered.parts("board-heading").map((heading) => heading.textContent)).toEqual(["open (2)", "blocked (1)", "done (2)"]);
    expect(await counted()).toEqual(["blocked (1)", "done (2)", "open (2)"]);
  });

  it("keeps an inline edit form's entered values across the reload a move of another record causes", async () => {
    rendered = await show([board({ edit: opener({ surface: inline }) })]);
    movesThrough(rendered);
    const cards = () => rendered!.parts("board-card");
    const writing = cards().find((each) => each.textContent?.includes("Write the docs")) as HTMLElement;
    await rendered.click(writing.querySelector('[data-telo-part="row-edit"]') as Element);
    await rendered.enter(rendered.part("input"), "Half typed");
    // The other record goes by its "Move to" menu, the keyboard path of the gesture.
    const moving = cards().find((each) => each.textContent?.includes("Ship the renderer")) as HTMLElement;
    await rendered.click(moving.querySelector('[data-telo-part="record-move"]') as Element);
    await rendered.click(rendered.parts("menu-item").find((item) => item.textContent === "done") as Element);
    expect(rendered.sent[0].body).toEqual({ id: 3, status: "done" });
    expect(rendered.parts("board-heading").map((heading) => heading.textContent)).toEqual(["open (3)", "blocked (0)", "done (2)"]);
    const detail = rendered.part("listing-detail");
    expect(detail.closest('[data-telo-part="board-card"]')?.textContent).toContain("Write the docs");
    expect((detail.querySelector('[data-telo-part="input"]') as HTMLInputElement).value).toBe("Half typed");
  });

  it("opens the create form holding a column's value", async () => {
    rendered = await show([board({ create: opener() })]);
    await rendered.click(rendered.parts("record-create")[1]);
    await rendered.enter(rendered.part("input"), "Unblock the release");
    await rendered.click(rendered.part("submit"));
    expect(rendered.sent.at(-1)).toMatchObject({ request: "POST /api/todos", body: { text: "Unblock the release", status: "blocked" } });
  });
});

describe("a tree layout", () => {
  const people = [
    { id: 1, text: "Ada", managerId: null },
    { id: 2, text: "Grace", managerId: 1 },
    { id: 3, text: "Linus", managerId: 1 },
  ];
  const tree = () => listOf({ layout: { type: "tree", content, reads: { parent: "managerId" } } });

  it("reads its roots, a record's children on expand, and keeps what is expanded across a reload", async () => {
    const notifier = { type: "component", module: { digest: "cc", name: "components.js" }, export: "HostProbe", abi: "ui_react-1", external: ["react"], stylesheets: [], props: { basePath: { value: "/api/todos" } } };
    rendered = await show([tree(), notifier], people);
    expect(lists(rendered)).toEqual(["GET /api/todos?limit=2&managerId.absent=true"]);
    await rendered.click(rendered.part("tree-toggle"));
    expect(lists(rendered).at(-1)).toBe("GET /api/todos?limit=2&managerId=1");
    expect(texts(rendered, "tree-item")).toEqual(["Ada", "Grace", "Linus"]);
    const before = lists(rendered).length;
    await rendered.click(rendered.fixture("notify"));
    expect(lists(rendered).slice(before)).toEqual(["GET /api/todos?limit=2&managerId.absent=true", "GET /api/todos?limit=2&managerId=1"]);
    expect(rendered.part("tree-item").getAttribute("aria-expanded")).toBe("true");
    expect(texts(rendered, "tree-item")).toEqual(["Ada", "Grace", "Linus"]);
  });
});

describe("a calendar layout", () => {
  it("reads every page of the month shown, and the next month when asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    rendered = await show([listOf({ layout: { type: "calendar", period: "month", content, reads: { span: { start: "dueOn", format: "date" } } } })]);
    expect(lists(rendered)).toEqual([
      "GET /api/todos?limit=2&dueOn.gte=2026-10-01&dueOn.lte=2026-10-31",
      "GET /api/todos?limit=2&cursor=Mg&dueOn.gte=2026-10-01&dueOn.lte=2026-10-31",
      "GET /api/todos?limit=2&cursor=NA&dueOn.gte=2026-10-01&dueOn.lte=2026-10-31",
    ]);
    expect(rendered.part("calendar-title").textContent).toBe("October 2026");
    expect(rendered.parts("calendar-event")).toHaveLength(5);
    await rendered.click(rendered.part("calendar-next"));
    expect(lists(rendered).at(-1)).toBe("GET /api/todos?limit=2&dueOn.gte=2026-11-01&dueOn.lte=2026-11-30");
  });
});

describe("a component layout", () => {
  it("is given the records with their bound props, and reads the next page on the end it reports", async () => {
    const strip = { type: "component", module: { digest: "cc", name: "layouts.js" }, export: "RecordStrip", abi: "ui_react_layouts-1", external: ["react"], stylesheets: [], props: { title: { value: "Tasks" }, text: row("text") }, reads: {} };
    rendered = await render({
      path: "/",
      loadModule: async () => fixtureLayouts,
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Todos", children: [listOf({ paging: "more", layout: strip })] as never } },
    });
    expect(rendered.fixture("strip-title").textContent).toBe("Tasks");
    await rendered.click(rendered.fixture("strip-more"));
    expect([...document.querySelectorAll('[data-fixture="chip"]')].map((chip) => chip.textContent)).toEqual(["Write the plan", "Review the plan", "Ship the renderer", "Write the docs"]);
    expect(lists(rendered)).toEqual(["GET /api/todos?limit=2", "GET /api/todos?limit=2&cursor=Mg"]);
  });
});

interface ReadsRow {
  name: string;
  listing: { basePath: string; pageSize: number; filters: [string, string][]; bar: [string, string][] };
  reads: Record<string, any>;
  read: { group?: string; period?: { from: string; to: string }; parent?: string };
  event: string;
  requests: { path: string; params: [string, string][] }[];
}

const { rows } = JSON.parse(readFileSync(join(process.cwd(), "../../ui/conformance/listing-reads.json"), "utf8")) as { rows: ReadsRow[] };

/**
 * Each row of `ui`'s conformance reading one position of a plan's dimension,
 * drawn by the built-in layout of that plan: what it sends — the viewer's sort
 * and the bar's filters, the listing's own state the read-plan rows pin, left
 * out — is the row's request.
 */
describe("the built-in layouts send the conformance rows' reads", () => {
  const drawn = rows.filter((each) => each.event === "open" && each.listing.bar.length === 0 && (each.reads.span || each.reads.parent !== undefined || each.reads.groups));
  it.each(drawn.map((each) => [each.name, each] as const))("%s", async (_, each) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${each.read.period?.from.slice(0, 10) ?? "2026-10-15"}T12:00:00Z`));
    const { reads } = each;
    const layout = reads.span
      ? reads.groups
        ? { type: "timeline", scale: "week", content, reads }
        : { type: "calendar", period: "month", content, reads }
      : reads.parent !== undefined
        ? { type: "tree", content, reads }
        : { type: "board", content, reads };
    const related = reads.groups?.relation;
    const lanes = related ? { [related]: { type: "collection", schema: { type: "object" }, value: row("id"), label: row("id"), basePath: "/api/lanes", filters: {}, pageSize: 25 } } : {};
    rendered = await render({
      path: "/",
      collections: { [each.listing.basePath]: [{ id: 42, managerId: null }], "/api/lanes": [{ id: 4 }] },
      pages: {
        "/": {
          title: "Rows",
          children: [
            listOf({
              basePath: each.listing.basePath,
              pageSize: each.listing.pageSize,
              filters: Object.fromEntries(each.listing.filters.map(([name, value]) => [name, { value }])),
              relations: lanes,
              layout,
            }),
          ] as never,
        },
      },
    });
    if (each.read.parent !== undefined) await rendered.click(rendered.part("tree-toggle"));
    const asked = rendered.requests.filter((request) => request.startsWith(`GET ${each.listing.basePath}?`));
    const expected = each.requests.map(({ path, params }) => `GET ${path}?${new URLSearchParams(params.filter(([name]) => name !== "sort")).toString()}`);
    for (const request of expected) expect(asked).toContain(request);
  });
});
