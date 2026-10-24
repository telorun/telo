// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import reportRequest from "../../tests/__fixtures__/action/report-request.json" with { type: "json" };
import { HostStore } from "../src/browser/host.js";
import { render, type Rendered } from "./harness.js";
import { actionNode, reportSchema } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = { month: "2026-09", files: [{ name: "2026-09.pdf", url: "/files/2026-09.pdf" }, { name: "2026-09.csv", url: "javascript:alert(1)" }], totals: "none" };

// An action posts to its path under the mount.
const show = (respond: () => Response | Promise<Response> = () => json(answer), node = actionNode()) =>
  render({ path: "/", prefix: "/admin", answers: { "/admin/api/reports": respond }, pages: { "/": { title: "Reports", children: [node] } } });

const state = (r: Rendered) => r.part("action").getAttribute("data-state");
const posts = (r: Rendered) => r.sent.filter((each) => each.request.startsWith("POST"));
const within = (r: Rendered, part: string, name: string) => [...r.part(part).querySelectorAll<HTMLElement>(`[data-telo-part="${name}"]`)];
const texts = (elements: Element[]) => elements.map((element) => element.textContent);
/** What the action's failure tree draws: each value it presents. */
const failure = (r: Rendered) => texts(within(r, "action-failure", "value"));

/** Enter the record of the shared request body. */
async function enterReport(r: Rendered) {
  const [month, copies, recipient] = r.parts("input");
  await r.enter(month, reportRequest.month);
  await r.enter(copies, String(reportRequest.copies));
  for (const option of r.parts("option")) await r.click(option);
  for (const address of reportRequest.recipients) {
    await r.enter(recipient, address);
    await r.commit(recipient, "enter");
  }
}

