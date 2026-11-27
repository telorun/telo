// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStore } from "../src/browser/host.js";
import { loadFixtureComponents, render, wireText, type Rendered } from "./harness.js";
import {
  address,
  buttonOf,
  call,
  component,
  defaultFailure,
  dialogSurface,
  formNode,
  listingNode,
  mutationSpec,
  navigateTo,
  openPageAt,
  queryNode,
  recordPages,
  todos,
} from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, detail: string) => json({ type: "about:blank", title: "Failed", status, detail, code: "ERR_TEST" }, status);

const row = (...path: string[]) => ({ root: "row", path });
const data = (...path: string[]) => ({ root: "data", path });
const result = (...path: string[]) => ({ root: "result", path });
const input = (...path: string[]) => ({ root: "input", path });
const error = (...path: string[]) => ({ root: "error", path });
const say = (source: string, values?: Record<string, unknown>) => ({ ...wireText(source), ...(values ? { values } : {}) });
const toast = (text: string, tone = "success", more: Record<string, unknown> = {}, values?: Record<string, unknown>) => ({ type: "toast", text: say(text, values), tone, ...more });
const danger = (text: string, values?: Record<string, unknown>) => toast(text, "danger", {}, values);

const item = { type: "object", properties: { id: { type: "integer" } } };
const drawer = { type: "drawer", side: "end", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };

/** The buttons of a toast's call and link, by their words. */
const action = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-telo-part="toast-actions"] > *')].find((each) => each.textContent === label) as HTMLElement;
const shown = () => [...document.querySelectorAll('[data-telo-part="toast-text"]')].map((each) => each.textContent);
const dismissButtons = () => [...document.querySelectorAll<HTMLElement>('[data-telo-part="toast"] > button[aria-label]')];
const surface = (kind: string) => document.querySelector(`[data-surface="${kind}"]`);
const writes = (r: Rendered) => r.requests.filter((request) => !request.startsWith("GET"));

const undo = (more: Record<string, unknown> = {}) => ({
  mutation: mutationSpec("/api/todos/restore", item),
  inputs: { id: result("id") },
  label: wireText("Undo"),
  onSuccess: [toast("Restored.")],
  onFailure: [danger("Could not undo: {$message}", { message: error("message") })],
  ...more,
});
const archiveToast = (more: Record<string, unknown> = {}) =>
  toast("{$name} archived.", "success", { link: { label: wireText("View"), to: openPageAt(address("/todos/{id}", { id: result("id") })) }, call: undo(), ...more }, { name: result("text") });
const archiveMutation = mutationSpec("/api/todos/archive", item);
const archiving = (overrides: Record<string, unknown> = {}) =>
  call("/api/todos/archive", "Archive", item, {
    inputs: { id: row("id") },
    onSuccess: [archiveToast()],
    onFailure: [
      toast("Could not archive: {$message}", "warning", {
        call: { mutation: archiveMutation, inputs: { id: input("id") }, label: wireText("Retry"), onSuccess: [toast("{$name} archived.", "success", {}, { name: result("text") })], onFailure: [danger("Retry failed.")] },
      }, { message: error("message") }),
    ],
    ...overrides,
  });
const listing = (overrides: Record<string, unknown> = {}) => listingNode({ rowActions: [archiving()], create: null, edit: null, delete: false, ...overrides });
const show = (children: unknown[], more: Record<string, unknown> = {}) =>
  render({ path: "/", loadModule: loadFixtureComponents, required: ["text"], collections: { "/api/todos": todos }, pages: { "/": { title: "Todos", children: children as never }, ...recordPages() }, ...more } as never);

