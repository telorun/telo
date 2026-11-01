// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { CAPTIONS } from "../src/browser/filters.js";
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { component, filtersNode, listingNode } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const row = (...path: string[]) => ({ root: "row", path });
const postSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    text: { type: "string", title: "Post" },
    authorId: { type: "integer", title: "Author" },
    reviewerId: { type: ["integer", "null"], title: "Reviewer" },
  },
};
const posts = [
  { id: 1, text: "On engines", authorId: 1, reviewerId: 2 },
  { id: 2, text: "On compilers", authorId: 2, reviewerId: null },
  { id: 3, text: "On kernels", authorId: 1 },
];
const authors = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
  { id: 3, name: "Linus" },
];
const authorsSource = {
  type: "collection",
  schema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
  value: row("id"),
  label: row("name"),
  basePath: "/api/authors",
  filters: {},
  pageSize: 2,
};
const field = (property: keyof typeof postSchema.properties, operator: string, more: Record<string, unknown> = {}) => ({
  property,
  operator,
  label: (postSchema.properties[property] as { title?: string }).title ?? property,
  labels: [],
  schema: postSchema.properties[property],
  pinned: false,
  control: "auto",
  values: "all",
  ...more,
});
const postsListing = listingNode({
  schema: postSchema,
  basePath: "/api/posts",
  pageSize: 25,
  rowStyle: undefined,
  create: undefined,
  edit: undefined,
  delete: false,
  sort: [],
  columns: [{ header: "Post", value: row("text"), present: { type: "string" }, labels: [] }],
});
const bar = (fields: unknown[], content: unknown = postsListing) =>
  filtersNode(content as never, { basePath: "/api/posts", fields, state: { address: false, store: { type: "memory" }, fields: Object.keys(postSchema.properties) } });
const show = (children: unknown[]) =>
  render({ path: "/", loadModule: loadFixtureComponents, collections: { "/api/posts": posts, "/api/authors": authors }, pages: { "/": { title: "Posts", children: children as never } } });
const asked = (r: Rendered, start: string) => r.requests.filter((request) => request.startsWith(start));

describe("a filter over related records", () => {
  it("offers the records of its option source by their labels, and filters by the chosen record's key", async () => {
    rendered = await show([bar([field("authorId", "eq", { options: authorsSource })])]);
    const select = rendered.part("filter-select");
    expect(await rendered.choices(select)).toEqual(["Any", "Ada", "Grace"]);
    await rendered.choose(select, "Grace");
    expect(asked(rendered, "GET /api/posts?").at(-1)).toBe("GET /api/posts?limit=25&authorId=2");
    expect(select.textContent).toBe("Grace");
  });

  it("under present offers the values the facet answers, each with its count, labelled through one batched in request", async () => {
    rendered = await show([bar([field("text", "contains"), field("authorId", "eq", { options: authorsSource, values: "present" })])]);
    expect(asked(rendered, "GET /api/posts?limit=2&facet")).toEqual(["GET /api/posts?limit=2&facet=authorId"]);
    expect(asked(rendered, "GET /api/authors")).toEqual(["GET /api/authors?limit=2&id.in=1&id.in=2"]);
    const select = rendered.part("filter-select");
    expect(await rendered.choices(select)).toEqual(["Any", "Ada (2)", "Grace (1)"]);
    await rendered.choose(select, "Ada (2)");
    await rendered.enter(rendered.part("filter-input"), "kernels");
    await rendered.commit(rendered.part("filter-input"), "enter");
    // The facet carries the bar's other filters, never the field's own.
    expect(asked(rendered, "GET /api/posts?limit=2&facet").at(-1)).toBe("GET /api/posts?limit=2&facet=authorId&text.contains=kernels");
    expect(asked(rendered, "GET /api/posts?limit=25").at(-1)).toBe("GET /api/posts?limit=25&text.contains=kernels&authorId=1");
  });

  it("reads its present values from the bar's collection when the bar holds no listing, and again on a change announced for it", async () => {
    const content = { type: "stack", children: [{ type: "text", text: "No listing here" }, component("HostProbe", { basePath: { value: "/api/posts" } })] };
    rendered = await show([bar([field("authorId", "eq", { values: "present" })], content)]);
    expect(asked(rendered, "GET /api/posts")).toEqual(["GET /api/posts?limit=100&facet=authorId"]);
    expect(await rendered.choices(rendered.part("filter-select"))).toEqual(["Any", "1 (2)", "2 (1)"]);
    await rendered.click(rendered.fixture("notify"));
    expect(asked(rendered, "GET /api/posts?limit=100&facet")).toHaveLength(2);
  });
});

describe("a filter on whether a property is absent", () => {
  it("is a switch sending <property>.absent=true, and is captioned apart from a filter on the same property", async () => {
    rendered = await show([bar([field("reviewerId", "eq"), field("reviewerId", "absent")])]);
    expect(rendered.parts("filter-caption").map((caption) => caption.textContent)).toEqual(["is", "not set"]);
    await rendered.click(rendered.part("filter-toggle"));
    expect(asked(rendered, "GET /api/posts?").at(-1)).toBe("GET /api/posts?limit=25&reviewerId.absent=true");
    expect(rendered.parts("table-row").map((each) => each.textContent)).toEqual(["On compilers", "On kernels"]);
  });

  it("has a caption word for every operator a filter takes", () => {
    const documents = parseAllDocuments(readFileSync(join(process.cwd(), "../../ui/telo.yaml"), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());
    const spec = documents.find((doc) => doc?.kind === "Telo.JsonSchema" && doc.metadata?.name === "SpecNode").schema;
    const filters = spec.oneOf.find((branch: { properties?: { type?: { const?: string } } }) => branch.properties?.type?.const === "filters");
    const operators: string[] = filters.properties.fields.items.properties.operator.enum;
    const words: string[] = spec.$defs.Word.properties.word.enum;
    expect(Object.keys(CAPTIONS).sort()).toEqual([...operators].sort());
    expect(operators.filter((operator) => !words.includes(CAPTIONS[operator as keyof typeof CAPTIONS]))).toEqual([]);
  });
});
