// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { presetRange } from "../src/browser/date-range.js";
import { controlFor } from "../src/browser/record-fields.js";
import { render, type Rendered } from "./harness.js";
import { editFormNode, formNode, memoryState, recordPages, recordQuery, todos, todoSchema } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const show = (answers?: Record<string, () => Response>) =>
  render({ path: "/", required: ["text"], collections: { "/api/todos": todos }, answers, pages: { "/": { title: "New", children: [formNode("/api/todos", { afterSubmit: "again" })] } } });

/** The edit page of one record, reached by its own address; the bodies it PATCHes are recorded,
 *  with the `If-Match` and content type each carried. */
async function edit(row: Record<string, unknown>, fields?: string[], etags = true) {
  const form = editFormNode();
  const shown = fields ? { fields: (form.fields as { property: string }[]).filter((field) => fields.includes(field.property)) } : {};
  const opened = await render({
    path: `/todos/${row.id}`,
    required: ["text"],
    etags,
    collections: { "/api/todos": [row] },
    pages: recordPages({}, shown),
  });
  const bodies: unknown[] = [];
  const sent: { ifMatch: string | null; contentType: string | null }[] = [];
  const platform = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      bodies.push(JSON.parse(String(init.body)));
      const headers = new Headers(init.headers);
      sent.push({ ifMatch: headers.get("if-match"), contentType: headers.get("content-type") });
    }
    return platform(input, init);
  }) as typeof fetch;
  return { opened, bodies, sent };
}

/** A model whose lists are one of each kind a form enters. */
const listSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    formats: { type: "array", title: "Formats", items: { enum: ["pdf", "csv", "xml"] } },
    sizes: { type: "array", title: "Sizes", items: { type: "integer" } },
    notes: { type: ["array", "null"], title: "Notes", items: { type: "string" } },
  },
};
const listForm = (overrides: Record<string, unknown> = {}) =>
  formNode("/api/lists", {
    schema: listSchema,
    fields: ["formats", "sizes", "notes"].map((property) => ({ type: "input", property, label: property, control: "auto" })),
    state: memoryState(["formats", "sizes", "notes"]),
    ...overrides,
  });

