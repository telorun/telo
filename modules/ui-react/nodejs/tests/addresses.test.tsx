// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";
import { actionNode, address, dataNode, listingNode, operation } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (...path: string[]) => ({ root: "row", path });
const input = (...path: string[]) => ({ root: "input", path });

const conversations = [
  { id: "cnv_x", title: "Old name" },
  { id: "cnv_y", title: "Another" },
];
const conversationSchema = { type: "object", required: ["id"], properties: { id: { type: "string" }, title: { type: "string", title: "Title", minLength: 1 } } };

/** A listing over the conversations collection, one row action over `row`. */
const conversationList = (entry: Record<string, unknown>, columns: unknown[] = [{ header: "Title", value: row("title"), present: { type: "string" } }]) =>
  listingNode({
    schema: conversationSchema,
    basePath: "/api/chat/conversations",
    columns,
    rowStyle: undefined,
    create: undefined,
    edit: undefined,
    delete: false,
    sort: { sortable: [], initial: null },
    rowActions: [entry],
  });

const showConversations = (children: unknown[], answers: Parameters<typeof render>[0]["answers"] = {}) =>
  render({
    path: "/",
    answers,
    collections: { "/api/chat/conversations": conversations },
    pages: { "/": { title: "Chat", children: children as never } },
  });

const reads = (r: Rendered, path: string) => r.requests.filter((request) => request.startsWith(`GET ${path}`)).length;
const confirmation = () => document.querySelector<HTMLElement>('[data-surface="confirmation"]');
const confirming = () => confirmation()?.querySelector<HTMLButtonElement>('[data-telo-part="submit"]') as HTMLButtonElement;

describe("addresses", () => {
  it("draws a column's address from the row and moves within the application on it", async () => {
    const column = { header: "Title", value: row("title"), present: { type: "string" }, href: address("/", {}, { conversation: row("id") }) };
    rendered = await showConversations([listingNode({ schema: conversationSchema, basePath: "/api/chat/conversations", columns: [column], rowStyle: undefined, delete: false, create: undefined, edit: undefined, sort: { sortable: [], initial: null } })]);
    const links = rendered.parts("link");
    expect(links.map((link) => [link.getAttribute("href"), link.textContent, link.getAttribute("target")])).toEqual([
      ["/?conversation=cnv_x", "Old name", null],
      ["/?conversation=cnv_y", "Another", null],
    ]);
    expect(await rendered.click(links[0])).toBe(true);
    expect(window.location.search).toBe("?conversation=cnv_x");
    expect(rendered.reloads).toBe(0);
  });

  it("draws an address that does not resolve as text, and reports it once", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Home", children: [{ type: "link", text: "Open", href: address("/open/{id}", { id: { root: "query", path: ["id"] } }) }] as never } },
    });
    expect(rendered.parts("link")).toEqual([]);
    expect(rendered.part("text").textContent).toBe("Open");
    expect(report.mock.calls.filter(([line]) => String(line).startsWith("ERR_UI_ADDRESS_UNRESOLVED"))).toHaveLength(1);
  });

  it("keeps a node's state across a move to the page already shown", async () => {
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Reports", children: [actionNode(), { type: "link", text: "Again", href: address("/", {}, { page: { value: 2 } }) }] as never } },
    });
    await rendered.enter(rendered.part("input"), "2026-09");
    const pageReads = reads(rendered, "/_telo/ui/page");
    expect(await rendered.click(rendered.part("link"))).toBe(true);
    expect(window.location.search).toBe("?page=2");
    expect((rendered.part("input") as HTMLInputElement).value).toBe("2026-09");
    expect(reads(rendered, "/_telo/ui/page")).toBe(pageReads);
  });
});

