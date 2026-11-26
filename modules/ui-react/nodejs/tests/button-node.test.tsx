// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";
import { buttonOf, call, decisionSchema, literals, promptOf } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  localStorage.clear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bound = literals({ id: "p7", decision: "approve", revision: 3 });
const asked = { author: { root: "prompt", path: ["author"] }, note: { root: "prompt", path: ["note"] } };
const decide = (overrides: Record<string, unknown> = {}) => call("/api/plans/p7/decisions", "Approve", decisionSchema, { inputs: bound, ...overrides });
/** A decision whose dialog asks who decides, and why. */
const prompted = (overrides: Record<string, unknown> = {}) =>
  buttonOf(decide({ inputs: { ...bound, ...asked }, prompt: promptOf(decisionSchema, ["author", "note"]), ...overrides }));
const show = (children: unknown[]) => render({ path: "/", pages: { "/": { title: "Plan", children: children as never } } });

const dialog = () => document.querySelector<HTMLElement>('[data-surface="confirmation"]');
const inputs = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-telo-part="input"], [data-telo-part="textarea"]') ?? [])];
const confirm = (r: Rendered) => r.click(dialog()!.querySelector('[data-telo-part="submit"]')!);
const labels = () => [...(dialog()?.querySelectorAll('[data-telo-part="label"]') ?? [])].map((label) => label.textContent);

describe("a button node", () => {
  it("sends the inputs it binds with what its prompt asked for, and draws the call's answer in its place", async () => {
    rendered = await show([prompted({ result: { type: "text", text: "Approved." } })]);
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
    expect([dialog(), rendered.parts("button"), rendered.part("mutation-result").textContent]).toEqual([null, [], "Approved."]);
  });

  it("sends nothing while a required entry of its prompt is empty, and says so on the field", async () => {
    rendered = await show([prompted()]);
    await rendered.click(rendered.part("button"));
    await confirm(rendered);
    expect([rendered.sent, dialog()?.querySelector('[data-telo-part="field-error"]')?.textContent]).toEqual([[], "Is required"]);
    await rendered.enter(inputs()[0], "Ada");
    expect(dialog()?.querySelector('[data-telo-part="field-error"]')).toBeNull();
  });

  it("judges the record its inputs make against the mutation's schema before sending it, naming a property they leave empty in the dialog", async () => {
    const revision = { ...bound, revision: { root: "query", path: ["revision"] } };
    rendered = await show([prompted({ inputs: { ...revision, ...asked } })]);
    await rendered.click(rendered.part("button"));
    await rendered.enter(inputs()[0], "Ada");
    await confirm(rendered);
    expect(rendered.sent).toEqual([]);
    expect(dialog()?.querySelector('[data-telo-part="error-code"]')?.textContent).toBe("ERR_UI_MUTATION_INPUT_INVALID");
    expect(dialog()?.querySelector('[data-telo-part="error-message"]')?.textContent).toBe("revision: Is required");
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
    rendered = await show([buttonOf(call("/api/plans/p7/decisions", "Approve", { ...decisionSchema, required: ["id"] }, { inputs: bound }))]);
    rendered.answer("/api/plans/p7/decisions", () => new Promise<Response>((resolve) => (answer = resolve)));
    await rendered.click(rendered.part("button"));
    expect([(rendered.part("button") as HTMLButtonElement).disabled, rendered.part("button").getAttribute("data-state")]).toEqual([true, "submitting"]);
    await rendered.click(rendered.part("button"));
    answer(json({ type: "about:blank", title: "Conflict", status: 409, code: "ERR_REVISION_SUPERSEDED", detail: "A newer revision was submitted." }, 409));
    await rendered.settle();
    expect(rendered.sent).toHaveLength(1);
    expect(rendered.part("button").nextElementSibling?.getAttribute("data-telo-part")).toBe("mutation-failure");
    expect([...rendered.part("mutation-failure").querySelectorAll('[data-telo-part="value"]')].map((each) => each.textContent)).toEqual([
      "ERR_REVISION_SUPERSEDED",
      "A newer revision was submitted.",
    ]);
  });
});
