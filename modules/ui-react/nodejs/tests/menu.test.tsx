// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStore } from "../src/browser/host.js";
import { HEADER_NAVIGATION, render, type Page, type Rendered } from "./harness.js";

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const menu = (items: Record<string, unknown>[]): Page["children"][number] => ({ type: "menu", text: "Language", style: "muted", items });
const show = (children: Page["children"], prefix = "") =>
  render({
    path: "/",
    prefix,
    pages: { "/": { title: "Home", children }, "/done": { title: "Done", children: [{ type: "text", text: "The done page" }] } },
    // No site navigation: the menu node is the only one drawn.
    navigation: { items: [], placement: HEADER_NAVIGATION },
  });

describe("a menu node", () => {
  it("is one disclosure and no landmark, its items links and the current one marked", async () => {
    rendered = await show([
      menu([
        { type: "link", text: "English", href: "/done", style: ["muted", "strong"] },
        { type: "link", text: "Polski", href: "/done?lang=pl" },
      ]),
    ]);
    const root = rendered.part("navigation");
    const toggle = rendered.part("nav-toggle");
    expect([root.tagName, root.getAttribute("data-style"), toggle.tagName, toggle.textContent, toggle.getAttribute("aria-expanded")]).toEqual([
      "DIV",
      "muted",
      "BUTTON",
      "Language",
      "false",
    ]);
    expect(toggle.querySelector('[data-telo-part="icon"]')).not.toBeNull();
    await rendered.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rendered.parts("nav-item").map((item) => [item.tagName, item.getAttribute("role"), item.textContent, item.getAttribute("href"), item.getAttribute("aria-current")])).toEqual([
      ["A", null, "English", "/done", "true"],
      ["A", null, "Polski", "/done?lang=pl", null],
    ]);
    expect(document.querySelectorAll('[role="menu"], [role="menuitem"]')).toHaveLength(0);
  });

  it("moves within the application to a declared page, and loads any other address", async () => {
    const leave = vi.spyOn(HostStore.prototype, "leave").mockImplementation(() => {});
    rendered = await show(
      [
        menu([
          { type: "link", text: "Done", href: "/done?lang=pl" },
          { type: "link", text: "A file", href: "/files/a.pdf" },
          { type: "link", text: "Elsewhere", href: "https://example.com/x" },
        ]),
      ],
      "/admin",
    );
    const pick = async (label: string) => {
      await rendered!.click(rendered!.part("nav-toggle"));
      const item = rendered!.parts("nav-item").find((candidate) => candidate.textContent === label);
      await rendered!.click(item as HTMLElement);
    };
    await pick("A file");
    await pick("Elsewhere");
    expect(leave.mock.calls).toEqual([["/admin/files/a.pdf"], ["https://example.com/x"]]);
    expect(window.location.pathname).toBe("/admin/");
    await pick("Done");
    expect([window.location.pathname, window.location.search]).toEqual(["/admin/done", "?lang=pl"]);
    expect(rendered.part("text").textContent).toBe("The done page");
    expect(leave).toHaveBeenCalledTimes(2);
  });

  it("offers only the links whose condition holds", async () => {
    rendered = await show([
      menu([
        { type: "link", text: "Shown", href: "/done" },
        { type: "link", text: "Hidden", href: "/done", shown: { at: { value: 1 }, matches: { const: 2 } } },
      ]),
    ]);
    await rendered.click(rendered.part("nav-toggle"));
    expect(rendered.parts("nav-item").map((item) => item.textContent)).toEqual(["Shown"]);
  });

  it("is an error node when one of its links leaves the application once resolved", async () => {
    rendered = await show([menu([{ type: "link", text: "Here", href: "/done" }, { type: "link", text: "Away", href: "javascript:alert(1)" }])]);
    expect(rendered.parts("navigation")).toEqual([]);
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_NODE_INVALID");
  });
});
