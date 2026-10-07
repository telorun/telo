// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { controlFor } from "../src/browser/form.js";
import { render, type Rendered } from "./harness.js";
import { formNode, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const show = (answers?: Record<string, () => Response>) =>
  render({ path: "/", required: ["text"], collections: { "/api/todos": todos }, answers, pages: { "/": { title: "New", children: [formNode()] } } });

/** A table over one row, whose edit form shows `fields`; the bodies it PUTs are recorded. */
async function edit(row: Record<string, unknown>, fields?: string[]) {
  const form = formNode();
  const shown = fields ? { ...form, fields: (form.fields as { property: string }[]).filter((field) => fields.includes(field.property)) } : form;
  const opened = await render({
    path: "/",
    required: ["text"],
    collections: { "/api/todos": [row] },
    pages: { "/": { title: "Todos", children: [tableNode({ columns: [], edit: shown })] } },
  });
  const bodies: unknown[] = [];
  const platform = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)));
    return platform(input, init);
  }) as typeof fetch;
  await opened.click(opened.part("row-edit"));
  return { opened, bodies };
}

describe("a form", () => {
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

  it("puts the API's refusals on the fields they name, and the rest on the form", async () => {
    const details = [
      { location: "body", path: "text", message: "is already taken" },
      { location: "body", path: "owner", message: "is a required property" },
    ];
    rendered = await show({ "/api/todos": () => new Response(JSON.stringify({ error: "ValidationError", status: 400, details }), { status: 400 }) });
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("field-error").textContent).toBe("is already taken");
    expect(rendered.part("form-error").textContent).toBe("owner is a required property");
  });

  it("shows a refused request as its own error node", async () => {
    rendered = await show({ "/api/todos": () => new Response(null, { status: 403 }) });
    await rendered.enter(rendered.part("input"), "Plan the launch");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_FORBIDDEN");
    expect(rendered.part("form").getAttribute("data-state")).toBe("error");
  });

  it("sends an edited row without the property of a field that was emptied", async () => {
    const { opened, bodies } = await edit({ id: 7, text: "Write the plan", isDone: true, priority: 2, status: "done", dueOn: "2026-10-01" });
    rendered = opened;
    await opened.enter(opened.parts("input")[1], "");
    await opened.choose(opened.part("select"), "None");
    await opened.click(opened.part("submit"));
    const sent = { id: 7, text: "Write the plan", isDone: true, dueOn: "2026-10-01" };
    expect(bodies).toEqual([sent]);
    // The collection replaced the row, so the two properties are gone from it.
    expect((await (await fetch("/api/todos")).json()).rows).toEqual([sent]);
  });

  it("sends back what the row held for a model property it does not show, and nothing the model does not declare", async () => {
    const { opened, bodies } = await edit(
      { id: 7, text: "Write the plan", isDone: true, priority: 2, status: null, dueOn: "2026-10-01", revision: 3 },
      ["text"],
    );
    rendered = opened;
    await opened.enter(opened.part("input"), "Rewrite the plan");
    await opened.click(opened.part("submit"));
    expect(bodies).toEqual([{ id: 7, text: "Rewrite the plan", isDone: true, priority: 2, dueOn: "2026-10-01" }]);
  });

  it("refuses in the page an edit that empties a required field", async () => {
    const { opened, bodies } = await edit({ id: 7, text: "Write the plan", isDone: false });
    rendered = opened;
    await opened.enter(opened.part("input"), "");
    await opened.click(opened.part("submit"));
    expect(opened.part("field-error").textContent).toBe("Is required");
    expect(bodies).toEqual([]);
  });
});
