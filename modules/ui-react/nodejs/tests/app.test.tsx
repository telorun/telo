// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const pages = { "/": { title: "Home", children: [{ type: "text", text: "First" }] } };

describe("the application shell", () => {
  it("applies the application document: title, navigation and stylesheets in order", async () => {
    rendered = await render({ path: "/", prefix: "/admin", pages });
    expect(rendered.part("app-title").textContent).toBe("Test App");
    expect(rendered.part("page-title").textContent).toBe("Home");
    expect(document.title).toBe("Home · Test App");
    const links = [...document.head.querySelectorAll("link[data-telo-stylesheet]")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/admin/_telo/ui/assets/aa/base.css"]);
  });

  it("draws the application's own header nodes before its title and after its navigation, on every page", async () => {
    const header = { start: [{ type: "image", src: "/logo.svg", alt: "Logo" }], end: [{ type: "link", text: "Help", href: "/help" }] };
    rendered = await render({ path: "/nowhere", prefix: "/admin", pages, header });
    const parts = (element: Element) => [...element.children].map((child) => child.getAttribute("data-telo-part"));
    expect(parts(rendered.part("header"))).toEqual(["header-content"]);
    expect(parts(rendered.part("header-content"))).toEqual(["header-start", "app-title", "nav", "header-end"]);
    expect(rendered.part("header-start").querySelector("img")?.getAttribute("src")).toBe("/admin/logo.svg");
    expect(rendered.part("header-end").querySelector("a")?.getAttribute("href")).toBe("/admin/help");
    expect(rendered.part("page-title").textContent).toBe("Not found");
  });

  it("draws the header at the application's width on every page, whatever each page's own", async () => {
    const widths = { "/": { ...pages["/"], width: "full" as const }, "/other": { title: "Other", width: "contained" as const, children: [] } };
    rendered = await render({ path: "/", pages: widths, header: { width: "contained" } });
    const drawn = () => [rendered!.part("header").getAttribute("data-width"), rendered!.part("page").getAttribute("data-width"), rendered!.part("app").hasAttribute("data-width")];
    expect(drawn()).toEqual(["contained", "full", false]);
    await rendered.click(rendered.parts("nav-item").find((item) => item.textContent === "Other")!);
    expect(drawn()).toEqual(["contained", "contained", false]);
  });

  it("draws nothing until its stylesheets have loaded, so the shell's spinner stays", async () => {
    rendered = await render({ path: "/", pages, holdStylesheets: true });
    expect(document.head.querySelectorAll("link[data-telo-stylesheet]")).toHaveLength(1);
    expect(rendered.container.childElementCount).toBe(0);
    await rendered.loadStylesheets();
    expect(rendered.part("page-title").textContent).toBe("Home");
  });

  it("re-fetches conditionally on a reconnect and re-renders only what changed", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.hello();
    const before = rendered.requests.length;
    await rendered.hello();
    expect(rendered.requests.slice(before)).toEqual(["GET /_telo/ui/app", "GET /_telo/ui/page?path=%2F"]);
    expect(rendered.part("text").textContent).toBe("First");
    rendered.setPage("/", { title: "Home", children: [{ type: "text", text: "Second" }] });
    await rendered.hello();
    expect(rendered.part("text").textContent).toBe("Second");
    expect(rendered.reloads).toBe(0);
  });

  it("reloads when the server holds another renderer", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.hello("bundle-2");
    expect(rendered.reloads).toBe(1);
    rendered.setBundle("bundle-2");
    await rendered.hello();
    await rendered.hello();
    expect(rendered.reloads).toBeGreaterThan(1);
  });

  it.each([
    [401, "ERR_UI_UNAUTHORIZED"],
    [403, "ERR_UI_FORBIDDEN"],
    [502, "ERR_UI_REQUEST_FAILED"],
  ])("shows a %i from a document as a page-level error node", async (status, code) => {
    rendered = await render({ path: "/", pages, answers: { "/_telo/ui/page": () => new Response(null, { status }) } });
    expect(rendered.part("page").getAttribute("data-state")).toBe("error");
    expect(rendered.part("error-code").textContent).toBe(code);
    expect(rendered.part("app-title").textContent).toBe("Test App");
  });
});
