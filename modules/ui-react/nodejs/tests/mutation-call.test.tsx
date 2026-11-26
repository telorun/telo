// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import reportRequest from "../../tests/__fixtures__/mutation/report-request.json" with { type: "json" };
import { HostStore } from "../src/browser/host.js";
import { render, type Rendered } from "./harness.js";
import { address, buttonOf, call, formNode, literals, navigateTo, openPageAt, promptOf, reportResult, reportSchema } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = { month: "2026-09", files: [{ name: "2026-09.pdf", url: "/files/2026-09.pdf" }], totals: "none" };
const row = (...path: string[]) => ({ root: "row", path });
const result = (...path: string[]) => ({ root: "result", path });
const input = (...path: string[]) => ({ root: "input", path });
const posts = (r: Rendered) => r.sent.filter((each) => each.request.startsWith("POST"));
const texts = (elements: Element[]) => elements.map((element) => element.textContent);
const within = (r: Rendered, part: string, name: string) => [...r.part(part).querySelectorAll<HTMLElement>(`[data-telo-part="${name}"]`)];
/** What the call's failure tree draws: each value it presents. */
const failure = (r: Rendered) => texts(within(r, "mutation-failure", "value"));

/** A button node sending the shared report request under the mount. */
const report = (overrides: Record<string, unknown> = {}) => buttonOf(call("/api/reports", "Generate", reportSchema, { inputs: literals(reportRequest), ...overrides }));
const show = (respond: () => Response | Promise<Response> = () => json(answer), node = report()) =>
  render({ path: "/", prefix: "/admin", answers: { "/admin/api/reports": respond }, pages: { "/": { title: "Reports", children: [node] } } });

