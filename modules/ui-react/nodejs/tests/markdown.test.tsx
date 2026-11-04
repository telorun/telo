// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

/** A page of one markdown node over `text`, once the renderer's chunk has drawn it. */
async function show(text: string): Promise<HTMLElement> {
  rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "markdown", text: { value: text } }] } } });
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
