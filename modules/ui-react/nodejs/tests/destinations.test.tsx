// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HEADER_NAVIGATION, render, type Rendered } from "./harness.js";
import { address, dialogSurface, openPageAt } from "./spec-nodes.js";
import { wireText } from "./ui-texts.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const pages = {
  "/": { title: "Home", children: [{ type: "link", text: "Ada", to: openPageAt(address("/authors/{id}", { id: { value: "ada" } }, { from: { value: "home" } })) }] },
  "/authors/{id}": { title: "Author", children: [{ type: "text", text: "The author page" }] },
};

/** The surface an opened page is drawn in, and what it holds. */
const opened = () => {
  const surface = document.querySelector<HTMLElement>('[data-telo-part="surface"]');
  return surface && { surface, title: surface.querySelector('[data-telo-part="surface-title"]')?.textContent, text: surface.querySelector('[data-telo-part="text"]')?.textContent };
};

describe("a destination opening a page", () => {
  it("is a real link to the opened page's own address: a modified click is the browser's, a plain one opens the page over this one", async () => {
    rendered = await render({ path: "/", prefix: "/admin", pages });
    const link = rendered.part("link");
    expect(link.getAttribute("href")).toBe("/admin/authors/ada?from=home");
    expect(await rendered.click(link, { ctrlKey: true })).toBe(false);
    expect(opened()).toBeNull();
    expect(await rendered.click(link)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/admin/");
    expect(opened()).toMatchObject({ title: "Author", text: "The author page" });
    expect(opened()?.surface.getAttribute("data-surface")).toBe("dialog");
  });

  it("is a navigation link entry drawn as a link to the page's address, a plain press opening the page and the entry current while it is open", async () => {
    const help = { type: "link", key: "help", to: openPageAt(address("/authors/ada")), text: wireText("Ada") };
    rendered = await render({ path: "/", pages, navigation: { items: [help], placement: HEADER_NAVIGATION } });
    const entry = rendered.part("nav-item");
    expect(entry.getAttribute("href")).toBe("/authors/ada");
    expect(entry.getAttribute("aria-current")).toBeNull();
    expect(await rendered.click(entry)).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(opened()).toMatchObject({ title: "Author", text: "The author page" });
    expect(rendered.part("nav-item").getAttribute("aria-current")).toBe("page");
    await rendered.escape();
    expect(opened()).toBeNull();
    expect(rendered.part("nav-item").getAttribute("aria-current")).toBeNull();
  });

  it("is a menu item opening the page, current while it is open", async () => {
    const menu = { type: "menu", text: "Help", items: [{ type: "link", text: "Ada", to: openPageAt(address("/authors/ada"), { ...dialogSurface, size: "small" }, false) }] };
    rendered = await render({ path: "/", pages: { ...pages, "/": { title: "Home", children: [menu] } } });
    await rendered.click(rendered.part("nav-toggle"));
    const item = rendered.parts("nav-item").find((each) => each.textContent === "Ada") as HTMLElement;
    expect(item.getAttribute("href")).toBe("/authors/ada");
    await rendered.click(item);
    expect(opened()).toMatchObject({ title: "Author", text: "The author page" });
    expect(opened()?.surface.getAttribute("data-size")).toBe("small");
  });
});