describe("a call's request", () => {
  it("is the mutation's method to its url under the mount, the inputs as JSON, its button disabled while it runs", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show(() => new Promise<Response>((resolve) => (finish = resolve)));
    await rendered.click(rendered.part("button"));
    expect(posts(rendered)).toEqual([{ request: "POST /admin/api/reports", contentType: "application/json", body: reportRequest }]);
    expect((rendered.part("button") as HTMLButtonElement).disabled).toBe(true);
    finish(json(answer));
    await rendered.settle();
    expect((rendered.part("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("leaves out an input the url consumes and an input that holds nothing", async () => {
    const renaming = call("/", "Rename", { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, note: { type: "string" } } }, {
      method: "PATCH",
      url: address("/api/items/{id}", { id: input("id") }),
      consumed: ["id"],
      inputs: { id: { value: "i1" }, title: { value: "New" }, note: { root: "query", path: ["note"] } },
    });
    rendered = await render({ path: "/", answers: { "/api/items/i1": () => new Response(null, { status: 204 }) }, pages: { "/": { title: "Items", children: [buttonOf(renaming)] } } });
    await rendered.click(rendered.part("button"));
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([["PATCH /api/items/i1", { title: "New" }]]);
  });

  it("is judged against the mutation's schema first: a record it refuses is not sent, and is the call's failure", async () => {
    rendered = await show(undefined, report({ inputs: literals({ ...reportRequest, month: "September" }) }));
    await rendered.click(rendered.part("button"));
    expect(rendered.sent).toEqual([]);
    expect(failure(rendered)).toEqual(["ERR_UI_MUTATION_INPUT_INVALID", "month: Is not in the expected format"]);
  });

  it("sends a delete with no body", async () => {
    const removing = call("/", "Remove", { type: "object", properties: { id: { type: "string" } } }, { method: "DELETE", url: address("/api/items/{id}", { id: input("id") }), consumed: ["id"], inputs: { id: { value: "i1" } } });
    rendered = await render({ path: "/", answers: { "/api/items/i1": () => new Response(null, { status: 204 }) }, pages: { "/": { title: "Items", children: [buttonOf(removing)] } } });
    await rendered.click(rendered.part("button"));
    expect(rendered.sent).toEqual([]);
    expect(rendered.requests).toContain("DELETE /api/items/i1");
  });
});

describe("a call's answer", () => {
  it("draws the result tree in the button's place, over the record sent and what the success answered", async () => {
    const tree = { type: "stack", children: [{ type: "value", value: input("month") }, { type: "value", value: result("month") }] };
    rendered = await show(undefined, report({ result: tree }));
    await rendered.click(rendered.part("button"));
    expect(rendered.parts("button")).toEqual([]);
    expect(texts(within(rendered, "mutation-result", "value"))).toEqual(["2026-09", "2026-09"]);
  });

  it("draws each list of a result: a heading, headers and a row per element", async () => {
    rendered = await show(undefined, report({ result: reportResult() }));
    await rendered.click(rendered.part("button"));
    const [files] = within(rendered, "mutation-result", "list");
    expect(texts(rendered.parts("list-heading"))).toEqual(["Files"]);
    expect(texts([...files.querySelectorAll('[data-telo-part="table-header-cell"]')])).toEqual(["File", "Download", "Month", "Kind"]);
    expect([...files.querySelectorAll('[data-telo-part="table-row"]')].map((each) => texts([...each.children]))).toEqual([["2026-09.pdf", "/files/2026-09.pdf", "2026-09", "report"]]);
  });

  it("draws nothing for a call that draws no result, and does not read its body", async () => {
    rendered = await show(() => new Response("done", { status: 200 }));
    await rendered.click(rendered.part("button"));
    expect(rendered.parts("mutation-failure")).toEqual([]);
    expect(rendered.parts("error")).toEqual([]);
  });

  it("clears the last failure when it is pressed again", async () => {
    let respond = (): Response | Promise<Response> => json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500);
    rendered = await show(() => respond());
    await rendered.click(rendered.part("button"));
    expect(failure(rendered)).toEqual(["ERR_UI_REQUEST_FAILED", "The request failed with status 500."]);
    let finish: (response: Response) => void = () => {};
    respond = () => new Promise<Response>((resolve) => (finish = resolve));
    await rendered.click(rendered.part("button"));
    expect(rendered.parts("mutation-failure")).toEqual([]);
    finish(json(answer));
    await rendered.settle();
  });

  it.each([
    ["a 400 that names a code", () => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "No report for that month", code: "ERR_NO_REPORT" }, 400), "ERR_NO_REPORT"],
    ["a 401", () => new Response(null, { status: 401 }), "ERR_UI_UNAUTHORIZED"],
    ["a 403", () => new Response(null, { status: 403 }), "ERR_UI_FORBIDDEN"],
    ["a 500", () => json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500), "ERR_UI_REQUEST_FAILED"],
    [
      "no answer at all",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "ERR_UI_REQUEST_FAILED",
    ],
    ["a success that is a list", () => json([{ name: "a" }]), "ERR_UI_RESPONSE_INVALID"],
    ["a success that is not JSON", () => new Response("done", { status: 200 }), "ERR_UI_RESPONSE_INVALID"],
  ])("draws %s as its failure, where its button was", async (name, respond, code) => {
    rendered = await show(respond, report({ result: reportResult() }));
    await rendered.click(rendered.part("button"));
    expect(failure(rendered)[0]).toBe(code);
    expect(rendered.part("button").nextElementSibling).toBe(rendered.part("mutation-failure"));
    expect(rendered.parts("mutation-result")).toEqual([]);
  });

  it("draws a success the declared answer refuses as its failure", async () => {
    rendered = await show(() => json({ files: "none" }), report({ answer: { type: "object", properties: { files: { type: "array" } } }, result: reportResult() }));
    await rendered.click(rendered.part("button"));
    expect(failure(rendered)[0]).toBe("ERR_UI_RESPONSE_INVALID");
    expect(rendered.parts("mutation-result")).toEqual([]);
  });
});

