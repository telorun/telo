// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ComboboxProps } from "../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { Combobox } from "../src/controls/combobox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const props: ComboboxProps = {
  id: "search",
  invalid: false,
  required: false,
  disabled: false,
  placeholder: "Search",
  value: "",
  open: true,
  groups: [{ key: "status", label: "Status", entries: [{ key: "open", label: "Open", checked: false }] }],
  highlighted: "open",
  onChange() {},
  onOpenChange() {},
  onHighlight() {},
  onPick() {},
  onBackspace() {},
};

describe("Combobox on Radix", () => {
  it("draws its open list as the one live layer root, in Radix's popper, with the focus left in the box", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Combobox, props)));
    const layers = [...document.querySelectorAll("[data-telo-layer]")];
    expect(layers).toHaveLength(1);
    expect(layers[0].hasAttribute("data-radix-popper-content-wrapper")).toBe(true);
    expect(layers[0].querySelector('[data-telo-part="combobox-content"]')).not.toBeNull();
    expect(host.contains(layers[0])).toBe(false);
    const box = document.getElementById("search")!;
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(layers[0].querySelector('[data-highlighted]')!.id);
    expect(document.activeElement).not.toBe(layers[0].querySelector('[data-telo-part="combobox-content"]'));
  });
});
