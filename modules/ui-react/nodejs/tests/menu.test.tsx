// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStore } from "../src/browser/host.js";
import { render, type Page, type Rendered } from "./harness.js";

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
  });

describe("a menu node", () => {
  it("is a button opening its links through the Menu control, the current one marked", async () => {
    rendered = await show([
      menu([
        { type: "link", text: "English", href: "/done", style: ["muted", "strong"] },
        { type: "link", text: "Polski", href: "/done?lang=pl" },
      ]),
    ]);
    const trigger = rendered.part("menu-trigger");
    expect([trigger.tagName, trigger.textContent, trigger.getAttribute("data-style"), trigger.getAttribute("aria-haspopup")]).toEqual([
      "BUTTON",
      "Language",
      "muted",
      "menu",
    ]);
    expect(trigger.querySelector('[data-telo-part="icon"]')).not.toBeNull();
    await rendered.open(trigger);
    expect(rendered.parts("menu-item").map((item) => [item.textContent, item.getAttribute("data-current"), item.getAttribute("aria-current")])).toEqual([
      ["English", "true", "true"],
      ["Polski", null, null],
    ]);
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
      await rendered!.open(rendered!.part("menu-trigger"));
      const item = rendered!.parts("menu-item").find((candidate) => candidate.textContent === label);
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
    await rendered.open(rendered.part("menu-trigger"));
    expect(rendered.parts("menu-item").map((item) => item.textContent)).toEqual(["Shown"]);
  });

  it("is an error node when one of its links leaves the application once resolved", async () => {
    rendered = await show([menu([{ type: "link", text: "Here", href: "/done" }, { type: "link", text: "Away", href: "javascript:alert(1)" }])]);
    expect(rendered.parts("menu-trigger")).toEqual([]);
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_NODE_INVALID");
  });
});
