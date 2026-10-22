// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Menu } from "../src/controls/menu.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("the Radix menu", () => {
  it("marks the entry given as the current choice", () => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(
          Menu,
          {
            open: true,
            items: [
              { key: "0", label: "English", current: true },
              { key: "1", label: "Polski" },
            ],
            onOpenChange() {},
            onChange() {},
            children: createElement("button", { type: "button" }, "Language"),
          },
        ),
      ),
    );
    const items = [...document.querySelectorAll('[data-telo-part="menu-item"]')];
    expect(items.map((item) => [item.textContent, item.getAttribute("data-current"), item.getAttribute("aria-current")])).toEqual([
      ["English", "true", "true"],
      ["Polski", null, null],
    ]);
  });
});