describe("a call's effects", () => {
  const withEffects = (onSuccess: unknown[], respond: () => Response | Promise<Response> = () => json({ next: "/done" })) =>
    render({
      path: "/",
      prefix: "/admin",
      answers: { "/admin/api/reports": respond },
      pages: {
        "/": { title: "Reports", children: [report({ onSuccess }), { type: "link", text: "Away", to: navigateTo(address("/away")) }] },
        "/done": { title: "Done", children: [] },
        "/away": { title: "Away", children: [] },
        "/first": { title: "First", children: [] },
        "/second": { title: "Second", children: [] },
      },
    });

  it("run in the order written, each over the answer and the record sent", async () => {
    const follow = vi.spyOn(HostStore.prototype, "follow").mockImplementation(async () => true);
    rendered = await withEffects([navigateTo(address("/first")), navigateTo(address({ root: "result", path: ["next"] })), navigateTo(address("/second", {}, { month: input("month") }))]);
    await rendered.click(rendered.part("button"));
    expect(follow.mock.calls.map(([to]) => to)).toEqual(["/first", "/done", "/second?month=2026-09"]);
  });

  it("leave the page for an absolute address the answer names, and move within the application for a declared page", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    let next = "https://example.com/report";
    rendered = await withEffects([navigateTo(address({ root: "result", path: ["next"] }))], () => json({ next }));
    await rendered.click(rendered.part("button"));
    expect(leave.mock.calls).toEqual([["https://example.com/report"]]);
    next = "/done";
    await rendered.click(rendered.part("button"));
    expect(window.location.pathname).toBe("/admin/done");
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("go nowhere for a value that is no address, and the answer is still drawn", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    rendered = await show(() => json({ ...answer, next: "javascript:alert(1)" }), report({ result: reportResult(), onSuccess: [navigateTo(address(result("next")))] }));
    await rendered.click(rendered.part("button"));
    expect(leave).not.toHaveBeenCalled();
    expect(rendered.parts("mutation-result")).toHaveLength(1);
  });

  it("still run once the page the call was pressed on has been left", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await withEffects([navigateTo(address("/done"))], () => new Promise<Response>((resolve) => (finish = resolve)));
    await rendered.click(rendered.part("button"));
    await rendered.click(rendered.part("link"));
    expect([window.location.pathname, rendered.parts("button")]).toEqual(["/admin/away", []]);
    finish(json(answer));
    await rendered.settle();
    expect(window.location.pathname).toBe("/admin/done");
  });

  it("open a page in its surface, by the shell, once the answer arrives", async () => {
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => json(answer) },
      pages: {
        "/": { title: "Reports", children: [report({ onSuccess: [openPageAt(address("/note"), { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } }, false)] })] },
        "/note": { title: "Note", children: [{ type: "text", text: "Saved note" }] },
      },
    });
    await rendered.click(rendered.part("button"));
    expect(document.querySelector('[data-telo-part="surface"]')?.textContent).toContain("Saved note");
  });

  it("wait for a move the unsaved question holds: staying ends the list, leaving runs the rest after it", async () => {
    const page = (name: string) => ({ title: name, children: [{ type: "text", text: `${name} page` }] });
    const dialog = { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };
    const noted = () => document.body.textContent?.includes("Note page") === true;
    const open = () =>
      render({
        path: "/",
        required: ["text"],
        collections: { "/api/todos": [] },
        answers: { "/api/reports": () => json(answer) },
        pages: {
          "/": { title: "Reports", children: [report({ onSuccess: [navigateTo(address("/first")), openPageAt(address("/note"), dialog, false)] }), formNode("/api/todos")] },
          "/first": page("First"),
          "/note": page("Note"),
        },
      });
    for (const leave of [false, true]) {
      rendered = await open();
      await rendered.enter(rendered.part("input"), "Unsaved");
      await rendered.click(rendered.part("button"));
      expect([rendered.part("surface-title").textContent, window.location.pathname, noted()]).toEqual(["Discard unsaved changes?", "/", false]);
      const answerWith = leave ? rendered.parts("submit").find((button) => button.closest('[data-surface="confirmation"]'))! : rendered.part("cancel");
      await rendered.click(answerWith);
      expect([window.location.pathname, noted()]).toEqual(leave ? ["/first", true] : ["/", false]);
      rendered.unmount();
    }
    rendered = undefined;
  });

  it("are none for a call whose list is empty: the call succeeds and nothing moves", async () => {
    const follow = vi.spyOn(HostStore.prototype, "follow").mockImplementation(async () => true);
    rendered = await withEffects([]);
    await rendered.click(rendered.part("button"));
    expect([follow.mock.calls, rendered.parts("mutation-failure"), window.location.pathname]).toEqual([[], [], "/admin/"]);
  });
});

