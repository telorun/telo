// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TYPING_PAUSE } from "../src/browser/typing-pause.js";
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { display, filtersNode, listingNode } from "./spec-nodes.js";
import { wireText } from "./ui-texts.js";

let rendered: Rendered | undefined;
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => rendered?.unmount());

const row = (...path: string[]) => ({ root: "row", path });
const postSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string", title: "Title" },
    body: { type: "string", title: "Body" },
    authorId: { type: "integer", title: "Author" },
    status: { type: "string", title: "Status", enum: ["draft", "review", "published"] },
    publishedOn: { type: "string", title: "Published on", format: "date" },
  },
};
const posts = [
  { id: 1, title: "Backups that restore", body: "Test the restore first.", authorId: 2, status: "review", publishedOn: "2026-11-02" },
  { id: 2, title: "How we plan a sprint", body: "We start from the backlog.", authorId: 1, status: "published", publishedOn: "2026-10-05" },
  { id: 3, title: "Writing release notes", body: "Lead with what changed and go back to it last.", authorId: 1, status: "draft" },
];
const authors = [
  { id: 1, name: "Sofia Rossi", email: "sofia@northwind.example" },
  { id: 2, name: "Maya Harris", email: "maya@northwind.example" },
];
const authorsSource = {
  type: "collection",
  schema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, email: { type: "string" } } },
  value: row("id"),
  label: row("name"),
  hint: row("email"),
  basePath: "/api/authors",
  filters: {},
  pageSize: 25,
  search: { property: "name", operator: "contains" },
};
const statusLabels = [
  { value: "draft", label: "Draft" },
  { value: "review", label: "In review" },
  { value: "published", label: "Published" },
];
const field = (property: keyof typeof postSchema.properties, operator: string, more: Record<string, unknown> = {}) => ({
  property,
  operator,
  label: (postSchema.properties[property] as { title?: string }).title ?? property,
  labels: property === "status" ? statusLabels : [],
  schema: postSchema.properties[property],
  pinned: false,
  control: "auto",
  values: "all",
  ...more,
});
const fields = (author: Record<string, unknown> = {}) => [
  field("title", "contains"),
  field("authorId", "eq", { options: authorsSource, ...author }),
  field("status", "in"),
  field("publishedOn", "gte"),
  field("publishedOn", "lte"),
];
const postsListing = listingNode({
  schema: postSchema,
  basePath: "/api/posts",
  pageSize: 25,
  rowStyle: undefined,
  create: undefined,
  edit: undefined,
  delete: false,
  sort: { sortable: [], initial: null },
  columns: [{ header: "Title", value: row("title"), present: { type: "string" }, labels: [] }],
});
const searchBox = { type: "searchBox", placeholder: wireText("Search posts") };
const state = { key: "posts", address: true, store: { type: "memory" }, fields: ["search", ...Object.keys(postSchema.properties)] };
const bar = (more: Record<string, unknown> = {}) =>
  filtersNode(postsListing as never, {
    basePath: "/api/posts",
    search: { pinned: false, default: null },
    fields: fields(),
    placement: searchBox,
    state,
    ...more,
  });
const show = (node: unknown, path = "/") =>
  render({
    path,
    loadModule: loadFixtureComponents,
    collections: { "/api/posts": posts, "/api/authors": authors },
    pages: { "/": { title: "Posts", children: [node as never] } },
  });