describe("a form", () => {
  it("turns the browser's autocomplete off, on itself and on every control typed into", async () => {
    rendered = await show();
    const typed = [...rendered.part("form").querySelectorAll('[data-telo-part="input"], [data-telo-part="textarea"]')];
    expect(typed.map((control) => [control.getAttribute("type") ?? control.tagName, control.getAttribute("autocomplete")])).toEqual([
      ["text", "off"],
      ["number", "off"],
      ["date", "off"],
      ["TEXTAREA", "off"],
    ]);
    expect(rendered.part("form").getAttribute("autocomplete")).toBe("off");
  });

  it("derives each control from what the model says the property is", () => {
    expect(controlFor({ type: "boolean" })).toBe("checkbox");
    expect(controlFor({ enum: ["a", "b"] })).toBe("select");
    expect(controlFor({ type: ["integer", "null"] })).toBe("number");
    expect(controlFor({ type: "string", format: "date" })).toBe("date");
    expect(controlFor({ type: "string", format: "date-time" })).toBe("datetime-local");
    expect(controlFor({ type: "string", contentMediaType: "text/markdown" })).toBe("textarea");
    expect(controlFor({ type: "string", maxLength: 5000 })).toBe("text");
  });

  it("refuses in the page what the model refuses, and sends nothing", async () => {
    rendered = await show();
    await rendered.enter(rendered.part("input"), "x");
    await rendered.enter(rendered.parts("input")[1], "9");
    await rendered.click(rendered.part("submit"));
    expect(rendered.parts("field-error").map((error) => error.textContent)).toEqual(["Must be at least 2 characters", "Must be at most 5"]);
    expect(rendered.parts("field").map((field) => field.getAttribute("data-invalid"))).toEqual(["true", null, "true", null, null, null]);
    expect(rendered.part("input").getAttribute("data-invalid")).toBe("true");
    expect(rendered.part("form").getAttribute("data-state")).toBe("error");
    expect(rendered.requests.some((request) => request.startsWith("POST"))).toBe(false);
  });

  it("posts a record typed by the model, says the collection changed, and clears", async () => {
    rendered = await show();
    const bodies: unknown[] = [];
    const platform = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
      return platform(input, init);
    }) as typeof fetch;
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("checkbox"));
    await rendered.enter(rendered.parts("input")[1], "4");
    await rendered.choose(rendered.part("select"), "blocked");
    await rendered.enter(rendered.parts("input")[2], "2026-11-02");
    await rendered.enter(rendered.part("textarea"), "Two\nlines");
    await rendered.click(rendered.part("submit"));
    expect(bodies).toEqual([{ text: "Plan the launch", isDone: true, priority: 4, status: "blocked", dueOn: "2026-11-02", notes: "Two\nlines" }]);
    expect((rendered.part("input") as HTMLInputElement).value).toBe("");
    expect(rendered.part("form").getAttribute("data-state")).toBe("idle");
  });

  it("posts under the mount", async () => {
    rendered = await render({ path: "/", prefix: "/admin", required: ["text"], collections: { "/api/todos": todos }, pages: { "/": { title: "New", children: [formNode()] } } });
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("submit"));
    expect(rendered.requests.filter((request) => request.startsWith("POST"))).toEqual(["POST /admin/api/todos"]);
  });

  it("starts again from the model's defaults and a date range's initial preset after a save", async () => {
    const thisMonth = { label: "This month", unit: "month" as const, offset: 0 };
    const schema = {
      ...todoSchema,
      properties: {
        ...todoSchema.properties,
        priority: { ...todoSchema.properties.priority, default: 3 },
        status: { ...todoSchema.properties.status, default: "blocked" },
        period: { type: "object", title: "Period", properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
      },
    };
    const range = { type: "dateRange", property: "period", label: "Period", presets: [thisMonth], initialPreset: 0, weekStart: "monday" };
    const form = formNode("/api/todos", { schema, fields: [...(formNode().fields as unknown[]).slice(0, 4), range], state: memoryState(["text", "isDone", "priority", "status", "period"]), afterSubmit: "again" });
    rendered = await render({ path: "/", required: ["text"], collections: { "/api/todos": todos }, pages: { "/": { title: "New", children: [form] } } });
    const started = () => [
      (rendered!.parts("input")[1] as HTMLInputElement).value,
      rendered!.part("select").textContent,
      (rendered!.part("date-range-from") as HTMLInputElement).value,
      (rendered!.part("date-range-to") as HTMLInputElement).value,
    ];
    const { from, to } = presetRange({ unit: "month", offset: 0 } as Parameters<typeof presetRange>[0], "monday", new Date());
    expect(started()).toEqual(["3", "blocked", from, to]);
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.enter(rendered.parts("input")[1], "5");
    await rendered.choose(rendered.part("select"), "open");
    await rendered.enter(rendered.part("date-range-from"), "2020-01-01");
    await rendered.click(rendered.part("submit"));
    expect(rendered.requests.filter((request) => request.startsWith("POST"))).toEqual(["POST /api/todos"]);
    expect((rendered.part("input") as HTMLInputElement).value).toBe("");
    expect(started()).toEqual(["3", "blocked", from, to]);
  });

  it("puts the API's refusals on the fields they name, and the rest on the form", async () => {
    const issues = [
      { pointer: "/body/text", keyword: "maxLength", params: { limit: 5 } },
      { pointer: "/body/owner", keyword: "required", params: { missingProperty: "owner" } },
    ];
    rendered = await show({ "/api/todos": () => new Response(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "The request is not valid.", code: "ERR_INPUT_INVALID", data: { issues } }), { status: 400 }) });
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("field-error").textContent).toBe("Must be at most 5 characters");
    expect(rendered.part("form-error").textContent).toBe("owner: Is required");
  });

  it("shows a refused request as its own error node", async () => {
    rendered = await show({ "/api/todos": () => new Response(null, { status: 403 }) });
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_FORBIDDEN");
    expect(rendered.part("form").getAttribute("data-state")).toBe("error");
  });

  it("sends a merge patch of what changed, an emptied field as null, and nothing it left alone", async () => {
    const { opened, bodies, sent } = await edit({ id: 7, text: "Write the plan", isDone: true, priority: 2, status: "done", dueOn: "2026-10-01" });
    rendered = opened;
    await opened.enter(opened.parts("input")[1], "");
    await opened.choose(opened.part("select"), "None");
    await opened.click(opened.part("submit"));
    expect(bodies).toEqual([{ priority: null, status: null }]);
    expect(sent.map((each) => each.contentType)).toEqual(["application/merge-patch+json"]);
    // The collection merged the patch, so only the two properties are gone from the row.
    expect((await (await fetch("/api/todos")).json()).rows).toEqual([{ id: 7, text: "Write the plan", isDone: true, dueOn: "2026-10-01" }]);
  });

  it("leaves a column the form's model does not show unchanged, naming only what was edited", async () => {
    const { opened, bodies } = await edit(
      { id: 7, text: "Write the plan", isDone: true, priority: 2, dueOn: "2026-10-01", revision: 3 },
      ["text"],
    );
    rendered = opened;
    await opened.enter(opened.part("input"), "Rewrite the plan");
    await opened.click(opened.part("submit"));
    expect(bodies).toEqual([{ text: "Rewrite the plan" }]);
  });

  it("sends an empty patch from a form that changed nothing", async () => {
    const { opened, bodies } = await edit({ id: 7, text: "Write the plan", isDone: false });
    rendered = opened;
    await opened.click(opened.part("submit"));
    expect(bodies).toEqual([{}]);
  });

  it("carries the validator of its read as If-Match, and none against a server sending no ETag", async () => {
    const guarded = await edit({ id: 7, text: "Write the plan", isDone: false });
    rendered = guarded.opened;
    await guarded.opened.enter(guarded.opened.part("input"), "Rewrite the plan");
    await guarded.opened.click(guarded.opened.part("submit"));
    expect(guarded.sent.map((each) => each.ifMatch)).toEqual([expect.stringMatching(/^"[A-Za-z0-9_-]+"$/)]);
    guarded.opened.unmount();
    const open = await edit({ id: 7, text: "Write the plan", isDone: false }, undefined, false);
    rendered = open.opened;
    await open.opened.enter(open.opened.part("input"), "Rewrite the plan");
    await open.opened.click(open.opened.part("submit"));
    expect(open.sent.map((each) => each.ifMatch)).toEqual([null]);
  });

  it("keeps what was typed when another save came first, reads again, and succeeds on a second press", async () => {
    const { opened, bodies, sent } = await edit({ id: 7, text: "Write the plan", isDone: false });
    rendered = opened;
    // Another session saves the record after this one read it.
    await fetch("/api/todos/7", { method: "PATCH", body: JSON.stringify({ text: "Someone else's plan" }) });
    await opened.enter(opened.part("input"), "My plan");
    await opened.click(opened.part("submit"));
    expect(opened.part("error-code").textContent).toBe("ERR_CRUD_PRECONDITION_FAILED");
    expect((opened.part("input") as HTMLInputElement).value).toBe("My plan");
    // The refusal tells the page's own read of the record, and the form reads it again for its validator.
    expect(opened.requests.filter((request) => request.endsWith("/api/todos/7")).slice(-3)).toEqual(["PATCH /api/todos/7", "GET /api/todos/7", "GET /api/todos/7"]);
    await opened.click(opened.part("submit"));
    // The first write is the other session's, which the helper's recorder saw too.
    expect(bodies.slice(1)).toEqual([{ text: "My plan" }, { text: "My plan" }]);
    expect(sent[2].ifMatch).not.toBe(sent[1].ifMatch);
    expect(opened.parts("error-code")).toEqual([]);
    expect((await (await fetch("/api/todos/7")).json()).text).toBe("My plan");
  });

  it("refuses in the page an edit that empties a required field", async () => {
    const { opened, bodies } = await edit({ id: 7, text: "Write the plan", isDone: false });
    rendered = opened;
    await opened.enter(opened.part("input"), "");
    await opened.click(opened.part("submit"));
    expect(opened.part("field-error").textContent).toBe("Is required");
    expect(bodies).toEqual([]);
  });

  it("enters a list of listed values as a multi-choice and any other list as typed tags, and leaves an empty list out", async () => {
    rendered = await render({ path: "/", collections: { "/api/lists": [] }, pages: { "/": { title: "New", children: [listForm()] } } });
    expect(controlFor(listSchema.properties.formats)).toBe("options");
    expect(controlFor(listSchema.properties.notes)).toBe("tags");
    const [pdf, , xml] = rendered.parts("option");
    // Chosen last first: the list is sent in the order the model lists its values.
    await rendered.click(xml);
    await rendered.click(pdf);
    const [sizes] = rendered.parts("input");
    expect(sizes.getAttribute("type")).toBe("number");
    for (const size of ["3", "5", "7"]) {
      await rendered.enter(sizes, size);
      await rendered.commit(sizes, "enter");
    }
    await rendered.click(rendered.parts("tag-remove")[1]);
    expect(rendered.parts("tag").map((tag) => tag.textContent)).toEqual(["3", "7"]);
    await rendered.click(rendered.part("submit"));
    expect(rendered.sent.map((each) => each.body)).toEqual([{ formats: ["pdf", "xml"], sizes: [3, 7] }]);
  });

  it("opens an edit with the record's lists in their controls", async () => {
    const row = { id: 7, formats: ["csv"], sizes: [2, 4] };
    const form = listForm({ record: { basePath: "/api/lists", key: { root: "params", path: ["id"] }, answer: listSchema }, initialValues: { root: "data", path: [] } });
    rendered = await render({
      path: "/lists/7",
      collections: { "/api/lists": [row] },
      pages: { "/lists/{id}": { title: "List", children: [recordQuery([form], "/api/lists", listSchema)] } },
    });
    expect(rendered.parts("option").map((option) => option.getAttribute("data-state"))).toEqual(["off", "on", "off"]);
    expect(rendered.parts("tag").map((tag) => tag.textContent)).toEqual(["2", "4"]);
    expect(rendered.part("form").getAttribute("data-dirty")).toBeNull();
    await rendered.click(rendered.part("submit"));
    // Nothing changed, so the patch names nothing.
    expect(rendered.sent.map((each) => each.body)).toEqual([{}]);
  });
});
