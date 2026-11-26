// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import reportRequest from "../../tests/__fixtures__/mutation/report-request.json" with { type: "json" };
import { render, type Rendered } from "./harness.js";
import { HostStore } from "../src/browser/host.js";
import { address, defaultFailure, formNode, memoryState, mutationSpec, navigateTo, openPageAt, queryNode, reportResult, reportSchema, todos } from "./spec-nodes.js";
import { uiText } from "./ui-texts.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = { month: "2026-09", files: [{ name: "2026-09.pdf", url: "/files/2026-09.pdf" }], totals: "none" };
const values = (...path: string[]) => ({ root: "values", path });
const posts = (r: Rendered) => r.sent.filter((each) => each.request.startsWith("POST"));
const texts = (elements: Element[]) => elements.map((element) => element.textContent);
const within = (r: Rendered, part: string, name: string) => [...r.part(part).querySelectorAll<HTMLElement>(`[data-telo-part="${name}"]`)];
const state = (r: Rendered) => r.part("form").getAttribute("data-state");
const errors = (r: Rendered) => r.parts("field").map((field) => field.querySelector('[data-telo-part="field-error"]')?.textContent);
const reportFields = Object.entries(reportSchema.properties).map(([property, { title }]) => ({ type: "input", property, label: title, control: "auto" }));

/** The write a form submits: the report mutation, each input bound to the form's own property. */
const submitWrite = (overrides: Record<string, unknown> = {}, mutation: Record<string, unknown> = {}) => ({
  mutation: mutationSpec("/api/reports", reportSchema, mutation),
  inputs: Object.fromEntries(Object.keys(reportSchema.properties).map((property) => [property, values(property)])),
  label: "Generate",
  failure: defaultFailure,
  ...overrides,
});

/** A form with no collection, entering the report and submitting it to `/api/reports`, kept after it is sent. */
const submitForm = (write: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, mutation: Record<string, unknown> = {}) =>
  formNode("/unused", {
    id: "Test/report",
    schema: { type: "object", properties: reportSchema.properties },
    record: null,
    fields: reportFields,
    state: memoryState(Object.keys(reportSchema.properties)),
    afterSubmit: "keep",
    onSubmit: submitWrite(write, mutation),
    ...overrides,
  });

const show = (respond: () => Response | Promise<Response> = () => json(answer), node = submitForm(), more: Record<string, { title?: string; children: unknown[] }> = {}) =>
  render({ path: "/", prefix: "/admin", answers: { "/admin/api/reports": respond }, pages: { "/": { title: "Reports", children: [node] }, ...more } as never });

/** Enter the record of the shared request body. */
async function enterReport(r: Rendered) {
  const [month, copies, recipient] = r.parts("input");
  await r.enter(month, reportRequest.month);
  await r.enter(copies, String(reportRequest.copies));
  for (const option of r.parts("option")) await r.click(option);
  for (const each of reportRequest.recipients) {
    await r.enter(recipient, each);
    await r.commit(recipient, "enter");
  }
}

describe("a form with no collection", () => {
  it("draws a control per field and no submit button, nor any request, without an onSubmit", async () => {
    rendered = await show(undefined, submitForm({}, { onSubmit: null }));
    expect(texts(rendered.parts("label"))).toEqual(["Month", "Copies", "Formats", "Recipients"]);
    expect([rendered.parts("submit"), rendered.parts("form-actions")]).toEqual([[], []]);
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.commit(rendered.part("input"), "enter");
    expect([rendered.sent, rendered.part("form").getAttribute("data-dirty")]).toEqual([[], null]);
  });
});

