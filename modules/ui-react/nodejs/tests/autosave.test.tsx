// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";
import { address, buttonOf, call, defaultFailure, formNode, literals, memoryState, mutationSpec, navigateTo } from "./spec-nodes.js";
import { wireText } from "./ui-texts.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const values = (...path: string[]) => ({ root: "values", path });
const params = (...path: string[]) => ({ root: "params", path });
const input = (...path: string[]) => ({ root: "input", path });

const draftSchema = { type: "object", additionalProperties: false, properties: { title: { type: "string", title: "Title" }, body: { type: "string", title: "Body" } } };
const saveSchema = { type: "object", required: ["id"], properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } } };
const publishSchema = { type: "object", required: ["id", "title", "body"], properties: { id: { type: "string" }, title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 } } };
const inputs = { id: params("id"), title: values("title"), body: values("body") };
const unavailable = () => json({ type: "about:blank", title: "Service Unavailable", status: 503, detail: "The drafts store is down.", code: "ERR_DRAFTS_UNAVAILABLE" }, 503);

/** The draft editor: the draft read by the page's `id`, a form starting from it that saves with a `PUT` and publishes with a `POST`. */
const draftForm = (autosave: Record<string, unknown> = {}, form: Record<string, unknown> = {}, mutation: Record<string, unknown> = {}) =>
  formNode("/unused", {
    id: "Test/draft",
    schema: draftSchema,
    record: null,
    initialValues: { root: "data", path: [] },
    fields: [
      { type: "input", property: "title", label: "Title", control: "auto" },
      { type: "input", property: "body", label: "Body", control: "auto" },
    ],
    state: memoryState(["title", "body"]),
    autosave: {
      mutation: mutationSpec("/api/posts/{id}", saveSchema, { method: "PUT", url: address("/api/posts/{id}", { id: input("id") }), ...mutation }),
      inputs,
      debounce: 0,
      result: { type: "text", text: "Saved" },
      failure: defaultFailure,
      ...autosave,
    },
    ...form,
  });

const draftQuery = (form: unknown) => ({
  type: "query",
  query: { id: "draft", schema: draftSchema, method: "GET", url: address("/api/posts/{id}", { id: params("id") }), input: null, query: {}, form: null, reloadOn: [] },
  content: [form],
  loading: [],
  failure: [defaultFailure],
  fill: false,
});

interface Server {
  /** Every write sent, in order. */
  writes: { method: string; path: string; body: unknown }[];
  /** How many times the draft was read. */
  reads: () => number;
  /** Answer the oldest write waiting, with `respond`'s answer. */
  answer(respond?: () => Response): Promise<void>;
  /** Answer writes as they arrive; `hold` makes each wait for `answer`. */
  hold: boolean;
  /** How a write is answered. */
  respond: () => Response;
  /** How a read of the draft is answered. */
  read: () => Response | Promise<Response>;
}

async function editor(form = draftForm(), more: Record<string, unknown> = {}, extra: unknown[] = []) {
  const waiting: ((response: Response) => void)[] = [];
  let reads = 0;
  const server: Server = {
    writes: [],
    reads: () => reads,
    hold: false,
    respond: () => new Response(null, { status: 204 }),
    read: () => json({ title: "First post", body: "Hello" }),
    async answer(respond) {
      const next = waiting.shift();
      if (!next) throw new Error("no write is waiting");
      next((respond ?? server.respond)());
      await rendered!.settle();
    },
  };
  rendered = await render({
    path: "/posts/1",
    answers: {
      "/api/posts": ({ method, url, init }: { method: string; url: URL; init?: RequestInit }) => {
        if (method === "GET") {
          reads += 1;
          return server.read();
        }
        server.writes.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
        if (!server.hold) return server.respond();
        return new Promise<Response>((resolve) => waiting.push(resolve));
      },
    },
    pages: {
      "/posts/{id}": { title: "Edit post", children: [draftQuery(form), ...extra] },
      "/elsewhere": { title: "Elsewhere", children: [] },
    },
    ...more,
  } as never);
  return server;
}

const title = (r: Rendered) => r.parts("input")[0];
const shape = (server: Server) => server.writes.map((write) => [write.method, write.path, write.body]);