describe("an action", () => {
  it("draws a control per field as a form does, and a button under its label", async () => {
    rendered = await show();
    expect(texts(rendered.parts("label"))).toEqual(["Month", "Copies", "Formats", "Recipients"]);
    expect(rendered.parts("field").map((field) => field.children[1].getAttribute("data-telo-part"))).toEqual(["input", "input", "options", "tags"]);
    expect(rendered.parts("input").map((input) => input.getAttribute("type"))).toEqual(["text", "number", "text"]);
    expect(texts(rendered.parts("option"))).toEqual(["pdf", "csv"]);
    expect(rendered.part("submit").textContent).toBe("Generate");
    expect(rendered.part("submit").closest('[data-telo-part="form"]')?.parentElement).toBe(rendered.part("action"));
    expect(state(rendered)).toBe("idle");
  });

  it("refuses in the page what the input model refuses, an item of a list included, and sends nothing", async () => {
    rendered = await show();
    const recipient = rendered.parts("input")[2];
    await rendered.enter(recipient, "ab");
    await rendered.commit(recipient, "enter");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("field").map((field) => field.querySelector('[data-telo-part="field-error"]')?.textContent)).toEqual([
      "Is required",
      undefined,
      undefined,
      "Must be at least 3 characters",
    ]);
    expect(state(rendered)).toBe("error");
    expect(posts(rendered)).toEqual([]);
  });

  it("posts the entered record as JSON, its button disabled while the operation runs, and keeps what was entered", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show(() => new Promise<Response>((resolve) => (finish = resolve)));
    await enterReport(rendered);
    await rendered.click(rendered.part("submit"));
    expect(posts(rendered)).toEqual([{ request: "POST /admin/api/reports", contentType: "application/json", body: reportRequest }]);
    expect((rendered.part("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(state(rendered)).toBe("submitting");
    finish(json(answer));
    await rendered.settle();
    expect((rendered.part("submit") as HTMLButtonElement).disabled).toBe(false);
    expect(state(rendered)).toBe("idle");
    expect((rendered.part("input") as HTMLInputElement).value).toBe("2026-09");
    expect(texts(rendered.parts("tag"))).toEqual(reportRequest.recipients);
    expect(rendered.parts("option").map((option) => option.getAttribute("data-state"))).toEqual(["on", "on"]);
  });

  it("leaves out a field that holds nothing, and sends a checkbox as true or false", async () => {
    const schema = { ...reportSchema, properties: { ...reportSchema.properties, urgent: { type: "boolean", title: "Urgent" } } };
    const fields = Object.entries(schema.properties).map(([property, { title }]) => ({ property, label: title }));
    rendered = await show(undefined, actionNode({ schema, fields }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(posts(rendered).map((each) => each.body)).toEqual([{ month: "2026-09", urgent: false }]);
  });

  it("draws each list of the answer in order: a heading, headers, a row per element, and no rows where there is no list", async () => {
    rendered = await show();
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    const [files, totals] = within(rendered, "action-result", "list");
    expect(texts(rendered.parts("list-heading"))).toEqual(["Files"]);
    expect(files.firstElementChild).toBe(rendered.part("list-heading"));
    expect(texts([...files.querySelectorAll('[data-telo-part="table-header-cell"]')])).toEqual(["File", "Download", "Month", "Kind"]);
    expect([...files.querySelectorAll('[data-telo-part="table-row"]')].map((row) => texts([...row.children]))).toEqual([
      ["2026-09.pdf", "/files/2026-09.pdf", "2026-09", "report"],
      ["2026-09.csv", "javascript:alert(1)", "2026-09", "report"],
    ]);
    // An address the row holds is a link under the mount; what is no address is text.
    // It is no page of the application, so it opens beside it.
    expect([...files.querySelectorAll("a")].map((link) => [link.getAttribute("data-telo-part"), link.getAttribute("href"), link.getAttribute("target")])).toEqual([
      ["link", "/admin/files/2026-09.pdf", "_blank"],
    ]);
    // `totals` is not a list in this answer.
    expect(texts([...totals.querySelectorAll('[data-telo-part="table-header-cell"]')])).toEqual(["Made"]);
    expect(totals.querySelector('[data-telo-part="table-empty"]')?.textContent).toBe("No rows.");
    expect(totals.querySelectorAll('[data-telo-part="table-row"]')).toHaveLength(0);
  });

  it("clears the last answer and the last failure when it is pressed again", async () => {
    let respond = (): Response | Promise<Response> => json({ ...answer, files: [] });
    rendered = await show(() => respond());
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    // A list with nothing in it shows the empty state too.
    expect(rendered.parts("table-empty")).toHaveLength(2);
    let finish: (response: Response) => void = () => {};
    respond = () => new Promise<Response>((resolve) => (finish = resolve));
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("action-result")).toEqual([]);
    finish(json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500));
    await rendered.settle();
    expect(failure(rendered)).toEqual(["ERR_UI_REQUEST_FAILED", "The request failed with status 500."]);
    expect(rendered.parts("action-result")).toEqual([]);
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("action-failure")).toEqual([]);
    expect(state(rendered)).toBe("submitting");
  });

  it("puts a 400's issues on the fields they name and the rest under the form, in its own words, and draws its failure", async () => {
    const issues = [
      { pointer: "/body/month", keyword: "pattern", params: { pattern: "^[0-9]{4}-[0-9]{2}$" } },
      { pointer: "/body/owner", keyword: "required", params: { missingProperty: "owner" } },
    ];
    rendered = await show(() => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues } }, 400));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("field")[0].getAttribute("data-invalid")).toBe("true");
    expect(texts(rendered.parts("field-error"))).toEqual(["Is not in the expected format"]);
    expect(rendered.part("form-error").textContent).toBe("owner: Is required");
    expect(state(rendered)).toBe("error");
    expect(failure(rendered)).toEqual(["ERR_INPUT_INVALID", "The request is not valid."]);
  });

  it.each([
    ["an action", actionNode()],
    ["a form", { type: "form", schema: reportSchema, basePath: "/api/reports", fields: actionNode().fields, groups: [], state: actionNode().state }],
  ])("marks the list controls of %s a 400 names, until a record is accepted", async (name, node) => {
    const issues = ["formats", "recipients"].map((property) => ({ pointer: `/body/${property}`, keyword: "minItems", params: { limit: 2 } }));
    let respond = () => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues } }, 400);
    rendered = await show(() => respond(), node);
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    const typedInto = rendered.part("tags").querySelector("input") as HTMLInputElement;
    expect([rendered.part("options").getAttribute("data-invalid"), rendered.part("tags").getAttribute("data-invalid")]).toEqual(["true", "true"]);
    expect([typedInto.getAttribute("aria-invalid"), typedInto.getAttribute("data-invalid")]).toEqual(["true", null]);
    expect(rendered.parts("option").map((option) => option.getAttribute("data-invalid"))).toEqual([null, null]);
    respond = () => json(answer);
    await rendered.click(rendered.part("submit"));
    expect([rendered.part("options").getAttribute("data-invalid"), rendered.part("tags").getAttribute("data-invalid")]).toEqual([null, null]);
  });

  it("draws a 400 that names nothing as its failure, with the code its body gives", async () => {
    rendered = await show(() => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "No report for that month", code: "ERR_NO_REPORT" }, 400));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("form-error")).toEqual([]);
    expect(failure(rendered)).toEqual(["ERR_NO_REPORT", "No report for that month"]);
  });

  it.each([
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
  ])("draws %s as its failure where the answer would be", async (name, respond, code) => {
    rendered = await show(respond);
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(failure(rendered)[0]).toBe(code);
    expect(rendered.part("action-failure").previousElementSibling).toBe(rendered.part("form"));
    expect(rendered.parts("action-result")).toEqual([]);
    expect(state(rendered)).toBe("error");
  });

  it("draws no answer at all with the status absent", async () => {
    const tree = { type: "stack", children: [{ type: "value", value: { root: "error", path: ["status"] } }, { type: "value", value: { root: "error", path: ["code"] } }] };
    rendered = await show(() => {
      throw new TypeError("Failed to fetch");
    }, actionNode({ failure: tree }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(failure(rendered)).toEqual(["", "ERR_UI_REQUEST_FAILED"]);
  });

  it("draws a success that does not fit the declared answer as its failure", async () => {
    rendered = await show(() => json({ files: "none" }), actionNode({ answer: { type: "object", properties: { files: { type: "array" } } } }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(failure(rendered)[0]).toBe("ERR_UI_RESPONSE_INVALID");
    expect(rendered.parts("action-result")).toEqual([]);
  });

  it("draws its result over the record sent and the form's current values", async () => {
    const tree = { type: "stack", children: [{ type: "value", value: { root: "input", path: ["month"] } }, { type: "value", value: { root: "values", path: ["month"] } }] };
    rendered = await show(() => json({}), actionNode({ result: tree }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    await rendered.enter(rendered.part("input"), "2026-10");
    expect(texts(within(rendered, "action-result", "value"))).toEqual(["2026-09", "2026-10"]);
  });

  it("clears its answer when a property it lists changes, and keeps it for any other", async () => {
    rendered = await show(() => json(answer), actionNode({ clearAnswerOn: ["copies"] }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    await rendered.enter(rendered.part("input"), "2026-10");
    expect(rendered.parts("action-result")).toHaveLength(1);
    await rendered.enter(rendered.parts("input")[1], "2");
    expect(rendered.parts("action-result")).toEqual([]);
  });

  it("takes no second press while the first is pending", async () => {
    let finish: (response: Response) => void = () => {};
    rendered = await show(() => new Promise<Response>((resolve) => (finish = resolve)));
    await rendered.enter(rendered.part("input"), "2026-09");
    const form = rendered.part("form");
    await act(async () => {
      for (let press = 0; press < 2; press++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(posts(rendered)).toHaveLength(1);
    finish(json(answer));
    await rendered.settle();
  });

  it("runs the presses of a serial action on the page one after another", async () => {
    const finishes: ((response: Response) => void)[] = [];
    const serial = actionNode({ concurrency: "serial" });
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => new Promise<Response>((resolve) => finishes.push(resolve)) },
      pages: { "/": { title: "Reports", children: [serial, serial] } },
    });
    for (const input of rendered.parts("form").map((form) => form.querySelector('[data-telo-part="input"]') as Element)) await rendered.enter(input, "2026-09");
    for (const submit of rendered.parts("submit")) await rendered.click(submit);
    expect(posts(rendered)).toHaveLength(1);
    expect(rendered.parts("action").map((each) => each.getAttribute("data-state"))).toEqual(["submitting", "submitting"]);
    finishes[0](json(answer));
    await rendered.settle();
    expect(posts(rendered)).toHaveLength(2);
    finishes[1](json(answer));
    await rendered.settle();
    expect(rendered.parts("action-result")).toHaveLength(2);
  });

  it("leaves the page for an absolute address its answer names, and moves within it for a declared page", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    const going = (to: unknown) => actionNode({ result: undefined, onSuccess: { navigate: { root: "result", path: ["next"] }, refreshes: [] } });
    rendered = await render({
      path: "/",
      prefix: "/admin",
      answers: { "/admin/api/reports": () => json({ next: "https://example.com/report" }) },
      pages: { "/": { title: "Reports", children: [going("https")] }, "/done": { title: "Done", children: [] } },
    });
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(leave.mock.calls).toEqual([["https://example.com/report"]]);
    rendered.answer("/admin/api/reports", () => json({ next: "/done" }));
    await rendered.click(rendered.part("submit"));
    expect(window.location.pathname).toBe("/admin/done");
    expect(leave.mock.calls).toHaveLength(1);
  });

  it("navigates nowhere for a value that is no address, and draws its answer", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    rendered = await show(() => json({ ...answer, next: "javascript:alert(1)" }), actionNode({ onSuccess: { navigate: { root: "result", path: ["next"] }, refreshes: [] } }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(leave).not.toHaveBeenCalled();
    expect(rendered.parts("action-result")).toHaveLength(1);
  });

  it("does not read the answer of an action that draws nothing", async () => {
    rendered = await show(() => new Response("done", { status: 200 }), actionNode({ result: undefined }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(state(rendered)).toBe("idle");
    expect(rendered.parts("error")).toEqual([]);
    expect(rendered.parts("action-result")).toEqual([]);
  });
});
