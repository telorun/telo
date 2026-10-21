// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Page, type Rendered } from "./harness.js";
import { actionNode, dataNode, operation, reportSchema, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reads = (r: Rendered, path = "/api/account") => r.requests.filter((request) => request.startsWith(`GET ${path}`)).length;
const shownTexts = (r: Rendered, part: string) =>
  r.parts(part).filter((element) => element.closest('[style*="display: none"]') === null).map((element) => element.textContent);

/** A server whose answers the test hands out one at a time. */
function deferred() {
  const waiting: ((response: Response) => void)[] = [];
  return {
    respond: () => new Promise<Response>((resolve) => waiting.push(resolve)),
    pending: () => waiting.length,
    async release(r: Rendered, response: Response) {
      const next = waiting.shift();
      if (!next) throw new Error("no read is waiting");
      await act(async () => next(response));
      await r.settle();
    },
  };
}

const page = (...children: Page["children"]) => ({ "/": { title: "Account", children } });

describe("a reader", () => {
  it("draws its loading tree before the first answer, then the branch its conditions select", async () => {
    const server = deferred();
    rendered = await render({ path: "/", answers: { "/api/account": server.respond }, pages: page(dataNode()) });
    expect(rendered.part("data").getAttribute("data-state")).toBe("loading");
    expect(shownTexts(rendered, "text")).toEqual(["Loading…"]);
    await server.release(rendered, json({ authorized: false }));
    expect(rendered.part("data").getAttribute("data-state")).toBe("idle");
    expect(shownTexts(rendered, "text")).toEqual(["Sign in first."]);
    expect(shownTexts(rendered, "value")).toEqual([]);
  });

  it("reads again when a request inside its content answers 401, and draws what the new answer selects", async () => {
    let authorized = true;
    rendered = await render({
      path: "/",
      collections: { "/api/todos": todos },
      answers: {
        "/api/account": () => json({ authorized, email: "ada@example.com", files: [] }),
        "/api/todos/archive": () => {
          authorized = false;
          return json({ error: "Unauthorized" }, 401);
        },
      },
      pages: page(
        dataNode({
          reloadOn: ["unauthorized"],
          content: {
            type: "stack",
            children: [
              { type: "text", text: "Sign in first.", shown: { at: { root: "data", path: ["authorized"] }, matches: { const: false } } },
              {
                ...tableNode({ columns: [], rowActions: [{ action: operation("/api/todos/archive", "Archive", { type: "object", properties: { id: { type: "integer" } } }), inputs: { id: { root: "row", path: ["id"] } } }] }),
                shown: { at: { root: "data", path: ["authorized"] }, matches: { const: true } },
              },
            ],
          },
        }),
      ),
    });
    expect(reads(rendered)).toBe(1);
    await rendered.click(rendered.parts("row-action")[0]);
    expect(reads(rendered)).toBe(2);
    expect(shownTexts(rendered, "text")).toEqual(["Sign in first."]);
    expect(shownTexts(rendered, "table")).toEqual([]);
  });

  it("never reads again for its own refused read, and draws its failure tree over the error", async () => {
    rendered = await render({
      path: "/",
      answers: { "/api/account": () => json({ code: "SIGNED_OUT", message: "Your session has ended." }, 401) },
      pages: page(dataNode({ reloadOn: ["unauthorized", "focus"] })),
    });
    expect(reads(rendered)).toBe(1);
    expect(rendered.part("data").getAttribute("data-state")).toBe("error");
    expect(shownTexts(rendered, "value")).toEqual(["SIGNED_OUT", "Your session has ended."]);
  });

  it("refuses an answer that is no object of its model, as ERR_UI_RESPONSE_INVALID", async () => {
    rendered = await render({ path: "/", answers: { "/api/account": () => json({ email: "no flag" }) }, pages: page(dataNode()) });
    expect(shownTexts(rendered, "value")[0]).toBe("ERR_UI_RESPONSE_INVALID");
  });

  it("keeps its content mounted through a reload, and what a hidden form holds", async () => {
    const server = deferred();
    rendered = await render({
      path: "/",
      answers: { "/api/account": server.respond },
      pages: page(
        dataNode({
          reloadOn: ["focus"],
          content: {
            ...actionNode({ result: undefined }),
            shown: { at: { root: "data", path: ["authorized"] }, matches: { const: true } },
          },
        }),
      ),
    });
    await server.release(rendered, json({ authorized: true }));
    await rendered.enter(rendered.parts("input")[0], "2026-09");
    // Reloading: the content stays drawn while the read is in flight.
    await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    expect(shownTexts(rendered, "text")).toEqual([]);
    await server.release(rendered, json({ authorized: false }));
    expect(shownTexts(rendered, "submit")).toEqual([]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    await server.release(rendered, json({ authorized: true }));
    expect((rendered.parts("input")[0] as HTMLInputElement).value).toBe("2026-09");
  });

  it("reads exactly once more for any number of triggers during a read", async () => {
    const server = deferred();
    rendered = await render({ path: "/", answers: { "/api/account": server.respond }, pages: page(dataNode({ reloadOn: ["focus"] })) });
    await server.release(rendered, json({ authorized: true }));
    for (let i = 0; i < 3; i++) await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    expect(reads(rendered)).toBe(2);
    await server.release(rendered, json({ authorized: true }));
    expect(reads(rendered)).toBe(3);
    await server.release(rendered, json({ authorized: true }));
    expect(reads(rendered)).toBe(3);
    expect(server.pending()).toBe(0);
  });

  it("never draws an answer to an address it no longer reads", async () => {
    const server = deferred();
    rendered = await render({
      path: "/?signin=denied",
      answers: { "/api/account": server.respond },
      pages: page(
        { type: "link", text: "Expired", href: "/?signin=expired" },
        dataNode({
          query: { signin: { type: "string" } },
          source: { path: "/api/account", params: { signin: { root: "query", path: ["signin"] } } },
          content: { type: "value", value: { root: "data", path: ["email"] }, present: { type: "string" } },
        }),
      ),
    });
    expect(rendered.requests.at(-1)).toBe("GET /api/account?signin=denied");
    await rendered.click(rendered.part("link"));
    await server.release(rendered, json({ authorized: true, email: "denied@example.com" }));
    expect(shownTexts(rendered, "value")).toEqual([]);
    expect(rendered.requests.at(-1)).toBe("GET /api/account?signin=expired");
    await server.release(rendered, json({ authorized: true, email: "expired@example.com" }));
    expect(shownTexts(rendered, "value")).toEqual(["expired@example.com"]);
  });

  it("reads nothing while hidden, and once on show for what asked meanwhile", async () => {
    let authorized = false;
    rendered = await render({
      path: "/",
      answers: {
        "/api/account": () => json({ authorized }),
        "/api/inner": () => json({ authorized: true, email: "inner@example.com" }),
      },
      pages: page(
        dataNode({
          reloadOn: ["focus"],
          content: {
            ...dataNode({ source: { path: "/api/inner", params: {} }, reloadOn: ["focus"] }),
            shown: { at: { root: "data", path: ["authorized"] }, matches: { const: true } },
          },
        }),
      ),
    });
    expect(reads(rendered, "/api/inner")).toBe(0);
    authorized = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    expect(reads(rendered, "/api/inner")).toBe(1);
    // Hidden again: a trigger is remembered, and read once on show.
    authorized = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    const hiddenReads = reads(rendered, "/api/inner");
    authorized = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await rendered.settle();
    expect(reads(rendered, "/api/inner")).toBe(hiddenReads + 1);
  });
});

describe("a field's condition", () => {
  const gated = () =>
    actionNode({
      result: undefined,
      fields: [
        { type: "input", control: "auto", property: "copies", label: "Copies" },
        { type: "input", control: "auto", property: "month", label: "Month", shown: { at: { root: "values", path: ["copies"] }, matches: { minimum: 2 } } },
      ],
    });

  it("draws the field only while it holds over the values, and keeps what it holds", async () => {
    rendered = await render({ path: "/", answers: { "/api/reports": () => json({}) }, pages: page(gated()) });
    expect(rendered.parts("label").map((label) => label.textContent)).toEqual(["Copies"]);
    await rendered.enter(rendered.parts("input")[0], "2");
    await rendered.enter(rendered.parts("input")[1], "2026-09");
    await rendered.enter(rendered.parts("input")[0], "1");
    expect(rendered.parts("label").map((label) => label.textContent)).toEqual(["Copies"]);
    await rendered.enter(rendered.parts("input")[0], "3");
    expect((rendered.parts("input")[1] as HTMLInputElement).value).toBe("2026-09");
  });

  it("leaves a hidden field's value unsent, and a property it requires blocks the submission", async () => {
    rendered = await render({ path: "/", answers: { "/api/reports": () => json({}) }, pages: page(gated()) });
    await rendered.enter(rendered.parts("input")[0], "1");
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("form-error").textContent).toBe("Month: Is required");
    expect(rendered.sent).toEqual([]);
    expect(reportSchema.required).toContain("month");
  });

  it("sends what the shown fields hold and nothing a hidden one does", async () => {
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => json({}) },
      pages: page(
        actionNode({
          result: undefined,
          fields: [
            { type: "input", control: "auto", property: "month", label: "Month" },
            { type: "input", control: "auto", property: "copies", label: "Copies", shown: { at: { root: "values", path: ["month"] }, matches: { const: "2026-09" } } },
          ],
        }),
      ),
    });
    await rendered.enter(rendered.parts("input")[0], "2026-09");
    await rendered.enter(rendered.parts("input")[1], "3");
    await rendered.enter(rendered.parts("input")[0], "2026-10");
    await rendered.click(rendered.part("submit"));
    expect(rendered.sent.map((each) => each.body)).toEqual([{ month: "2026-10" }]);
  });
});

