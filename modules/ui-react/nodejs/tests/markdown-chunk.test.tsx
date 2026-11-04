// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";

// The chunk's module is held back until the test lets it arrive.
const chunk = vi.hoisted(() => {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  return { requested: false, arrive, arrived };
});
vi.mock("../src/browser/markdown/markdown-view.js", async (importOriginal) => {
  chunk.requested = true;
  await chunk.arrived;
  return importOriginal();
});

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

describe("the markdown chunk", () => {
  it("is not fetched by a page with no markdown node", async () => {
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "text", text: "Plain" } as never] } } });
    await rendered.settle();
    expect(rendered.parts("text").map((each) => each.textContent)).toEqual(["Plain"]);
    expect(chunk.requested).toBe(false);
  });

  it("is fetched by the first markdown node, whose text shows preformatted until it arrives", async () => {
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "markdown", text: { value: "**bold**" } } as never] } } });
    expect(chunk.requested).toBe(true);
    expect(rendered.part("markdown").getAttribute("data-state")).toBe("loading");
    expect(rendered.part("markdown-code-pre").textContent).toBe("**bold**");
    chunk.arrive();
    await vi.waitFor(() => expect(rendered!.part("markdown").querySelector("strong")?.textContent).toBe("bold"));
    expect(rendered.part("markdown").getAttribute("data-state")).toBe("idle");
  });
});
