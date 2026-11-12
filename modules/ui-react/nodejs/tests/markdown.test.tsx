// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";
import { commentSchema, operation, promptOf } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

/** A page of one markdown node over `text`, once the renderer's chunk has drawn it. */
async function show(text: string): Promise<HTMLElement> {
  rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "markdown", value: { value: text } }] } } });
  await vi.waitFor(() => expect(rendered!.part("markdown").getAttribute("data-state")).toBe("idle"));
  return rendered.part("markdown");
}

const within = (root: HTMLElement, part: string) => [...root.querySelectorAll<HTMLElement>(`[data-telo-part="${part}"]`)];

describe("the markdown node", () => {
  it("draws raw HTML as text and inserts none", async () => {
    const markdown = await show("<script>alert(1)</script>\n\nsee <img src=x onerror=alert(1)> here");
    expect(markdown.querySelector("script, img")).toBeNull();
    expect(markdown.textContent).toContain("<script>alert(1)</script>");
    expect(markdown.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("draws a link that fails the address rule as plain text", async () => {
    const markdown = await show("[bad](javascript:alert(1)) and [also bad](//elsewhere.test/x)");
    expect(within(markdown, "markdown-link")).toEqual([]);
    expect(markdown.textContent).toBe("bad and also bad");
  });

  it("opens an external link in a new tab without an opener, and an application link in place", async () => {
    const markdown = await show("[out](https://example.com/a) [in](/docs) [mail](mailto:a@example.com)");
    const [out, local, mail] = within(markdown, "markdown-link");
    expect(out.getAttribute("href")).toBe("https://example.com/a");
    expect(out.getAttribute("target")).toBe("_blank");
    expect(out.getAttribute("rel")).toContain("noopener");
    expect(local.getAttribute("href")).toBe("/docs");
    expect(local.getAttribute("target")).toBeNull();
    expect(mail.getAttribute("target")).toBeNull();
  });

  it("draws an image that fails the address rule as its alt text", async () => {
    const markdown = await show("![one](javascript:alert(1)) ![two](data:image/png;base64,AAAA) ![three](/logo.png)");
    expect(within(markdown, "markdown-image").map((image) => image.getAttribute("src"))).toEqual(["/logo.png"]);
    expect(markdown.textContent).toBe("one two ");
  });

  it("draws a table with its alignment, a task list, strikethrough and an autolink", async () => {
    const markdown = await show("| a | b |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ https://example.org/x");
    expect(within(markdown, "markdown-table-header-cell").map((cell) => [cell.textContent, cell.getAttribute("data-align")])).toEqual([
      ["a", null],
      ["b", "end"],
    ]);
    expect(within(markdown, "markdown-table-cell").map((cell) => cell.textContent)).toEqual(["1", "2"]);
    expect(within(markdown, "markdown-task").map((box) => [box.getAttribute("aria-label"), box.getAttribute("aria-checked")])).toEqual([
      ["done", "true"],
      ["todo", "false"],
    ]);
    expect(within(markdown, "markdown-strike").map((each) => each.textContent)).toEqual(["gone"]);
    expect(within(markdown, "markdown-link").map((each) => each.getAttribute("href"))).toEqual(["https://example.org/x"]);
  });

  it("draws a fenced block highlighted, with a control copying its code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const markdown = await show("```ts\nconst answer: number = 42;\n```");
    expect(within(markdown, "markdown-code-language").map((each) => each.textContent)).toEqual(["ts"]);
    expect(within(markdown, "markdown-token").map((each) => [each.textContent, each.getAttribute("data-token")])).toContainEqual(["const", "keyword"]);
    expect(within(markdown, "markdown-code-text")[0].textContent).toBe("const answer: number = 42;");
    const [copy] = within(markdown, "markdown-code-copy");
    expect(copy.textContent).toBe("Copy code");
    await rendered!.click(copy);
    await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("const answer: number = 42;");
  });

  it("shows a copy that the browser refuses as an error beside the control", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    const markdown = await show("```\nplain\n```");
    await rendered!.click(within(markdown, "markdown-code-copy")[0]);
    await vi.waitFor(() => expect(within(markdown, "error-code").map((each) => each.textContent)).toEqual(["ERR_UI_COPY_FAILED"]));
    expect(within(markdown, "markdown-token")).toEqual([]);
  });
});

/** The text a review shows: a heading, a list of two items, a fenced block, ten lines. */
const plan = "# Plan\n\n## S1 Split\n\n- S1.1 one file\n- S1.2 two files\n\n```\n- S1.3 not an item\n```";
const comment = operation("/api/plans/p7/comments", "Comment", commentSchema);
const row = (...path: string[]) => ({ root: "row", path });

/** A markdown node over the plan, its annotations over `items`, once drawn. */
async function annotated(items: Record<string, unknown>[]): Promise<HTMLElement> {
  const node = {
    type: "markdown",
    value: { value: plan },
    annotations: {
      rows: { value: items },
      line: row("line"),
      count: row("count"),
      action: { action: comment, inputs: { id: { value: "p7" }, revision: { value: 3 }, item: row("id") }, prompt: promptOf(comment, ["author", "body"]) },
    },
  };
  rendered = await render({ path: "/", pages: { "/": { title: "Plan", children: [node as never] } } });
  await vi.waitFor(() => expect(rendered!.part("markdown").getAttribute("data-state")).toBe("idle"));
  return rendered.part("markdown");
}

/** The badges of the controls inside an element, in order. */
const counts = (element: Element) => [...element.querySelectorAll('[data-telo-part="markdown-annotation"]')].map((each) => each.querySelector('[data-telo-part="badge"]')?.textContent ?? null);

describe("a markdown node's annotations", () => {
  it("draw each control on the block holding its line, two on one block in order, and one past the text after it", async () => {
    const markdown = await annotated([
      { id: "S1", line: 3, count: 2 },
      { id: "S1.1", line: 5, count: 1 },
      { id: "S1.1b", line: 5, count: 4 },
      { id: "S9", line: 999 },
    ]);
    const [heading] = within(markdown, "markdown-heading").filter((each) => each.getAttribute("data-level") === "2");
    const [first, second] = within(markdown, "markdown-list-item");
    expect([counts(heading), counts(first), counts(second), counts(within(markdown, "markdown-code-block")[0])]).toEqual([["2"], ["1", "4"], [], []]);
    expect(first.querySelector('[data-telo-part="markdown-annotations"]')?.parentElement).toBe(first);
    const [after] = within(markdown, "markdown-unplaced-annotations");
    expect([after.previousElementSibling?.getAttribute("data-telo-part"), counts(after)]).toEqual(["markdown-code-block", [null]]);
    expect(within(markdown, "row-action").map((each) => each.textContent)).toEqual(["Comment", "Comment", "Comment", "Comment"]);
  });

  it("open the prompt for what the inputs leave, and send the item the row names", async () => {
    const markdown = await annotated([{ id: "S1.2", line: 6, count: 0 }]);
    rendered!.answer("/api/plans/p7/comments", () => new Response(null, { status: 201 }));
    await rendered!.click(within(within(markdown, "markdown-list-item")[1], "row-action")[0]);
    const dialog = document.querySelector<HTMLElement>('[data-surface="confirmation"]')!;
    expect([...dialog.querySelectorAll('[data-telo-part="label"]')].map((label) => label.textContent)).toEqual(["Your name", "Comment"]);
    const [author, body] = dialog.querySelectorAll('[data-telo-part="input"]');
    await rendered!.enter(author, "Ada");
    await rendered!.enter(body, "Split it further.");
    await rendered!.click(dialog.querySelector('[data-telo-part="submit"]')!);
    expect(rendered!.sent.map((each) => [each.request, each.body])).toEqual([
      ["POST /api/plans/p7/comments", { id: "p7", revision: 3, item: "S1.2", author: "Ada", body: "Split it further." }],
    ]);
  });
});