describe("a form's autosave", () => {
  it("sends nothing at start, then the record its inputs bind as each value settles", async () => {
    const server = await editor();
    expect([server.writes, server.reads()]).toEqual([[], 1]);
    await rendered!.enter(title(rendered!), "Second post");
    expect(shape(server)).toEqual([["PUT", "/api/posts/1", { id: "1", title: "Second post", body: "Hello" }]]);
  });

  it("is awaited with its last answer still drawn, the region busy and the saving text beside it", async () => {
    const server = await editor();
    server.hold = true;
    await rendered!.enter(title(rendered!), "Second");
    expect([rendered!.part("saving").textContent, rendered!.part("saving").parentElement?.getAttribute("aria-busy"), rendered!.part("form").getAttribute("data-state")]).toEqual(["Saving…", "true", "submitting"]);
    await server.answer();
    expect([rendered!.parts("saving"), rendered!.part("mutation-result").textContent, rendered!.part("form").getAttribute("data-state")]).toEqual([[], "Saved", "idle"]);
    await rendered!.enter(title(rendered!), "Third");
    expect([rendered!.part("mutation-result").textContent, rendered!.parts("saving").length]).toEqual(["Saved", 1]);
    await server.answer();
  });

  it.each(["parallel", "serial"])("sends two edits made during a %s write as exactly one more write, of the newest values", async (concurrency) => {
    const server = await editor(draftForm({}, {}, { concurrency }));
    server.hold = true;
    await rendered!.enter(title(rendered!), "One");
    await rendered!.enter(title(rendered!), "Two");
    await rendered!.enter(title(rendered!), "Three");
    expect(shape(server)).toEqual([["PUT", "/api/posts/1", { id: "1", title: "One", body: "Hello" }]]);
    expect(rendered!.part("form").getAttribute("data-state")).toBe("submitting");
    await server.answer();
    await server.answer();
    expect(shape(server).map(([, , body]) => (body as { title: string }).title)).toEqual(["One", "Three"]);
    expect(rendered!.part("form").getAttribute("data-dirty")).toBe(null);
  });

  it("sends an edit reverted to the saved record while a write is in flight, once that write answers", async () => {
    const server = await editor();
    server.hold = true;
    await rendered!.enter(title(rendered!), "Second");
    await rendered!.enter(title(rendered!), "First post");
    expect(shape(server).map(([, , body]) => (body as { title: string }).title)).toEqual(["Second"]);
    await server.answer();
    await server.answer();
    expect([shape(server).map(([, , body]) => (body as { title: string }).title), rendered!.part("form").getAttribute("data-dirty")]).toEqual([["Second", "First post"], null]);
  });

  it("waits in a serial mutation's queue behind a button's press of it, one write at a time, coalesced", async () => {
    const shared = mutationSpec("/api/posts/{id}", saveSchema, { method: "PUT", url: address("/api/posts/{id}", { id: input("id") }), concurrency: "serial" });
    const button = buttonOf(call("/api/posts/{id}", "Rename", saveSchema, { ...shared, inputs: literals({ id: "1", title: "From the button" }) }));
    const server = await editor(draftForm({ mutation: shared }), {}, [button]);
    server.hold = true;
    await rendered!.click(rendered!.part("button"));
    await rendered!.enter(title(rendered!), "One");
    await rendered!.enter(title(rendered!), "Two");
    expect(shape(server).map(([, , body]) => (body as { title: string }).title)).toEqual(["From the button"]);
    await server.answer();
    expect(shape(server).map(([, , body]) => (body as { title: string }).title)).toEqual(["From the button", "Two"]);
    await server.answer();
    expect(server.writes).toHaveLength(2);
  });

  it("draws a failure and a retry button, sends nothing more until a change or the button, and stays unsaved until a write is acknowledged", async () => {
    const server = await editor();
    server.respond = unavailable;
    await rendered!.enter(title(rendered!), "Second");
    expect([rendered!.part("mutation-failure").textContent, rendered!.part("retry").textContent, rendered!.part("form").getAttribute("data-state")]).toEqual([
      "ERR_DRAFTS_UNAVAILABLE" + "The drafts store is down.",
      "Try again",
      "error",
    ]);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
    await rendered!.settle();
    expect([server.writes.length, rendered!.part("form").getAttribute("data-dirty")]).toEqual([1, "true"]);
    await rendered!.click(rendered!.part("retry"));
    expect(server.writes.length).toBe(2);
    server.respond = () => new Response(null, { status: 204 });
    await rendered!.enter(title(rendered!), "First post");
    expect([shape(server).at(-1)?.[2], rendered!.parts("retry"), rendered!.part("form").getAttribute("data-dirty")]).toEqual([{ id: "1", title: "First post", body: "Hello" }, [], null]);
  });

  it("sends what waits when the page becomes hidden", async () => {
    const server = await editor(draftForm({ debounce: 60000 }));
    await rendered!.enter(title(rendered!), "Second");
    expect(server.writes).toEqual([]);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await rendered!.settle();
    visibility.mockRestore();
    expect(shape(server)).toEqual([["PUT", "/api/posts/1", { id: "1", title: "Second", body: "Hello" }]]);
  });

  it("asks before a move while a write waits: keeping editing sends it as scheduled, and the next move asks nothing", async () => {
    const pauses: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number) => (ms === 1000 ? -pauses.push(run) : realSetTimeout(run, ms))) as typeof setTimeout);
    const server = await editor(draftForm({ debounce: 1000 }), {}, [{ type: "link", text: "Away", to: navigateTo(address("/elsewhere")) }]);
    await rendered!.enter(title(rendered!), "Second");
    // The browser asks before the document is left, too.
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await rendered!.click(rendered!.part("link"));
    expect([rendered!.part("surface-title").textContent, window.location.pathname]).toEqual(["Discard unsaved changes?", "/posts/1"]);
    await rendered!.click(rendered!.part("cancel"));
    expect(server.writes).toEqual([]);
    await act(async () => pauses[pauses.length - 1]());
    await rendered!.settle();
    expect(server.writes).toHaveLength(1);
    await rendered!.click(rendered!.part("link"));
    expect([document.querySelector('[data-surface="confirmation"]'), window.location.pathname]).toEqual([null, "/elsewhere"]);
  });

  it("drops what waits when the move is chosen", async () => {
    const server = await editor(draftForm({ debounce: 60000 }), {}, [{ type: "link", text: "Away", to: navigateTo(address("/elsewhere")) }]);
    await rendered!.enter(title(rendered!), "Second");
    await rendered!.click(rendered!.part("link"));
    const discard = rendered!.parts("submit").find((button) => button.closest('[data-surface="confirmation"]'))!;
    await rendered!.click(discard);
    expect([window.location.pathname, server.writes]).toEqual(["/elsewhere", []]);
  });

  it("keeps what was typed through the read of the draft each save announces", async () => {
    const server = await editor();
    let finish: (response: Response) => void = () => {};
    server.read = () => new Promise<Response>((resolve) => (finish = resolve));
    await rendered!.enter(title(rendered!), "Second");
    expect(server.reads()).toBe(2);
    await rendered!.enter(title(rendered!), "Second, longer");
    finish(json({ title: "Second", body: "Hello" }));
    await rendered!.settle();
    expect((title(rendered!) as HTMLInputElement).value).toBe("Second, longer");
  });

  it("is flushed and waited for by a submit, which is not sent when it fails", async () => {
    const publish = {
      mutation: mutationSpec("/api/posts/{id}/publish", publishSchema, { url: address("/api/posts/{id}/publish", { id: input("id") }) }),
      inputs,
      label: "Publish",
      failure: defaultFailure,
    };
    const server = await editor(draftForm({ debounce: 60000 }, { onSubmit: publish }));
    server.hold = true;
    await rendered!.enter(title(rendered!), "Second");
    await rendered!.click(rendered!.part("submit"));
    expect(shape(server).map(([method, path]) => `${method} ${path}`)).toEqual(["PUT /api/posts/1"]);
    await server.answer(unavailable);
    expect(shape(server).map(([method, path]) => `${method} ${path}`)).toEqual(["PUT /api/posts/1"]);
    await rendered!.click(rendered!.part("submit"));
    await server.answer(() => new Response(null, { status: 204 }));
    expect(shape(server).map(([method, path]) => `${method} ${path}`)).toEqual(["PUT /api/posts/1", "PUT /api/posts/1", "POST /api/posts/1/publish"]);
  });

  it("clears both writes' answers when a property clearAnswerOn lists changes", async () => {
    const publish = { mutation: mutationSpec("/api/posts/{id}/publish", publishSchema, { url: address("/api/posts/{id}/publish", { id: input("id") }) }), inputs, label: "Publish", result: { type: "text", text: "Published" }, failure: defaultFailure };
    await editor(draftForm({}, { onSubmit: publish, clearAnswerOn: ["title"], afterSubmit: "keep" }));
    await rendered!.enter(rendered!.parts("input")[1], "Hello there");
    await rendered!.click(rendered!.part("submit"));
    expect(rendered!.parts("mutation-result").map((each) => each.textContent)).toEqual(["Saved", "Published"]);
    await rendered!.enter(title(rendered!), "Renamed");
    expect(rendered!.parts("mutation-result").map((each) => each.textContent)).toEqual(["Saved"]);
  });

  it("says saving and retry in the wording an application's translations give", async () => {
    const server = await editor(undefined, { messages: { saving: wireText("Saving the draft…"), retry: wireText("Send again") } });
    server.hold = true;
    await rendered!.enter(title(rendered!), "Second");
    expect(rendered!.part("saving").textContent).toBe("Saving the draft…");
    await server.answer(unavailable);
    expect(rendered!.part("retry").textContent).toBe("Send again");
  });
});