const input = (r: Rendered) => r.part("search-input") as HTMLInputElement;
const items = (r: Rendered) => r.parts("combobox-item").map((item) => item.textContent);
const chips = (r: Rendered) => r.parts("search-token").map((chip) => chip.textContent);
const highlighted = (r: Rendered) => r.parts("combobox-item").find((item) => item.hasAttribute("data-highlighted"))?.textContent;
const listing = /^GET \/api\/posts\?limit=25&?/;
const asked = (r: Rendered) => r.requests.filter((request) => listing.test(request)).at(-1)!.replace(listing, "");
const type = async (r: Rendered, typed: string) => {
  await r.focus(input(r));
  await r.enter(input(r), typed);
};
const key = async (r: Rendered, name: string) => {
  await act(async () => {
    input(r).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await r.settle();
  expect(document.activeElement).toBe(input(r));
};
/** Let typed text rest, so a read that waits for the typing pause has been sent. */
const rest = async (r: Rendered) => {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, TYPING_PAUSE + 50)));
  await r.settle();
};
const itemNamed = (r: Rendered, label: string) => r.parts("combobox-item").find((item) => item.textContent === label)!;

describe("a filter bar drawn as a search box", () => {
  it("offers the search, then a filter per field the text can be a value for, and sends what is picked", async () => {
    rendered = await show(bar());
    await type(rendered, "back");
    expect(rendered.part("search-input").getAttribute("placeholder")).toBe("Search posts");
    expect(items(rendered)).toEqual(["Search: back", "Title contains back"]);
    await rendered.click(itemNamed(rendered, "Search: back"));
    expect([asked(rendered), chips(rendered), input(rendered).value]).toEqual(["search=back", ["Search: back"], ""]);
    await type(rendered, "back");
    await rendered.click(itemNamed(rendered, "Title contains back"));
    expect([asked(rendered), chips(rendered)]).toEqual(["search=back&title.contains=back", ["Search: back", "Title contains back"]]);
  });

  it("offers the presets, then the fields by title, for an empty box, and starts a token for a field picked", async () => {
    rendered = await show(bar({ presets: [{ label: "Everything", values: [] }] }));
    await rendered.focus(input(rendered));
    await rendered.click(input(rendered));
    expect(rendered.parts("combobox-group").map((group) => group.textContent)).toEqual([
      "PresetsEverything",
      "FiltersTitleAuthorStatusPublished on fromPublished on to",
    ]);
    await rendered.click(itemNamed(rendered, "Status"));
    expect([input(rendered).value, items(rendered)]).toEqual(["status:", ["Draft", "In review", "Published"]]);
    expect(document.activeElement).toBe(input(rendered));
  });

  it("offers the fields whose title starts with the text after the filters it can be a value for", async () => {
    rendered = await show(bar());
    await type(rendered, "pub");
    expect(items(rendered)).toEqual(["Search: pub", "Title contains pub", "Published on from", "Published on to"]);
  });

  it("moves the highlight with the arrows, takes it on Enter, and closes on Escape, the focus never leaving the box", async () => {
    rendered = await show(bar());
    await type(rendered, "back");
    expect(highlighted(rendered)).toBe("Search: back");
    await key(rendered, "ArrowDown");
    expect(highlighted(rendered)).toBe("Title contains back");
    expect(input(rendered).getAttribute("aria-activedescendant")).toBe(itemNamed(rendered, "Title contains back").id);
    await key(rendered, "ArrowDown");
    expect(highlighted(rendered)).toBe("Search: back");
    await key(rendered, "ArrowUp");
    await key(rendered, "Enter");
    expect([asked(rendered), chips(rendered)]).toEqual(["title.contains=back", ["Title contains back"]]);
    await type(rendered, "re");
    expect(rendered.parts("combobox-item").length).toBeGreaterThan(0);
    await rendered.escape();
    expect([rendered.parts("combobox-item"), input(rendered).value, document.activeElement]).toEqual([[], "re", input(rendered)]);
  });

  it("removes the last chip of any kind on Backspace in an empty box: a filter from the request and the address, the search from the address", async () => {
    rendered = await show(bar(), "/?_telo.f.posts.search=back&_telo.f.posts.authorId=1");
    expect([asked(rendered), chips(rendered)]).toEqual(["search=back&authorId=1", ["Search: back", "Author is Sofia Rossi"]]);
    await rendered.focus(input(rendered));
    await key(rendered, "Backspace");
    expect([asked(rendered), window.location.search, chips(rendered)]).toEqual(["search=back", "?_telo.f.posts.search=back", ["Search: back"]]);
    await key(rendered, "Backspace");
    expect([asked(rendered), window.location.search, chips(rendered)]).toEqual(["", "", []]);
  });

  it("takes Backspace in a box with text as text", async () => {
    rendered = await show(bar(), "/?_telo.f.posts.search=back");
    await type(rendered, "x");
    await key(rendered, "Backspace");
    expect(chips(rendered)).toEqual(["Search: back"]);
  });

  it("removes a chip with its own button", async () => {
    rendered = await show(bar(), "/?_telo.f.posts.search=back&_telo.f.posts.status.in=draft");
    expect(chips(rendered)).toEqual(["Search: back", "Status one of Draft"]);
    await rendered.click(rendered.parts("search-token-remove")[1]);
    expect([asked(rendered), chips(rendered)]).toEqual(["search=back", ["Search: back"]]);
  });

  it.each([
    ["status:draft,In review", "status.in=draft&status.in=review", ["Status one of Draft, In review"]],
    ["publishedOn>=2026-11-01", "publishedOn.gte=2026-11-01", ["Published on from 2026-11-01"]],
    ["TITLE:a, b", "title.contains=a%2C+b", ["Title contains a, b"]],
  ])("commits the token '%s' as one chip on Enter", async (typed, request, expected) => {
    rendered = await show(bar());
    await type(rendered, typed);
    expect(highlighted(rendered)).toBe(expected[0]);
    await key(rendered, "Enter");
    expect([asked(rendered), chips(rendered), input(rendered).value]).toEqual([request, expected, ""]);
  });

  it("replaces what the filter held when a token is committed", async () => {
    rendered = await show(bar(), "/?_telo.f.posts.status.in=draft");
    await type(rendered, "status:review");
    await key(rendered, "Enter");
    expect([asked(rendered), chips(rendered)]).toEqual(["status.in=review", ["Status one of In review"]]);
  });

  it("marks an invalid token with its reason and sends nothing for it", async () => {
    rendered = await show(bar());
    const before = rendered.requests.length;
    for (const [typed, reason] of [
      ["colour:red", "unknown-property"],
      ["title>b", "operator-unsupported"],
      ["status:archived", "value-not-listed"],
      ["publishedOn>=yesterday", "value-invalid"],
    ]) {
      await type(rendered, typed);
      expect([rendered.part("search-box").getAttribute("data-reason"), input(rendered).getAttribute("aria-invalid"), items(rendered)]).toEqual([reason, "true", []]);
      await key(rendered, "Enter");
      expect([chips(rendered), input(rendered).value]).toEqual([[], typed]);
    }
    expect(rendered.requests.length).toBe(before);
    await type(rendered, "status:dr");
    expect([rendered.part("search-box").getAttribute("data-reason"), items(rendered)]).toEqual([null, ["Draft"]]);
  });

  it("opens a field's values with the held ones checked, and keeps the list open as an `in` value is picked", async () => {
    rendered = await show(bar(), "/?_telo.f.posts.status.in=draft");
    await type(rendered, "status:");
    expect(rendered.parts("combobox-item").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Draft", "true"],
      ["In review", "false"],
      ["Published", "false"],
    ]);
    await rendered.click(itemNamed(rendered, "In review"));
    expect([asked(rendered), input(rendered).value, rendered.parts("combobox-item").map((item) => item.getAttribute("aria-checked"))]).toEqual([
      "status.in=draft&status.in=review",
      "status:",
      ["true", "true", "false"],
    ]);
    await rendered.click(itemNamed(rendered, "Draft"));
    await rendered.click(itemNamed(rendered, "In review"));
    expect([asked(rendered), chips(rendered)]).toEqual(["", []]);
  });

  it("offers the records of a relation by name through its search, and filters by the one picked", async () => {
    rendered = await show(bar());
    await type(rendered, "authorId:sof");
    await rest(rendered);
    expect(items(rendered)).toEqual(["Sofia Rossisofia@northwind.example"]);
    expect(rendered.requests.filter((request) => request.startsWith("GET /api/authors")).at(-1)).toBe("GET /api/authors?limit=25&name.contains=sof");
    await key(rendered, "Enter");
    expect([asked(rendered), chips(rendered)]).toEqual(["authorId=1", ["Author is Sofia Rossi"]]);
  });

  it("offers only the records that occur, with counts honouring the search, under `values: present`", async () => {
    rendered = await show(bar({ fields: fields({ values: "present" }) }));
    await type(rendered, "authorId:");
    expect(items(rendered)).toEqual(["Sofia Rossi (2)", "Maya Harris (1)"]);
    await type(rendered, "backups");
    await key(rendered, "Enter");
    await type(rendered, "authorId:");
    expect(rendered.requests.filter((request) => request.startsWith("GET /api/posts?limit=25&facet")).at(-1)).toBe("GET /api/posts?limit=25&facet=authorId&search=backups");
    expect(items(rendered)).toEqual(["Maya Harris (1)"]);
  });

  it("waits for the Apply button beside the box under `apply: button`", async () => {
    rendered = await show(bar({ apply: "button" }));
    const before = rendered.requests.length;
    await type(rendered, "back");
    await key(rendered, "Enter");
    expect([chips(rendered), rendered.requests.length, rendered.part("filters").getAttribute("data-pending")]).toEqual([["Search: back"], before, "true"]);
    expect(rendered.part("search-box").parentElement).toBe(rendered.part("filters-apply").parentElement);
    await rendered.click(rendered.part("filters-apply"));
    expect(asked(rendered)).toBe("search=back");
  });

  it("holds the state an address names whichever placement draws the bar", async () => {
    const path = "/?_telo.f.posts.search=back&_telo.f.posts.status.in=draft";
    rendered = await show(bar(), path);
    const boxed = asked(rendered);
    rendered.unmount();
    rendered = await show(bar({ placement: { type: "aside", ...display, side: "start" } }), path);
    expect([asked(rendered), boxed]).toEqual(["search=back&status.in=draft", "search=back&status.in=draft"]);
  });
  describe("past the first page of suggestions", () => {
    const many = ["Ada", "Ben", "Cleo", "Dara", "Eve"].map((name, index) => ({ id: index + 1, name, email: `${name}@northwind.example` }));
    const manyPosts = many.map((author) => ({ id: author.id, title: `Post ${author.id}`, authorId: author.id, status: "draft" }));
    const small = { ...authorsSource, pageSize: 2 };
    const open = (author: Record<string, unknown>) =>
      render({
        path: "/",
        loadModule: loadFixtureComponents,
        collections: { "/api/posts": manyPosts, "/api/authors": many },
        pages: { "/": { title: "Posts", children: [bar({ fields: fields({ options: small, ...author }) }) as never] } },
      });
    const more = (r: Rendered) => r.parts("combobox-item").find((item) => item.textContent === "More");

    it("reads on by next for a present value typed past the first facet page", async () => {
      rendered = await open({ values: "present" });
      await type(rendered, "authorId:Eve");
      expect(items(rendered)).toEqual(["More"]);
      while (more(rendered)) await rendered.click(more(rendered)!);
      expect(items(rendered)).toEqual(["Eve (1)"]);
    });

    it("sends the typed text to a relation's search, and reads on for a relation with none", async () => {
      rendered = await open({});
      await type(rendered, "authorId:Eve");
      await rest(rendered);
      expect(items(rendered)).toEqual(["EveEve@northwind.example"]);
      rendered.unmount();
      rendered = await open({ options: { ...small, search: undefined } });
      await type(rendered, "authorId:Eve");
      expect(items(rendered)).toEqual(["More"]);
      while (more(rendered)) await rendered.click(more(rendered)!);
      expect(items(rendered)).toEqual(["EveEve@northwind.example"]);
    });
  });
});
