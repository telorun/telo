// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, wire, type Rendered } from "./harness.js";
import { address } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const link = (text: string, button: unknown) => wire({ type: "link", text, href: address("/other"), button });

describe("a link node", () => {
  it("is drawn as a button-shaped anchor by its display, never a button element", async () => {
    rendered = await render({
      path: "/",
      pages: {
        "/": {
          title: "Home",
          children: [link("Inline", null), link("Plain", { type: "text" }), link("Go", { type: "icon", icon: null, label: "hidden" }), link("Both", { type: "icon", icon: null, label: "shown" })],
        },
        "/other": { title: "Other", children: [] },
      },
    });
    const [inline, plain, glyph, both] = rendered.parts("link");
    expect([inline, plain, glyph, both].map((each) => each.tagName)).toEqual(["A", "A", "A", "A"]);
    expect([inline, plain, glyph, both].map((each) => each.getAttribute("data-button"))).toEqual([null, "text", "icon", "icon"]);
    expect(plain.textContent).toBe("Plain");
    expect(glyph.getAttribute("aria-label")).toBe("Go");
    expect(glyph.textContent).toBe("");
    expect(glyph.querySelector('[data-telo-part="icon"]')).not.toBeNull();
    expect(both.textContent).toBe("Both");
    expect(both.querySelector('[data-telo-part="icon"]')).not.toBeNull();
  });
});
