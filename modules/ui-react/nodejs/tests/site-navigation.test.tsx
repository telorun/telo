// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HEADER_NAVIGATION, render, type Rendered } from "./harness.js";
import { wireText } from "./words.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const page = (title: string) => ({ title, children: [{ type: "text", text: `The ${title} page` }] });
const pages = { "/": page("Home"), "/users": page("Users"), "/audit": page("Audit") };
const entry = (key: string, path: string, text: string) => ({ type: "page", key, path, text: wireText(text) });
const tree = [
  entry("home", "/", "Home"),
  {
    type: "group",
    key: "admin",
    text: wireText("Admin"),
    items: [entry("admin/users", "/users", "Users"), { type: "group", key: "admin/logs", text: wireText("Logs"), items: [entry("admin/logs/audit", "/audit", "Audit")] }],
  },
];
const drawer = (side: string) => ({
  type: "drawer",
  side,
  size: "medium",
  modal: true,
  dismiss: { escape: true, outside: true, closeButton: true },
});
const headerParts = (r: Rendered) => [...r.part("header").children].map((child) => child.getAttribute("data-telo-part"));
const toggle = (r: Rendered, text: string) => r.parts("nav-toggle").find((candidate) => candidate.textContent === text) as HTMLElement;

describe("the application's navigation", () => {
  it("draws the tree in the header: a group as a dropdown, a nested group as a submenu, the shown page and the groups on the way to it current", async () => {
    rendered = await render({ path: "/audit", pages, navigation: { items: tree, placement: HEADER_NAVIGATION } });
    expect(rendered.part("nav").querySelector('[data-telo-part="navigation"]')?.getAttribute("data-layout")).toBe("horizontal");
    expect(toggle(rendered, "Admin").getAttribute("data-current")).toBe("true");
    await rendered.click(toggle(rendered, "Admin"));
    await rendered.click(toggle(rendered, "Logs"));
    expect(rendered.parts("nav-panel")).toHaveLength(2);
    expect(toggle(rendered, "Logs").getAttribute("data-current")).toBe("true");
    const items = rendered.parts("nav-item").map((item) => [item.textContent, item.getAttribute("href"), item.getAttribute("aria-current")]);
    expect(items).toEqual([
      ["Home", "/", null],
      ["Users", "/users", null],
      ["Audit", "/audit", "page"],
    ]);
  });

  it("is a menu button first in the header below the breakpoint, opening a drawer holding the whole tree, its groups opened in place", async () => {
    rendered = await render({ path: "/", pages, narrow: true, navigation: { items: tree, placement: HEADER_NAVIGATION } });
    expect(headerParts(rendered)).toEqual(["nav-menu", "app-title"]);
    await rendered.click(rendered.part("nav-menu"));
    const surface = rendered.part("surface");
    expect([surface.getAttribute("data-surface"), surface.getAttribute("data-side")]).toEqual(["drawer", "start"]);
    expect(surface.querySelector('[data-telo-part="navigation"]')?.getAttribute("data-layout")).toBe("vertical");
    await rendered.click(toggle(rendered, "Admin"));
    await rendered.click(toggle(rendered, "Logs"));
    expect(surface.querySelectorAll('[data-telo-part="navigation"] [data-telo-part="nav-group"]')).toHaveLength(2);
    expect(rendered.parts("nav-panel")).toEqual([]);
    await rendered.click(rendered.parts("nav-item").find((item) => item.textContent === "Users") as HTMLElement);
    expect(window.location.pathname).toBe("/users");
    expect(rendered.parts("surface")).toEqual([]);
  });

  it("keeps a sidebar's open groups and its collapsed rail in its store, read back when the application is drawn again", async () => {
    const sidebar = { type: "sidebar", side: "start", rail: { collapsed: false }, store: { type: "local" }, compact: { type: "overlay", surface: drawer("start") } };
    const draw = () => render({ path: "/", pages, navigation: { items: tree, placement: sidebar } });
    const layout = (r: Rendered) => r.part("sidebar").querySelector('[data-telo-part="navigation"]')?.getAttribute("data-layout");
    window.localStorage.clear();
    rendered = await draw();
    expect(layout(rendered)).toBe("vertical");
    await rendered.click(toggle(rendered, "Admin"));
    await rendered.click(toggle(rendered, "Logs"));
    await rendered.click(rendered.part("sidebar-toggle"));
    expect([layout(rendered), rendered.part("sidebar").getAttribute("data-state")]).toEqual(["rail", "closed"]);
    expect(JSON.parse(window.localStorage.getItem("telo.ui:/:n") as string)).toEqual({ v: 2, open: ["admin", "admin/logs"], collapsed: true });
    rendered.unmount();

    rendered = await draw();
    expect(layout(rendered)).toBe("rail");
    await rendered.click(rendered.part("sidebar-toggle"));
    expect(rendered.parts("nav-group")).toHaveLength(2);
    window.localStorage.clear();
  });

  it("puts the menu button last in the header when its drawer opens from the end edge", async () => {
    rendered = await render({ path: "/", pages, navigation: { items: tree, placement: { type: "overlay", surface: drawer("end") } } });
    expect(headerParts(rendered)).toEqual(["app-title", "nav-menu"]);
  });

  it("draws an entry's icon as a glyph masked by the file at its address, hidden from assistive technology and holding no markup of the file's", async () => {
    const items = [{ ...entry("home", "/", "Home"), icon: "/_telo/ui/assets/aa/house.svg" }, entry("users", "/users", "Users")];
    rendered = await render({ path: "/", pages, navigation: { items, placement: HEADER_NAVIGATION } });
    const glyphs = rendered.parts("glyph");
    expect(glyphs.map((glyph) => glyph.closest('[data-telo-part="nav-item"]')?.textContent)).toEqual(["Home"]);
    expect(glyphs[0].style.getPropertyValue("--ui-react-glyph")).toBe('url("/_telo/ui/assets/aa/house.svg")');
    expect([glyphs[0].getAttribute("aria-hidden"), glyphs[0].childNodes.length]).toEqual(["true", 0]);
  });

  it("keeps every tab of a tab bar narrower than its tabs in the bar, the rest under its own More", async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const box = HTMLElement.prototype.getBoundingClientRect;
    // A 320px bar whose every tab is 120px wide: three tabs are wider than the bar.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 320 });
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    try {
      const items = [entry("home", "/", "Home"), entry("users", "/users", "Users"), entry("audit", "/audit", "Audit"), { type: "link", key: "help", href: "/help", text: wireText("Help") }];
      const tabBar = { type: "tab-bar", visible: 3, surface: drawer("bottom") };
      rendered = await render({ path: "/", pages, navigation: { items, placement: tabBar } });
      const bar = rendered.part("tab-bar");
      const tabs = [...bar.querySelectorAll('[data-telo-part="nav-item"], [data-telo-part="nav-toggle"]')].map((tab) => tab.textContent);
      expect(tabs).toEqual(["Home", "Users", "More"]);
      await rendered.click(toggle(rendered, "More"));
      const sheet = rendered.part("surface");
      expect([...sheet.querySelectorAll('[data-telo-part="nav-item"]')].map((item) => item.textContent)).toEqual(["Audit", "Help"]);
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      HTMLElement.prototype.getBoundingClientRect = box;
    }
  });
});