describe("a toast posted by a call", () => {
  it("outlives the row it was posted for: its View opens the page in a default dialog, its Undo posts its own onSuccess", async () => {
    rendered = await show([listing()]);
    let archived = false;
    rendered.answer("/api/todos", ({ url }) => {
      if (url.pathname === "/api/todos/archive") return ((archived = true), json({ id: 1, text: "Write the plan" }));
      if (url.pathname === "/api/todos/restore") return new Response(null, { status: 204 });
      // The reload the archive triggers no longer lists the record.
      if (url.pathname === "/api/todos") return json({ rows: archived ? [] : todos.slice(0, 2), total: archived ? 0 : 2, next: null });
      return json(todos[0]);
    });
    await rendered.click(rendered.parts("row-action")[0]);
    expect([rendered.parts("table-row").length, shown()]).toEqual([0, ["Write the plan archived."]]);
    await rendered.click(action("View"));
    expect(surface("dialog")).not.toBeNull();
    await rendered.escape();
    expect(surface("dialog")).toBeNull();
    await rendered.click(action("Undo"));
    expect([writes(rendered).at(-1), shown()]).toEqual(["POST /api/todos/restore", ["Restored."]]);
  });

  it("reads the roots it was placed under: a row action's toast reads row, and so does its Undo", async () => {
    const restored = toast("{$name} restored.", "success", {}, { name: row("text") });
    rendered = await show([
      listing({ rowActions: [archiving({ onSuccess: [archiveToast({ call: undo({ onSuccess: [restored] }) })] })] }),
    ]);
    rendered.answer("/api/todos/archive", () => json({ id: 1, text: "Write the plan" }));
    rendered.answer("/api/todos/restore", () => new Response(null, { status: 204 }));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(action("Undo"));
    expect(shown()).toEqual(["Write the plan restored."]);
  });

  it("reads the row in an opened page's address and a button under a query reads data", async () => {
    const opening = openPageAt(address("/todos/{id}", { id: row("id") }));
    rendered = await show([listing({ rowActions: [archiving({ onSuccess: [opening] })] })]);
    rendered.answer("/api/todos", ({ url }) => (url.pathname === "/api/todos/archive" ? json({ id: 1, text: "Write the plan" }) : url.pathname === "/api/todos" ? json({ rows: todos, total: todos.length, next: null }) : json(todos[0])));
    await rendered.click(rendered.parts("row-action")[0]);
    expect(surface("dialog")).not.toBeNull();
    rendered.unmount();
    const saving = call("/api/todos/save", "Save", item, { onSuccess: [toast("{$email} saved.", "success", {}, { email: data("email") })] });
    rendered = await render({
      path: "/",
      answers: { "/api/account": () => json({ authorized: true, email: "ada@example.com", files: [] }), "/api/todos/save": () => new Response(null, { status: 204 }) },
      pages: { "/": { title: "Home", children: [queryNode({ content: [buttonOf(saving)] })] as never } },
    });
    await rendered.click(rendered.part("button"));
    expect(shown()).toEqual(["ada@example.com saved."]);
  });

  it("queues behind the page's own runs of a serial mutation", async () => {
    const serial = mutationSpec("/api/todos/archive", item, { concurrency: "serial" });
    const retry = { mutation: serial, inputs: { id: input("id") }, label: wireText("Retry"), onSuccess: [], onFailure: [] };
    rendered = await show([listing({ rowActions: [archiving({ concurrency: "serial", onFailure: [toast("Could not archive.", "warning", { call: retry })] })] })]);
    let attempts = 0;
    let answer: (response: Response) => void = () => {};
    rendered.answer("/api/todos/archive", () => (++attempts === 1 ? problem(500, "Down.") : attempts === 2 ? new Promise<Response>((resolve) => (answer = resolve)) : json({ id: 1, text: "Write the plan" })));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(action("Retry"));
    expect(writes(rendered)).toEqual(["POST /api/todos/archive", "POST /api/todos/archive"]);
    answer(json({ id: 1, text: "Write the plan" }));
    await rendered.settle();
    expect(writes(rendered)).toEqual(["POST /api/todos/archive", "POST /api/todos/archive", "POST /api/todos/archive"]);
  });

  it("withdraws a toast whose call succeeded before its onSuccess posts", async () => {
    const warn = (text: string) => toast(text, "warning");
    rendered = await show([buttonOf(call("/api/todos/three", "Post", item, { onSuccess: [warn("X"), toast("Archived.", "warning", { call: undo({ inputs: { id: { value: 1 } } }) }), warn("Y")] }))]);
    rendered.answer("/api/todos/three", () => new Response(null, { status: 204 }));
    rendered.answer("/api/todos/restore", () => new Response(null, { status: 204 }));
    await rendered.click(rendered.part("button"));
    await rendered.click(action("Undo"));
    expect(shown()).toEqual(["X", "Y", "Restored."]);
  });

  it("still posts the onSuccess of an Undo the limit dropped while its call was pending", async () => {
    const warn = (text: string) => toast(text, "warning");
    rendered = await show([listing(), buttonOf(call("/api/todos/three", "Three", item, { onSuccess: [warn("One"), warn("Two"), warn("Three")] }))]);
    let answer: (response: Response) => void = () => {};
    rendered.answer("/api/todos/archive", () => json({ id: 1, text: "Write the plan" }));
    rendered.answer("/api/todos/three", () => new Response(null, { status: 204 }));
    rendered.answer("/api/todos/restore", () => new Promise<Response>((resolve) => (answer = resolve)));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(action("Undo"));
    await rendered.click(rendered.parts("button").find((each) => each.textContent === "Three")!);
    expect(shown()).toEqual(["One", "Two", "Three"]);
    answer(new Response(null, { status: 204 }));
    await rendered.settle();
    expect(shown()).toEqual(["Two", "Three", "Restored."]);
  });

  it("stays pressable when its call fails, and a repeated failure is shown once", async () => {
    rendered = await show([listing()]);
    rendered.answer("/api/todos/archive", () => json({ id: 1, text: "Write the plan" }));
    rendered.answer("/api/todos/restore", () => problem(500, "Gone away."));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(action("Undo"));
    expect(shown()).toEqual(["Write the plan archived.", "Could not undo: Gone away."]);
    expect((action("Undo") as HTMLButtonElement).disabled).toBe(false);
    await rendered.click(action("Undo"));
    expect([writes(rendered).filter((request) => request.endsWith("restore")).length, shown()]).toEqual([2, ["Write the plan archived.", "Could not undo: Gone away."]]);
  });

  it("still runs its lists when it is dismissed while its call is pending", async () => {
    rendered = await show([listing()]);
    let answer: (response: Response) => void = () => {};
    rendered.answer("/api/todos/archive", () => json({ id: 1, text: "Write the plan" }));
    rendered.answer("/api/todos/restore", () => new Promise<Response>((resolve) => (answer = resolve)));
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.click(action("Undo"));
    await rendered.click(dismissButtons()[0]);
    expect(shown()).toEqual([]);
    answer(new Response(null, { status: 204 }));
    await rendered.settle();
    expect(shown()).toEqual(["Restored."]);
  });

  it("is offered again by a failed call, whose Retry sends the write once more and posts what it says", async () => {
    rendered = await show([listing()]);
    let attempts = 0;
    rendered.answer("/api/todos/archive", () => (++attempts === 1 ? problem(500, "Down.") : json({ id: 1, text: "Write the plan" })));
    await rendered.click(rendered.parts("row-action")[0]);
    // The row's failure tree stays, and the toast adds to it.
    expect([rendered.parts("mutation-failure").length, shown()]).toEqual([1, ["Could not archive: Down."]]);
    await rendered.click(action("Retry"));
    expect([attempts, shown()]).toEqual([2, ["Write the plan archived."]]);
  });

  it("shows three at most: five posts leave the last three, and a fourth archive drops the first", async () => {
    const five = ["One", "Two", "Three", "Four", "Five"].map((text) => toast(text, "warning"));
    rendered = await show([buttonOf(call("/api/todos/five", "Post", item, { onSuccess: five }))]);
    rendered.answer("/api/todos/five", () => new Response(null, { status: 204 }));
    await rendered.click(rendered.part("button"));
    expect(shown()).toEqual(["Three", "Four", "Five"]);
    rendered.unmount();
    let id = 0;
    rendered = await show([buttonOf(archiving({ inputs: { id: { value: 1 } } }))]);
    rendered.answer("/api/todos/archive", () => json({ id: 1, text: `Project ${++id}` }));
    for (let press = 0; press < 4; press++) await rendered.click(rendered.part("button"));
    expect(shown()).toEqual(["Project 2 archived.", "Project 3 archived.", "Project 4 archived."]);
  });

  it("closes the opened page it ran in, then posts, and leaves a page that is not open alone", async () => {
    const archiveButton = buttonOf(archiving({ onSuccess: [{ type: "close" }, toast("Archived.")], inputs: { id: { value: 1 } } }));
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Home", children: [{ type: "link", text: "Open", to: openPageAt(address("/edit"), drawer, false) }, archiveButton] as never }, "/edit": { title: "Edit", children: [archiveButton] as never } },
      answers: { "/api/todos/archive": () => json({ id: 1, text: "Write the plan" }) },
    });
    // A call on the page the viewer is on runs in no surface: nothing to close.
    await rendered.click(rendered.parts("button")[0]);
    expect(shown()).toEqual(["Archived."]);
    await rendered.click(rendered.part("link"));
    expect(surface("drawer")).not.toBeNull();
    await rendered.click(rendered.parts("button").at(-1)!);
    expect([surface("drawer"), shown()]).toEqual([null, ["Archived."]]);
  });

  it("opens a link to a page in a popover as the popover's drawer compact, from a toast anchoring nothing", async () => {
    const popover = { type: "popover", side: "bottom", align: "start", dismiss: { escape: true, outside: true }, compact: drawer };
    const posting = call("/api/todos/post", "Post", item, { onSuccess: [toast("Look.", "info", { link: { label: wireText("Open"), to: openPageAt(address("/edit"), popover, false) } })] });
    rendered = await render({
      path: "/",
      answers: { "/api/todos/post": () => new Response(null, { status: 204 }) },
      pages: { "/": { title: "Home", children: [buttonOf(posting)] as never }, "/edit": { title: "Edit", children: [] } },
    });
    await rendered.click(rendered.part("button"));
    await rendered.click(action("Open"));
    expect([surface("drawer") !== null, surface("popover")]).toEqual([true, null]);
  });
});