describe("an action's enabled condition", () => {
  it("disables the button and says why while it does not hold", async () => {
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => json({}) },
      pages: page(actionNode({ result: undefined, enabled: { at: { root: "values", path: ["month"] }, matches: { minLength: 7 }, disabledText: "Choose a month first." } })),
    });
    expect((rendered.part("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(rendered.part("disabled-text").textContent).toBe("Choose a month first.");
    await rendered.enter(rendered.parts("input")[0], "2026-09");
    expect((rendered.part("submit") as HTMLButtonElement).disabled).toBe(false);
    expect(rendered.parts("disabled-text")).toEqual([]);
  });

  it("offers a list's row actions over its rows, draws an answer in place of the button, and drops it with the answer it was drawn in", async () => {
    const remove = operation("/api/files/remove", "Remove", { type: "object", required: ["name"], properties: { name: { type: "string" } } }, {
      result: { type: "text", text: "Removed" },
      onSuccess: { refreshes: ["/api/account"] },
    });
    const files = [{ name: "a.pdf" }, { name: "b.pdf" }];
    rendered = await render({
      path: "/",
      answers: { "/api/account": () => json({ authorized: true, files }), "/api/files/remove": () => new Response(null, { status: 204 }) },
      pages: page(
        dataNode({
          content: {
            type: "list",
            rows: { root: "data", path: ["files"] },
            columns: [{ header: "Name", value: { root: "row", path: ["name"] }, present: { type: "string" } }],
            rowActions: [{ action: remove, inputs: { name: { root: "row", path: ["name"] } }, enabled: { at: { root: "data", path: ["authorized"] }, matches: { const: true }, disabledText: "Sign in first." } }],
          },
        }),
      ),
    });
    expect(rendered.parts("row-action").map((button) => button.textContent)).toEqual(["Remove", "Remove"]);
    const before = reads(rendered);
    await rendered.click(rendered.parts("row-action")[1]);
    expect(rendered.sent.map((each) => [each.request, each.body])).toEqual([["POST /api/files/remove", { name: "b.pdf" }]]);
    // The success refreshes the reader; its new answer is a new list, so the
    // row's answer goes with the old one.
    expect(reads(rendered)).toBe(before + 1);
    expect(rendered.parts("row-answer")).toEqual([]);
    expect(rendered.parts("row-action")).toHaveLength(2);
  });

  it("keeps a list row's answer while the list's answer stands", async () => {
    const remove = operation("/api/files/remove", "Remove", { type: "object", properties: { name: { type: "string" } } }, { result: { type: "text", text: "Removed" } });
    rendered = await render({
      path: "/",
      answers: { "/api/account": () => json({ authorized: true, files: [{ name: "a.pdf" }] }), "/api/files/remove": () => new Response(null, { status: 204 }) },
      pages: page(
        dataNode({
          content: {
            type: "list",
            rows: { root: "data", path: ["files"] },
            columns: [{ header: "Name", value: { root: "row", path: ["name"] } }],
            rowActions: [{ action: remove, inputs: { name: { root: "row", path: ["name"] } } }],
          },
        }),
      ),
    });
    await rendered.click(rendered.part("row-action"));
    expect(shownTexts(rendered, "row-answer")).toEqual(["Removed"]);
    expect(rendered.parts("row-action")).toEqual([]);
  });
});
