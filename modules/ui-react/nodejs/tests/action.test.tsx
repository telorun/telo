// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import reportRequest from "../../tests/__fixtures__/action/report-request.json" with { type: "json" };
import { render, type Rendered } from "./harness.js";
import { actionNode, reportSchema } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = { month: "2026-09", files: [{ name: "2026-09.pdf", url: "/files/2026-09.pdf" }, { name: "2026-09.csv", url: "javascript:alert(1)" }], totals: "none" };

const show = (respond: () => Response | Promise<Response> = () => json(answer), node = actionNode()) =>
  render({ path: "/", prefix: "/admin", answers: { "/api/reports": respond }, pages: { "/": { title: "Reports", children: [node] } } });

const state = (r: Rendered) => r.part("action").getAttribute("data-state");
const posts = (r: Rendered) => r.sent.filter((each) => each.request.startsWith("POST"));
const within = (r: Rendered, part: string, name: string) => [...r.part(part).querySelectorAll<HTMLElement>(`[data-telo-part="${name}"]`)];
const texts = (elements: Element[]) => elements.map((element) => element.textContent);

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
    expect(posts(rendered)).toEqual([{ request: "POST /api/reports", contentType: "application/json", body: reportRequest }]);
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
    finish(json({ message: "it broke" }, 500));
    await rendered.settle();
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_REQUEST_FAILED");
    expect(rendered.parts("action-result")).toEqual([]);
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("error")).toEqual([]);
    expect(state(rendered)).toBe("submitting");
  });

  it("puts a 400's details on the fields they name and the rest under the form", async () => {
    const details = [
      { location: "body", path: "month", message: "is in the future" },
      { location: "body", path: "owner", message: "is a required property" },
    ];
    rendered = await show(() => json({ error: "ValidationError", message: "Request validation failed", status: 400, details }, 400));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("field")[0].getAttribute("data-invalid")).toBe("true");
    expect(texts(rendered.parts("field-error"))).toEqual(["is in the future"]);
    expect(rendered.part("form-error").textContent).toBe("owner is a required property");
    expect(state(rendered)).toBe("error");
    expect(rendered.parts("error")).toEqual([]);
  });

  it.each([
    ["an action", actionNode()],
    ["a form", { type: "form", schema: reportSchema, basePath: "/api/reports", fields: actionNode().fields }],
  ])("marks the list controls of %s a 400 names, until a record is accepted", async (name, node) => {
    const details = ["formats", "recipients"].map((path) => ({ location: "body", path, message: "is refused" }));
    let respond = () => json({ error: "ValidationError", status: 400, details }, 400);
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

  it("shows a 400 that names nothing as its message, under the form", async () => {
    rendered = await show(() => json({ error: "ValidationError", message: "No report for that month", status: 400 }, 400));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("form-error").textContent).toBe("No report for that month");
  });

  it.each([
    ["a 401", () => new Response(null, { status: 401 }), "ERR_UI_UNAUTHORIZED"],
    ["a 403", () => new Response(null, { status: 403 }), "ERR_UI_FORBIDDEN"],
    ["a 500", () => json({ message: "it broke" }, 500), "ERR_UI_REQUEST_FAILED"],
    [
      "no answer at all",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "ERR_UI_REQUEST_FAILED",
    ],
    ["a success that is a list", () => json([{ name: "a" }]), "ERR_UI_RESPONSE_INVALID"],
    ["a success that is not JSON", () => new Response("done", { status: 200 }), "ERR_UI_RESPONSE_INVALID"],
  ])("shows %s as an error node where the answer would be", async (name, respond, code) => {
    rendered = await show(respond);
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(texts(within(rendered, "action", "error-code"))).toEqual([code]);
    expect(rendered.part("error").previousElementSibling).toBe(rendered.part("form"));
    expect(rendered.parts("action-result")).toEqual([]);
    expect(state(rendered)).toBe("error");
  });

  it("does not read the answer of an action that draws nothing", async () => {
    rendered = await show(() => new Response("done", { status: 200 }), actionNode({ lists: [] }));
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    expect(state(rendered)).toBe("idle");
    expect(rendered.parts("error")).toEqual([]);
    expect(rendered.parts("action-result")).toEqual([]);
  });
});