describe("a listing's delete", () => {
  const deleting = { onSuccess: [toast("{$name} deleted.", "success", {}, { name: row("text") })], onFailure: [danger("Could not delete {$name}: {$message}", { name: row("text"), message: error("message") })] };

  it("posts what it says over the row once the record is gone", async () => {
    rendered = await show([listing({ rowActions: [], delete: deleting })], { etags: false });
    await rendered.click(rendered.parts("row-delete")[0]);
    await rendered.click(document.querySelector('[data-surface="confirmation"] [data-telo-part="submit"]')!);
    expect(shown()).toEqual(["Write the plan deleted."]);
  });

  it("keeps its confirmation open with the failure drawn in it, and the toast adds to it", async () => {
    rendered = await show([listing({ rowActions: [], delete: deleting })], { etags: false });
    rendered.answer("/api/todos/1", () => problem(500, "Down."));
    await rendered.click(rendered.parts("row-delete")[0]);
    await rendered.click(document.querySelector('[data-surface="confirmation"] [data-telo-part="submit"]')!);
    expect([surface("confirmation") !== null, document.querySelector('[data-surface="confirmation"]')?.textContent?.includes("Down."), shown()]).toEqual([
      true,
      true,
      ["Could not delete Write the plan: Down."],
    ]);
  });
});