describe("a form's onSubmit", () => {
  it("is drawn as a submit button under its label, or under ui's save text when the write names none", async () => {
    rendered = await show();
    expect(rendered.part("submit").textContent).toBe("Generate");
    rendered.unmount();
    rendered = await show(undefined, submitForm({ label: uiText("save") }));
    expect(rendered.part("submit").textContent).toBe("Save");
  });

  it("refuses in the page what the mutation's input model refuses, the button still enabled, until the field changes", async () => {
    rendered = await show();
    const recipient = rendered.parts("input")[2];
    await rendered.enter(recipient, "ab");
    await rendered.commit(recipient, "enter");
    await rendered.click(rendered.part("submit"));
    expect(errors(rendered)).toEqual(["Is required", undefined, undefined, "Must be at least 3 characters"]);
    expect([state(rendered), (rendered.part("submit") as HTMLButtonElement).disabled, posts(rendered)]).toEqual(["error", false, []]);
    await rendered.enter(rendered.parts("input")[0], "2026-09");
    expect(errors(rendered)[0]).toBeUndefined();
  });

  it("shows a field the form's model and the write refuse alike with the wording once, the model's first", async () => {
    const schema = { type: "object", properties: { ...reportSchema.properties, copies: { type: "integer", title: "Copies", minimum: 2 } } };
    rendered = await show(undefined, submitForm({}, { schema }));
    await rendered.enter(rendered.parts("input")[1], "0");
    expect(errors(rendered)[1]).toBe("Must be at least 2 Must be at least 1");
    await rendered.enter(rendered.parts("input")[1], "1");
    expect(errors(rendered)[1]).toBe("Must be at least 2");
  });

  it("posts the record its inputs bind, its button disabled and a second press not taken while it runs, and keeps what was entered", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show(() => new Promise<Response>((resolve) => (finish = resolve)));
    await enterReport(rendered);
    await rendered.click(rendered.part("submit"));
    rendered.part("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(posts(rendered)).toEqual([{ request: "POST /admin/api/reports", contentType: "application/json", body: reportRequest }]);
    expect([(rendered.part("submit") as HTMLButtonElement).disabled, state(rendered)]).toEqual([true, "submitting"]);
    finish(json(answer));
    await rendered.settle();
    expect([(rendered.part("submit") as HTMLButtonElement).disabled, state(rendered), (rendered.part("input") as HTMLInputElement).value]).toEqual([false, "idle", "2026-09"]);
    expect(texts(rendered.parts("tag"))).toEqual(reportRequest.recipients);
  });

  it("leaves out an input reading a hidden field's property", async () => {
    const fields = reportFields.map((field) => (field.property === "copies" ? { ...field, shown: { at: values("month"), matches: { const: "never" } } } : field));
    rendered = await show(undefined, submitForm({}, { fields }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.enter(rendered.parts("input")[1], "3");
    await rendered.enter(rendered.parts("input")[0], "2026-10");
    await rendered.click(rendered.part("submit"));
    expect(posts(rendered).map((each) => each.body)).toEqual([{ month: "2026-10" }]);
  });

  it("draws its result over the answer, the record sent and what the form holds now, and clears it when pressed again", async () => {
    const tree = { type: "stack", children: [reportResult(), { type: "value", value: { root: "values", path: ["month"] }, present: { type: "string" } }, { type: "value", value: { root: "input", path: ["month"] }, present: { type: "string" } }] };
    let respond = (): Response | Promise<Response> => json(answer);
    rendered = await show(() => respond(), submitForm({ result: tree }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(texts(within(rendered, "mutation-result", "list-heading"))).toEqual(["Files"]);
    await rendered.enter(rendered.part("input"), "2026-10");
    expect(texts(within(rendered, "mutation-result", "value"))).toEqual(["2026-10", "2026-09"]);
    respond = () => new Promise<Response>(() => {});
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("mutation-result")).toEqual([]);
  });

  it("puts a 400's issues on the fields its inputs name and the rest in its answer, and draws its failure", async () => {
    const issues = [
      { pointer: "/body/month", keyword: "pattern", params: { pattern: "^[0-9]{4}-[0-9]{2}$" } },
      { pointer: "/body/owner", keyword: "required", params: { missingProperty: "owner" } },
    ];
    rendered = await show(() => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues } }, 400));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(errors(rendered)[0]).toBe("Is not in the expected format");
    expect(rendered.part("form-error").textContent).toBe("owner: Is required");
    expect([state(rendered), texts(within(rendered, "mutation-failure", "value"))]).toEqual(["error", ["ERR_INPUT_INVALID", "The request is not valid."]]);
    await rendered.enter(rendered.part("input"), "2026-10");
    expect([errors(rendered)[0], rendered.parts("form-error")]).toEqual([undefined, []]);
  });

  it("clears its answer when a property clearAnswerOn lists changes, and keeps it for any other", async () => {
    rendered = await show(undefined, submitForm({ result: reportResult() }, { clearAnswerOn: ["month"] }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    await rendered.enter(rendered.parts("input")[1], "4");
    expect(rendered.parts("mutation-result")).toHaveLength(1);
    await rendered.enter(rendered.part("input"), "2026-10");
    expect(rendered.parts("mutation-result")).toEqual([]);
  });

  it("is enabled only while its condition holds over the form's values, saying why beside the button", async () => {
    rendered = await show(undefined, submitForm({ enabled: { at: values("month"), matches: { type: "string" }, disabledText: "Choose a month first" } }));
    expect([(rendered.part("submit") as HTMLButtonElement).disabled, rendered.part("disabled-text").textContent]).toEqual([true, "Choose a month first"]);
    await rendered.enter(rendered.part("input"), "2026-09");
    expect([(rendered.part("submit") as HTMLButtonElement).disabled, rendered.parts("disabled-text")]).toEqual([false, []]);
  });

  it("asks its confirmation before sending, and sends nothing when it is dismissed", async () => {
    rendered = await show(undefined, submitForm({ confirm: "Generate this report?" }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect([rendered.part("surface-title").textContent, posts(rendered)]).toEqual(["Generate this report?", []]);
    await rendered.click(rendered.part("cancel"));
    expect(posts(rendered)).toEqual([]);
    await rendered.click(rendered.part("submit"));
    const confirm = rendered.parts("submit").find((button) => button.closest('[data-surface="confirmation"]'))!;
    await rendered.click(confirm);
    expect(posts(rendered).map((each) => each.body)).toEqual([{ month: "2026-09" }]);
  });

  it("announces its target and its mutation's invalidates, then runs the form's onSuccess over the answer", async () => {
    const reader = (id: string, path: string) => queryNode({ content: [] }, { id, url: address(path) });
    // Where the effect goes is only recorded, so the readers stay drawn and their reads are counted.
    const follow = vi.spyOn(HostStore.prototype, "follow").mockImplementation(async () => true);
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => json({ ...answer, next: "/done" }), "/api/account": () => json({ authorized: true }), "/api/other": () => json({ authorized: true }) },
      pages: {
        "/": {
          title: "Reports",
          children: [
            submitForm({}, { onSuccess: [navigateTo(address({ root: "result", path: ["next"] }))] }, { invalidates: [address("/api/account")] }),
            reader("account", "/api/account"),
            reader("other", "/api/other"),
          ],
        },
        "/done": { title: "Done", children: [] },
      },
    });
    const reads = () => ["/api/account", "/api/other"].map((path) => rendered!.requests.filter((request) => request === `GET ${path}`).length);
    expect(reads()).toEqual([1, 1]);
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect([reads(), follow.mock.calls.map(([to]) => to)]).toEqual([[2, 1], ["/done"]]);
  });

  it("closes the drawer it is opened in, then lands where onSuccess goes, from a submit and from a record form alike", async () => {
    const drawer = { type: "drawer", side: "end", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };
    const pages = (form: unknown) => ({
      "/": { title: "Home", children: [{ type: "link", text: "Open", to: openPageAt(address("/new"), drawer, false) }] },
      "/new": { title: "New", children: [form] },
      "/done": { title: "Done", children: [{ type: "text", text: "Done page" }] },
    });
    for (const form of [
      submitForm({}, { afterSubmit: "close", onSuccess: [navigateTo(address("/done"))] }),
      formNode("/api/todos", { afterSubmit: "close", onSuccess: [navigateTo(address("/done"))] }),
    ]) {
      rendered = await render({ path: "/", required: ["text"], collections: { "/api/todos": todos }, answers: { "/api/reports": () => json(answer) }, pages: pages(form) as never });
      await rendered.click(rendered.part("link"));
      await rendered.enter(rendered.part("input"), "2026-09");
      await rendered.click(rendered.part("submit"));
      expect([document.querySelector('[data-telo-part="surface"]'), window.location.pathname]).toEqual([null, "/done"]);
      rendered.unmount();
    }
    rendered = undefined;
  });
});

describe("a record form's write", () => {
  it("runs onSuccess over the stored record the collection answered with: a create lands on what it created", async () => {
    rendered = await render({
      path: "/todos/new",
      required: ["text"],
      collections: { "/api/todos": todos },
      pages: {
        "/todos/new": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", onSuccess: [navigateTo(address("/todos/{id}", { id: { root: "result", path: ["id"] } }))] })] },
        "/todos/{id}": { title: "Todo", children: [] },
      },
    });
    await rendered.enter(rendered.part("input"), "Ship it");
    await rendered.click(rendered.part("submit"));
    expect([posts(rendered).map((each) => each.request), window.location.pathname]).toEqual([["POST /api/todos"], `/todos/${todos.length + 1}`]);
  });

  it.each([
    ["no record", [1, 2]],
    ["a record the collection's model refuses", { id: 7 }],
  ])("draws a 2xx answer that is %s as ERR_UI_RESPONSE_INVALID, and runs nothing after it", async (name, body) => {
    rendered = await render({
      path: "/",
      answers: { "/api/todos": () => json(body) },
      pages: { "/": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", onSuccess: [navigateTo(address("/done"))] })] }, "/done": { title: "Done", children: [] } },
    });
    await rendered.enter(rendered.part("input"), "Ship it");
    await rendered.click(rendered.part("submit"));
    expect([rendered.part("error-code").textContent, window.location.pathname]).toEqual(["ERR_UI_RESPONSE_INVALID", "/"]);
  });

  it("draws a body-less 2xx as ERR_UI_RESPONSE_INVALID when onSuccess reads the result, and runs nothing after it", async () => {
    rendered = await render({
      path: "/todos/new",
      collections: { "/api/todos": todos },
      answers: { "/api/todos": () => new Response(null, { status: 201 }) },
      pages: {
        "/todos/new": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", onSuccess: [navigateTo(address("/todos/{id}", { id: { root: "result", path: ["id"] } }))] })] },
        "/todos/{id}": { title: "Todo", children: [] },
      },
    });
    await rendered.enter(rendered.part("input"), "Ship it");
    await rendered.click(rendered.part("submit"));
    expect([rendered.part("error-code").textContent, window.location.pathname]).toEqual(["ERR_UI_RESPONSE_INVALID", "/todos/new"]);
  });

  it("keeps a body-less 2xx a success when onSuccess reads nothing of the answer", async () => {
    rendered = await render({
      path: "/",
      answers: { "/api/todos": () => new Response(null, { status: 201 }) },
      pages: { "/": { title: "New", children: [formNode("/api/todos", { afterSubmit: "keep", onSuccess: [navigateTo(address("/done"))] })] }, "/done": { title: "Done", children: [] } },
    });
    await rendered.enter(rendered.part("input"), "Ship it");
    await rendered.click(rendered.part("submit"));
    expect(window.location.pathname).toBe("/done");
  });
});