describe("a call's prompt", () => {
  const rejectSchema = { type: "object", required: ["id", "note"], properties: { id: { type: "integer" }, note: { type: "string", title: "Note", minLength: 1 } } };
  const reject = call("/api/todos/reject", "Reject", rejectSchema, {
    inputs: { id: row("id"), note: { root: "prompt", path: ["note"] } },
    prompt: promptOf(rejectSchema, ["note"]),
  });
  const list = { type: "list", rowActionsDisplay: "auto", rows: { value: [{ id: 1 }, { id: 2 }] }, columns: [{ header: "Id", value: row("id"), present: { type: "integer" } }], rowActions: [reject] };
  const dialog = () => document.querySelector<HTMLElement>('[data-surface="confirmation"]');
  const confirm = (r: Rendered) => r.click(dialog()!.querySelector('[data-telo-part="submit"]')!);

  it("opens a dialog of its fields for a row's call, and sends the note with the value the row binds", async () => {
    rendered = await render({ path: "/", answers: { "/api/todos/reject": () => new Response(null, { status: 204 }) }, pages: { "/": { title: "Todos", children: [list as never] } } });
    await rendered.click(rendered.parts("row-action")[1]);
    expect(texts([...dialog()!.querySelectorAll('[data-telo-part="label"]')])).toEqual(["Note"]);
    expect(rendered.sent).toEqual([]);
    await rendered.enter(dialog()!.querySelector('[data-telo-part="input"]')!, "Out of scope");
    await confirm(rendered);
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([["POST /api/todos/reject", { id: 2, note: "Out of scope" }]]);
    expect(dialog()).toBeNull();
  });

  it("sends nothing while a required note is empty", async () => {
    rendered = await render({ path: "/", pages: { "/": { title: "Todos", children: [list as never] } } });
    await rendered.click(rendered.parts("row-action")[0]);
    await confirm(rendered);
    expect(rendered.sent).toEqual([]);
    expect(dialog()?.querySelector('[data-telo-part="field-error"]')?.textContent).toBe("Is required");
  });
});

describe("one mutation run from several places", () => {
  const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
  const archive = (inputs: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    call("/api/archive", "Archive", schema, { inputs, result: { type: "value", value: input("name") }, failure: { type: "value", value: { root: "error", path: ["code"] } }, ...over });
  const places = (over: Record<string, unknown> = {}) => ({
    list: { type: "list", rowActionsDisplay: "auto", rows: { value: [{ name: "from-row" }] }, columns: [{ header: "Name", value: row("name"), present: { type: "string" } }], rowActions: [archive({ name: row("name") }, over)] },
    button: buttonOf(archive({ name: { value: "from-button" } }, over)),
  });
  const showing = (over: Record<string, unknown>, answers: Record<string, () => Response | Promise<Response>> = {}) =>
    render({ path: "/", answers: { "/api/archive": () => new Response(null, { status: 204 }), ...answers }, pages: { "/": { title: "Archive", children: Object.values(places(over)) as never } } });

  it("sends the same request from each, and each draws its own result where it ran", async () => {
    rendered = await showing({});
    await rendered.click(rendered.part("row-action"));
    await rendered.click(rendered.part("button"));
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([
      ["POST /api/archive", { name: "from-row" }],
      ["POST /api/archive", { name: "from-button" }],
    ]);
    expect(rendered.parts("mutation-result").map((each) => [each.textContent, each.closest('[data-telo-part="table-row"]') !== null])).toEqual([
      ["from-row", true],
      ["from-button", false],
    ]);
  });

  it("draws its own failure where each ran", async () => {
    rendered = await showing({}, { "/api/archive": () => json({ type: "about:blank", title: "Gone", status: 410, code: "ERR_GONE", detail: "Gone." }, 410) });
    await rendered.click(rendered.part("row-action"));
    await rendered.click(rendered.part("button"));
    expect(rendered.parts("mutation-failure").map((each) => [each.textContent, each.closest('[data-telo-part="table-row"]') !== null])).toEqual([
      ["ERR_GONE", true],
      ["ERR_GONE", false],
    ]);
  });

  it("is one queue under `serial`, across a row and a button: one at a time, in the order pressed", async () => {
    const finishes: ((response: Response) => void)[] = [];
    rendered = await showing({ concurrency: "serial" }, { "/api/archive": () => new Promise<Response>((resolve) => finishes.push(resolve)) });
    await rendered.click(rendered.part("button"));
    await rendered.click(rendered.part("row-action"));
    expect(rendered.sent.map((each) => each.body)).toEqual([{ name: "from-button" }]);
    finishes[0](new Response(null, { status: 204 }));
    await rendered.settle();
    expect(rendered.sent.map((each) => each.body)).toEqual([{ name: "from-button" }, { name: "from-row" }]);
    finishes[1](new Response(null, { status: 204 }));
    await rendered.settle();
    expect(rendered.parts("mutation-result")).toHaveLength(2);
  });

  it("is no queue under `parallel`: the second is sent while the first is pending", async () => {
    const finishes: ((response: Response) => void)[] = [];
    rendered = await showing({}, { "/api/archive": () => new Promise<Response>((resolve) => finishes.push(resolve)) });
    await rendered.click(rendered.part("button"));
    await rendered.click(rendered.part("row-action"));
    expect(rendered.sent).toHaveLength(2);
    for (const finish of finishes) finish(new Response(null, { status: 204 }));
    await rendered.settle();
  });
});
