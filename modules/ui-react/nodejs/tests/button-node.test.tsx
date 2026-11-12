// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";
import { commentSchema, decisionSchema, operation, promptOf, reviewerState } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  localStorage.clear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const decide = (overrides: Record<string, unknown> = {}) => operation("/api/plans/p7/decisions", "Approve", decisionSchema, overrides);
const bound = { id: { value: "p7" }, decision: { value: "approve" }, revision: { value: 3 } };
const button = (action = decide(), more: Record<string, unknown> = {}) => ({ type: "button", action, inputs: bound, button: { type: "text" }, ...more });
const prompted = (action = decide(), more: Record<string, unknown> = {}) => button(action, { prompt: promptOf(action, ["author", "note"]), ...more });
const show = (children: unknown[]) => render({ path: "/", pages: { "/": { title: "Plan", children: children as never } } });

const dialog = () => document.querySelector<HTMLElement>('[data-surface="confirmation"]');
const inputs = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-telo-part="input"], [data-telo-part="textarea"]') ?? [])];
const confirm = (r: Rendered) => r.click(dialog()!.querySelector('[data-telo-part="submit"]')!);
const labels = () => [...(dialog()?.querySelectorAll('[data-telo-part="label"]') ?? [])].map((label) => label.textContent);

describe("a button node", () => {
  it("sends the inputs it binds with what its prompt asked for, and draws the action's answer in its place", async () => {
    const action = decide({ result: { type: "text", text: "Approved." } });
    rendered = await show([prompted(action)]);
    rendered.answer("/api/plans/p7/decisions", () => json({ state: "approved" }, 201));
    expect([rendered.part("button").textContent, rendered.part("button").getAttribute("data-button")]).toEqual(["Approve", "text"]);
    await rendered.click(rendered.part("button"));
    expect(labels()).toEqual(["Your name", "Note"]);
    const [author, note] = inputs();
    await rendered.enter(author, "Ada");
    await rendered.enter(note, "Ship it.");
    await confirm(rendered);
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([
      ["POST /api/plans/p7/decisions", { id: "p7", decision: "approve", revision: 3, author: "Ada", note: "Ship it." }],
    ]);
    expect([dialog(), rendered.parts("button"), rendered.part("row-answer").textContent]).toEqual([null, [], "Approved."]);
  });

  it("holds the bound and entered record to the whole input model before anything is sent", async () => {
    const required = { ...decisionSchema, required: [...decisionSchema.required, "note"] };
    rendered = await show([prompted(decide({ schema: required })), button(decide(), { inputs: { ...bound, revision: { root: "query", path: ["revision"] } }, prompt: promptOf(decide(), ["author"]) })]);
    await rendered.click(rendered.parts("button")[0]);
    await rendered.enter(inputs()[0], "Ada");
    await confirm(rendered);
    expect([rendered.sent, dialog()?.querySelector('[data-telo-part="field-error"]')?.textContent]).toEqual([[], "Is required"]);
    await rendered.click(dialog()!.querySelector('[data-telo-part="cancel"]')!);
    // A required input its binding leaves empty is named under the fields.
    await rendered.click(rendered.parts("button")[1]);
    await rendered.enter(inputs()[0], "Ada");
    await confirm(rendered);
    expect([rendered.sent, dialog()?.querySelector('[data-telo-part="form-error"]')?.textContent]).toEqual([[], "revision: Is required"]);
  });

  it("shows a 400's issues on the prompt's fields, keeping what was entered", async () => {
    rendered = await show([prompted()]);
    rendered.answer("/api/plans/p7/decisions", () =>
      json({ type: "about:blank", title: "Bad Request", status: 400, code: "ERR_INPUT_INVALID", data: { issues: [{ pointer: "/body/note", keyword: "required", params: { missingProperty: "note" } }] } }, 400),
    );
    await rendered.click(rendered.part("button"));
    await rendered.enter(inputs()[0], "Ada");
    await confirm(rendered);
    const [author, note] = [...dialog()!.querySelectorAll('[data-telo-part="field"]')];
    expect([author.querySelector('[data-telo-part="field-error"]'), note.querySelector('[data-telo-part="field-error"]')?.textContent, (inputs()[0] as HTMLInputElement).value]).toEqual([null, "Is required", "Ada"]);
    expect(dialog()!.querySelector('[data-telo-part="error"]')).toBeNull();
  });

  it("draws a refusal beside itself, and takes no press while one is pending", async () => {
    let answer!: (response: Response) => void;
    rendered = await show([button(decide({ schema: { ...decisionSchema, required: ["id"] } }))]);
    rendered.answer("/api/plans/p7/decisions", () => new Promise<Response>((resolve) => (answer = resolve)));
    await rendered.click(rendered.part("button"));
    expect([(rendered.part("button") as HTMLButtonElement).disabled, rendered.part("button").getAttribute("data-state")]).toEqual([true, "submitting"]);
    await rendered.click(rendered.part("button"));
    answer(json({ type: "about:blank", title: "Conflict", status: 409, code: "ERR_REVISION_SUPERSEDED", detail: "A newer revision was submitted." }, 409));
    await rendered.settle();
    expect(rendered.sent).toHaveLength(1);
    expect(rendered.part("button").nextElementSibling?.getAttribute("data-telo-part")).toBe("row-failure");
    expect([...rendered.part("row-failure").querySelectorAll('[data-telo-part="value"]')].map((each) => each.textContent)).toEqual([
      "ERR_REVISION_SUPERSEDED",
      "A newer revision was submitted.",
    ]);
  });
});

describe("a prompt's kept values", () => {
  it("are one value per key: what a comment's prompt enters, a decision's prompt opens with", async () => {
    const comment = operation("/api/plans/p7/comments", "Comment", commentSchema, { state: reviewerState(["author"]) });
    const commenting = { type: "button", action: comment, inputs: { id: { value: "p7" }, revision: { value: 3 } }, prompt: promptOf(comment, ["author", "body"]), button: { type: "text" } };
    rendered = await show([commenting, prompted(decide({ state: reviewerState(["author"]) }))]);
    rendered.answer("/api/plans/p7/comments", () => new Response(null, { status: 201 }));
    await rendered.click(rendered.parts("button")[0]);
    await rendered.enter(inputs()[0], "Ada");
    await rendered.enter(inputs()[1], "Split it further.");
    await confirm(rendered);
    await rendered.click(rendered.parts("button")[1]);
    expect([labels(), (inputs()[0] as HTMLInputElement).value, (inputs()[1] as HTMLInputElement).value]).toEqual([["Your name", "Note"], "Ada", ""]);
  });

  it("are merged into the store: a prompt keeping fewer properties leaves another entry's, which follows its change", async () => {
    localStorage.setItem("telo.ui:/:v:reviewer", JSON.stringify({ v: 1, values: { author: "Ada", team: "red" } }));
    const wide = operation("/api/profile", "Save", { type: "object", properties: { author: { type: "string" }, team: { type: "string" } } }, { state: reviewerState(["author", "team"]) });
    rendered = await show([wide, prompted(decide({ state: reviewerState(["author"]) }))]);
    await rendered.click(rendered.part("button"));
    expect((inputs()[0] as HTMLInputElement).value).toBe("Ada");
    await rendered.enter(inputs()[0], "Grace");
    const form = [...rendered.part("action").querySelectorAll<HTMLInputElement>('[data-telo-part="input"]')].map((each) => each.value);
    expect([JSON.parse(localStorage.getItem("telo.ui:/:v:reviewer")!), form]).toEqual([{ v: 1, values: { author: "Grace", team: "red" } }, ["Grace", "red"]]);
  });
});