describe("a reader over an address", () => {
  it("sends nothing for a source that does not resolve, and draws its failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = address("/api/reports/{id}", { id: { root: "query", path: ["id"] } });
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [dataNode({ source, query: { id: { type: "string" } } })] } } });
    expect(rendered.part("data").getAttribute("data-state")).toBe("error");
    expect(rendered.parts("value")[0].textContent).toBe("ERR_UI_ADDRESS_UNRESOLVED");
    expect(rendered.requests.filter((request) => request.includes("/api/reports"))).toEqual([]);
  });
});

describe("a request target", () => {
  const renaming = (method: "PATCH" | "DELETE") => ({
    action: operation(
      "/",
      "Rename",
      method === "PATCH" ? conversationSchema : { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      { request: { method, target: address("/api/chat/conversations/{id}", { id: input("id") }), consumed: ["id"] } },
    ),
    inputs: { id: row("id") },
    ...(method === "PATCH" ? { prompt: { fields: [{ type: "input", control: "auto", property: "title", label: "Title" }] } } : {}),
  });

  it("sends a rename without the consumed id, and reads the listing and the record at the path again", async () => {
    const item = vi.fn(({ method }: { method: string }) => (method === "PATCH" ? new Response(null, { status: 204 }) : json({ id: "cnv_x", title: "Old name" })));
    const reader = dataNode({
      schema: conversationSchema,
      source: address("/api/chat/conversations/cnv_x"),
      content: { type: "value", value: { root: "data", path: ["title"] }, present: { type: "string" } },
    });
    rendered = await showConversations([conversationList(renaming("PATCH")), reader], { "/api/chat/conversations/cnv_x": item });
    const listed = reads(rendered, "/api/chat/conversations?");
    const read = reads(rendered, "/api/chat/conversations/cnv_x");
    await rendered.click(rendered.parts("row-action")[0]);
    await rendered.enter((confirmation() as HTMLElement).querySelector('[data-telo-part="input"]') as Element, "New name");
    await rendered.click(confirming());
    expect(rendered.sent.map((each) => [each.request, each.contentType, each.body])).toEqual([
      ["PATCH /api/chat/conversations/cnv_x", "application/json", { title: "New name" }],
    ]);
    expect(reads(rendered, "/api/chat/conversations?")).toBe(listed + 1);
    expect(reads(rendered, "/api/chat/conversations/cnv_x")).toBe(read + 1);
  });

  it("sends a delete with no body and no content type", async () => {
    const calls: RequestInit[] = [];
    rendered = await showConversations([conversationList(renaming("DELETE"))], { "/api/chat/conversations/cnv_x": () => new Response(null, { status: 204 }) });
    const through = globalThis.fetch;
    globalThis.fetch = ((target: RequestInfo | URL, init?: RequestInit) => (init?.method === "DELETE" && calls.push(init), through(target, init))) as typeof fetch;
    await rendered.click(rendered.parts("row-action")[0]);
    expect(calls).toHaveLength(1);
    expect([calls[0].method, calls[0].body, new Headers(calls[0].headers).get("content-type")]).toEqual(["DELETE", undefined, null]);
  });
});

describe("a success with no body", () => {
  const send = async (node: ReturnType<typeof actionNode>) => {
    rendered = await render({
      path: "/",
      answers: { "/api/reports": () => new Response(null, { status: 204 }) },
      pages: { "/": { title: "Reports", children: [node] } },
    });
    await rendered.enter(rendered.part("input"), "2026-09");
    await rendered.click(rendered.part("submit"));
    return rendered;
  };

  it("is a success when nothing reads the answer", async () => {
    const r = await send(actionNode({ result: undefined }));
    expect(r.part("action").getAttribute("data-state")).toBe("idle");
    expect(r.parts("error")).toEqual([]);
  });

  it("is ERR_UI_RESPONSE_INVALID when the result tree reads it", async () => {
    const r = await send(actionNode());
    expect(r.part("action").getAttribute("data-state")).toBe("error");
    expect(r.part("action-failure").querySelector('[data-telo-part="value"]')?.textContent).toBe("ERR_UI_RESPONSE_INVALID");
  });
});

