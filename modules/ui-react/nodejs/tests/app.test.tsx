// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";
import { address, asideOf, operation } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const pages = { "/": { title: "Home", children: [{ type: "text", text: "First" }] } };

describe("the application shell", () => {
  it("applies the application document: title, layout and stylesheets in order", async () => {
    rendered = await render({ path: "/", prefix: "/admin", pages });
    expect(rendered.part("navbar-title").textContent).toBe("Test App");
    expect(rendered.parts("page-title")).toEqual([]);
    expect(rendered.part("page").textContent).toContain("First");
    expect(document.title).toBe("Home · Test App");
    const links = [...document.head.querySelectorAll("link[data-telo-stylesheet]")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/admin/_telo/ui/assets/aa/base.css"]);
  });

  it("draws no heading for a page's title, and a text of the title style is the page's only h1", async () => {
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "text", style: "title", text: "Welcome" }, { type: "text", text: "First" }] } } });
    expect([...rendered.container.querySelectorAll("h1")].map((heading) => heading.textContent)).toEqual(["Welcome"]);
    expect(document.title).toBe("Home · Test App");
  });

  it("draws a page in an empty layout with no header, aside, footer or heading, though the layout has an id", async () => {
    rendered = await render({
      path: "/",
      layouts: { empty: { header: [], footer: [] } },
      pages: { "/": { title: "Home", layout: "empty", children: [{ type: "text", text: "First" }] } },
    });
    expect(rendered.requests.some((request) => request.includes("/_telo/ui/layout?id=empty"))).toBe(true);
    expect(["header", "aside", "footer"].map((part) => rendered!.parts(part).length)).toEqual([0, 0, 0]);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(0);
    expect(rendered.part("main").contains(rendered.part("page"))).toBe(true);
  });

  it("insets the header's content the same whether the aside is open, folded or compact", async () => {
    const aside = asideOf({ type: "text", text: "Side" }, { collapse: { collapsed: false, state: null } });
    rendered = await render({ path: "/", layouts: { main: { header: [{ type: "text", text: "Top" }], aside } }, pages: { "/": { title: "Home", children: [] } } });
    const inset = () => [rendered!.part("header").getAttribute("data-width"), rendered!.part("header").parentElement === rendered!.part("app"), rendered!.part("header-content").parentElement === rendered!.part("header")];
    const open = inset();
    expect(open).toEqual(["contained", true, true]);
    await rendered.click(rendered.part("aside-toggle"));
    expect(rendered.part("aside").getAttribute("data-state")).toBe("rail");
    expect(inset()).toEqual(open);
    await rendered.click(rendered.part("aside-toggle"));
    await rendered.setNarrow(true);
    expect(inset()).toEqual(open);
  });

  it("draws a bare page as one component: no header, aside, footer or heading, and a layout's page beside it with all of them", async () => {
    const layouts = {
      main: {
        header: [{ type: "text", text: "Top" }],
        aside: asideOf({ type: "text", text: "Side" }),
        footer: [{ type: "text", text: "Bottom" }],
      },
    };
    rendered = await render({
      path: "/sign-in",
      layouts,
      pages: { "/": { title: "Home", children: [{ type: "text", text: "First" }] }, "/sign-in": { title: "Sign in", layout: false, children: [{ type: "link", text: "Back", href: address("/") }] } },
    });
    expect(["header", "aside", "footer"].map((part) => rendered!.parts(part).length)).toEqual([0, 0, 0]);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(0);
    expect(rendered.requests.some((request) => request.includes("/_telo/ui/layout"))).toBe(false);
    await rendered.click(rendered.part("link"));
    const landmarks = ["header", "aside", "main", "footer"].map((part) => rendered!.part(part).tagName.toLowerCase());
    expect(landmarks).toEqual(["header", "aside", "main", "footer"]);
    expect(rendered.part("header").textContent).toBe("Top");
    expect(rendered.part("footer").textContent).toBe("Bottom");
    expect(rendered.part("main").contains(rendered.part("page"))).toBe(true);
  });

  it("fetches a layout once per id, revalidates it in parallel with each page and on a reconnect, and keeps the regions mounted across pages of one id", async () => {
    const header = [{ type: "text", text: "Top" }];
    rendered = await render({
      path: "/",
      layouts: { main: { header } },
      pages: { "/": { title: "Home", children: [{ type: "link", text: "Next", href: address("/two") }] }, "/two": { title: "Two", children: [{ type: "text", text: "Second" }] } },
    });
    const layoutRequests = () => rendered!.requests.filter((request) => request.includes("/_telo/ui/layout"));
    const top = rendered.part("header").querySelector('[data-telo-part="text"]');
    expect(layoutRequests()).toEqual(["GET /_telo/ui/layout?id=main"]);
    // The page document and the layout are asked for together, the page first.
    const first = rendered.requests.filter((request) => request.includes("/_telo/ui/page") || request.includes("/_telo/ui/layout"));
    expect(first).toEqual(["GET /_telo/ui/page?path=%2F", "GET /_telo/ui/layout?id=main"]);
    await rendered.click(rendered.part("link"));
    expect(layoutRequests()).toHaveLength(2);
    expect(rendered.part("page").textContent).toContain("Second");
    expect(rendered.part("header").querySelector('[data-telo-part="text"]')).toBe(top);
    await rendered.hello();
    await rendered.hello();
    expect(layoutRequests()).toHaveLength(3);
    expect(rendered.part("header").querySelector('[data-telo-part="text"]')).toBe(top);
  });

  it("redraws a layout whose digest changed in place, and keeps the one a 304 answered", async () => {
    rendered = await render({ path: "/", layouts: { main: { header: [{ type: "text", text: "Top" }] } }, pages });
    const top = rendered.part("header").querySelector('[data-telo-part="text"]') as HTMLElement;
    await rendered.hello();
    await rendered.hello();
    expect(rendered.part("header").querySelector('[data-telo-part="text"]')).toBe(top);
    rendered.setLayout("main", { header: [{ type: "text", text: "Changed" }] });
    await rendered.hello();
    expect(rendered.part("header").textContent).toBe("Changed");
    expect(rendered.part("header").querySelector('[data-telo-part="text"]')).toBe(top);
  });

  it("draws the 404's nodes inside the default layout, so a missing page keeps the navigation", async () => {
    rendered = await render({ path: "/nowhere", pages });
    expect(rendered.part("navbar-title").textContent).toBe("Test App");
    expect(rendered.part("page").getAttribute("data-state")).toBe("empty");
    expect([...rendered.container.querySelectorAll("h1")].map((heading) => heading.textContent)).toEqual(["Not found"]);
    expect(rendered.requests).toContain("GET /_telo/ui/layout?id=main");
  });

  it("draws a navbar's own nodes before its title and after its navigation, on every page", async () => {
    const header = { start: [{ type: "image", src: "/logo.svg", alt: "Logo" }], end: [{ type: "link", text: "Help", href: address("/help") }] };
    rendered = await render({ path: "/nowhere", prefix: "/admin", pages, header });
    const parts = (element: Element) => [...element.children].map((child) => child.getAttribute("data-telo-part"));
    expect(parts(rendered.part("header"))).toEqual(["header-content"]);
    expect(parts(rendered.part("header-content"))).toEqual(["navbar"]);
    expect(parts(rendered.part("navbar"))).toEqual(["navbar-start", "navbar-title", "nav", "navbar-end"]);
    expect(rendered.part("navbar-start").querySelector("img")?.getAttribute("src")).toBe("/admin/logo.svg");
    expect(rendered.part("navbar-end").querySelector("a")?.getAttribute("href")).toBe("/admin/help");
  });

  it("draws the header's content at the layout's width on every page, whatever each page's own", async () => {
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
    expect(rendered.part("page").textContent).toContain("First");
  });

  it("re-fetches conditionally on a reconnect and re-renders only what changed", async () => {
    rendered = await render({ path: "/", pages });
    await rendered.hello();
    const before = rendered.requests.length;
    await rendered.hello();
    expect(rendered.requests.slice(before).sort()).toEqual(["GET /_telo/ui/app", "GET /_telo/ui/layout?id=main", "GET /_telo/ui/page?path=%2F"]);
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

  it("opens a page by the variables of its path, which its nodes read as `params`", async () => {
    const plan = { title: "Plan", children: [{ type: "value", value: { root: "params", path: ["id"] }, present: { type: "string" } }] };
    rendered = await render({ path: "/", pages: { "/": { title: "Home", children: [{ type: "link", text: "Open", href: address("/plans/p%207") }] }, "/plans/{id}": plan } });
    expect(await rendered.click(rendered.part("link"))).toBe(true);
    expect(rendered.requests).toContain("GET /_telo/ui/page?path=%2Fplans%2Fp%25207");
    expect(rendered.part("value").textContent).toBe("p 7");
  });

  it("draws a page afresh for another value of a variable, and keeps it mounted for another query", async () => {
    const note = operation("/api/notes", "Send", { type: "object", properties: { note: { type: "string", title: "Note" } } });
    const links = [
      { type: "link", text: "Same", href: address("/plans/a", {}, { tab: { value: "x" } }) },
      { type: "link", text: "Other", href: address("/plans/b") },
    ];
    rendered = await render({ path: "/plans/a", pages: { "/plans/{id}": { title: "Plan", children: [note, ...links] } } });
    const documents = () => rendered!.requests.filter((request) => request.startsWith("GET /_telo/ui/page")).length;
    await rendered.enter(rendered.part("input"), "kept");
    await rendered.click(rendered.parts("link")[0]);
    expect([window.location.search, (rendered.part("input") as HTMLInputElement).value]).toEqual(["?tab=x", "kept"]);
    await rendered.click(rendered.parts("link")[1]);
    expect([window.location.pathname, (rendered.part("input") as HTMLInputElement).value, documents()]).toEqual(["/plans/b", "", 1]);
  });

  it.each([
    [401, "ERR_UI_UNAUTHORIZED"],
    [403, "ERR_UI_FORBIDDEN"],
    [502, "ERR_UI_REQUEST_FAILED"],
  ])("shows a %i from a document as a page-level error node", async (status, code) => {
    rendered = await render({ path: "/", pages, answers: { "/_telo/ui/page": () => new Response(null, { status }) } });
    expect(rendered.part("page").getAttribute("data-state")).toBe("error");
    expect(rendered.part("error-code").textContent).toBe(code);
    expect(rendered.part("navbar-title").textContent).toBe("Test App");
  });
});
