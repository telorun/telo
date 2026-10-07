// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLE, render, type Page, type Rendered } from "./harness.js";
import { filtersNode } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const show = (children: unknown[], more: Record<string, Page> = {}) =>
  render({ path: "/", pages: { "/": { title: "Home", children: children as never }, ...more } });
const codes = (r: Rendered) => r.parts("error-code").map((code) => code.textContent);
const texts = (r: Rendered) => r.parts("text").map((text) => text.textContent);

/** A container with no list of children: drawing it throws. */
const broken = { type: "box" };

describe("what the renderer draws", () => {
  it("replaces a node that throws with the error node, wherever it sits, its siblings drawn", async () => {
    // React reports every caught error; the report is not what is asserted.
    vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await show([
      { type: "text", text: "Above" },
      broken,
      { type: "stack", children: [{ type: "text", text: "Inside" }, broken] },
      { type: "columns", children: [broken, { type: "text", text: "Beside" }] },
      filtersNode(broken as never),
      { type: "text", text: "Below" },
    ]);
    expect(texts(rendered)).toEqual(["Above", "Inside", "Beside", "Below"]);
    expect(codes(rendered)).toEqual(Array(4).fill("ERR_UI_NODE_INVALID"));
    expect(rendered.parts("filter").length).toBeGreaterThan(0);
    expect(rendered.part("page").getAttribute("data-state")).toBe("idle");
  });

  it("draws a corrected node where the one that threw stood", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await show([{ type: "text", text: "Above" }, broken, { type: "text", text: "Below" }]);
    expect(codes(rendered)).toEqual(["ERR_UI_NODE_INVALID"]);
    rendered.setPage("/", {
      title: "Home",
      children: [{ type: "text", text: "Above" }, { type: "text", text: "Fixed" }, { type: "text", text: "Below" }] as never,
    });
    // The first hello is the connection; a later one is what refetches the page.
    await rendered.hello();
    await rendered.hello();
    expect(codes(rendered)).toEqual([]);
    expect(texts(rendered)).toEqual(["Above", "Fixed", "Below"]);
  });

  it.each([
    ["//x", "error"],
    ["/\\x", "error"],
    ["/\t/x", "error"],
    ["/x", "/x"],
    ["/", "/"],
    ["/a//b", "/a//b"],
  ])("draws a link to %j as %s", async (href, drawn) => {
    rendered = await show([{ type: "text", text: "Above" }, { type: "link", text: "There", href }, { type: "text", text: "Below" }]);
    expect(texts(rendered)).toEqual(["Above", "Below"]);
    if (drawn === "error") {
      expect(rendered.parts("link")).toEqual([]);
      expect(codes(rendered)).toEqual(["ERR_UI_NODE_INVALID"]);
    } else {
      expect(rendered.parts("link").map((link) => link.getAttribute("href"))).toEqual([drawn]);
      expect(codes(rendered)).toEqual([]);
    }
  });

  it("draws a navigation entry that leaves the application as the error node, beside the others", async () => {
    rendered = await show([{ type: "text", text: "Home page" }], { "//x": { title: "Elsewhere", children: [] } });
    expect(rendered.parts("nav-link").map((link) => link.getAttribute("href"))).toEqual(["/"]);
    expect(rendered.part("nav").querySelector('[data-telo-part="error-code"]')?.textContent).toBe("ERR_UI_NODE_INVALID");
    expect(texts(rendered)).toEqual(["Home page"]);
  });

  it("shows the error node, not a blank document, when the application itself cannot be drawn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rendered = await render({
      path: "/",
      pages: {},
      answers: {
        "/_telo/ui/app": () =>
          new Response(JSON.stringify({ specVersion: 1, bundle: BUNDLE, digest: "app-1", title: "Broken", pages: null, stylesheets: [] })),
      },
    });
    expect(codes(rendered)).toEqual(["ERR_UI_NODE_INVALID"]);
    expect(rendered.container.textContent).not.toBe("");
  });
});