describe("a form's lists", () => {
  const edited = { onSuccess: [toast("Saved.")], onFailure: [danger("Not saved: {$message}", { message: error("message") })] };
  const editPages = (form: Record<string, unknown>) => recordPages({}, { afterSubmit: "close", ...form });

  it("posts after a drawer it was saved from has closed, and on a page of its own where the form stays", async () => {
    rendered = await render({
      path: "/",
      required: ["text"],
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Todos", children: [listing({ rowActions: [], edit: { to: openPageAt(address("/todos/{id}", { id: row("id") }), drawer, false), label: wireText("Edit") } })] as never }, ...editPages(edited) },
    });
    await rendered.click(rendered.parts("row-edit")[0]);
    await rendered.enter(rendered.parts("input")[0], "Write the better plan");
    await rendered.click(rendered.part("submit"));
    expect([writes(rendered), surface("drawer"), shown()]).toEqual([["PATCH /api/todos/1"], null, ["Saved."]]);
    expect(rendered.sent.at(-1)?.body).toEqual({ text: "Write the better plan" });
    rendered.unmount();
    rendered = await render({ path: "/todos/1", required: ["text"], collections: { "/api/todos": todos }, pages: editPages({ ...edited, afterSubmit: "keep" }) });
    await rendered.enter(rendered.parts("input")[0], "Write it again");
    await rendered.click(rendered.part("submit"));
    expect([rendered.parts("form").length, shown()]).toEqual([1, ["Saved."]]);
  });

  it("moves to the created record and shows its toast there; a refused create draws the failure tree and posts its onFailure", async () => {
    const created = { onSuccess: [navigateTo(address("/todos/{id}", { id: result("id") })), toast("{$name} created.", "info", {}, { name: result("text") })], onFailure: edited.onFailure };
    rendered = await render({
      path: "/todos/new",
      required: ["text"],
      collections: { "/api/todos": todos },
      pages: { "/todos/new": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", ...created })] }, "/todos/{id}": { title: "Todo", children: [] } },
    });
    await rendered.enter(rendered.parts("input")[0], "Artemis");
    await rendered.click(rendered.part("submit"));
    expect([window.location.pathname, shown()]).toEqual([`/todos/${todos.length + 1}`, ["Artemis created."]]);
    rendered.unmount();
    rendered = await render({
      path: "/todos/new",
      answers: { "/api/todos": () => problem(500, "Down.") },
      pages: { "/todos/new": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", ...created })] } },
    });
    await rendered.enter(rendered.parts("input")[0], "Artemis");
    await rendered.click(rendered.part("submit"));
    expect([rendered.parts("error-code").length > 0, shown()]).toEqual([true, ["Not saved: Down."]]);
  });

  it("runs no onFailure for an autosave write that failed", async () => {
    const saving = formNode("/unused", {
      id: "Test/draft",
      schema: { type: "object", properties: { text: { type: "string", title: "Text" } } },
      record: null,
      fields: [{ type: "input", property: "text", label: "Text", control: "auto" }],
      state: { address: false, store: { type: "memory" }, fields: ["text"] },
      autosave: {
        mutation: mutationSpec("/api/todos/draft", { type: "object", properties: { text: { type: "string" } } }, { method: "PUT" }),
        inputs: { text: { root: "values", path: ["text"] } },
        debounce: 0,
        result: { type: "text", text: "Saved" },
        failure: defaultFailure,
      },
      ...edited,
    });
    rendered = await render({ path: "/", answers: { "/api/todos/draft": () => problem(500, "Down.") }, pages: { "/": { title: "Draft", children: [saving] } } });
    await rendered.enter(rendered.parts("input")[0], "Hello");
    await rendered.settle();
    expect([writes(rendered), shown()]).toEqual([["PUT /api/todos/draft"], []]);
  });
});

describe("a toast and the address", () => {
  it("is carried by a move to a declared page, and an address no page declares is a load of the browser", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    const posting = call("/api/todos/post", "Post", item, { onSuccess: [toast("Posted."), navigateTo(address("/elsewhere"))] });
    rendered = await render({
      path: "/",
      answers: { "/api/todos/post": () => new Response(null, { status: 204 }), "/api/todos/leave": () => new Response(null, { status: 204 }) },
      pages: { "/": { title: "Home", children: [buttonOf(posting)] as never }, "/elsewhere": { title: "Elsewhere", children: [buttonOf(call("/api/todos/leave", "Leave", item, { onSuccess: [navigateTo(address("/nowhere"))] }))] as never } },
    });
    await rendered.click(rendered.parts("button")[0]);
    expect([window.location.pathname, shown()]).toEqual(["/elsewhere", ["Posted."]]);
    await rendered.click(rendered.part("button"));
    expect(leave.mock.calls.map(([href]) => href)).toEqual(["/nowhere"]);
  });
});

describe("a board's move", () => {
  it("runs its onFailure when the write does not succeed, over error and input", async () => {
    const content = { type: "value", value: row("text"), present: { type: "string" } };
    const statuses = { property: "status", values: "all", enum: ["open", "blocked", "done"], labels: [] };
    const move = call("/api/moves", null, { type: "object", properties: { id: { type: "integer" }, status: { type: "string" } } }, {
      inputs: { id: row("id"), status: { root: "to", path: ["status"] } },
      onFailure: [danger("Could not move {$id}: {$message}", { id: input("id"), message: error("message") })],
    });
    const board = listingNode({ rowStyle: undefined, create: null, edit: null, delete: false, layout: { type: "board", content, move, reads: { groups: statuses } } });
    rendered = await show([board], { answers: { "/api/moves": () => problem(409, "Not now.") } });
    const card = rendered.parts("board-card").find((each) => each.textContent?.includes("Review the plan")) as HTMLElement;
    const onto = rendered.parts("board-column")[2];
    await act(async () => {
      card.dispatchEvent(new Event("dragstart", { bubbles: true }));
      onto.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      onto.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
      card.dispatchEvent(new Event("dragend", { bubbles: true }));
    });
    await rendered.settle();
    expect(shown()).toEqual(["Could not move 2: Not now."]);
    // The failure tree is drawn on the record as well.
    expect(rendered.parts("mutation-failure").map((each) => each.textContent)).toEqual(["ERR_TESTNot now."]);
  });
});

describe("a component's toast", () => {
  it("is one sticky toast beside the declared ones, with its link, and dismiss takes it away", async () => {
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos },
      pages: { "/": { title: "Home", children: [component("HostProbe", { basePath: { value: "/api/todos" } }), buttonOf(call("/api/todos/post", "Post", item, { onSuccess: [toast("Declared.")] }))] } },
      answers: { "/api/todos/post": () => new Response(null, { status: 204 }) },
    });
    await rendered.click(rendered.fixture("toast"));
    await rendered.click(rendered.part("button"));
    expect([shown(), action("Open")?.getAttribute("href")]).toEqual([["Saved", "Declared."], "/drafts/7"]);
    await rendered.click(rendered.fixture("toast"));
    expect(shown()).toEqual(["Saved", "Declared."]);
    await rendered.click(rendered.fixture("dismiss"));
    expect(shown()).toEqual(["Declared."]);
  });
});

describe("what the renderer posts of its own", () => {
  it("is nothing: the event stream's reopening posts no toast", async () => {
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "text", text: "Plain" }] } } });
    await rendered.hello();
    await rendered.hello("bundle-2");
    await rendered.hello();
    expect(shown()).toEqual([]);
    expect(document.querySelectorAll('[data-telo-part="toast"]').length).toBe(0);
  });
});
