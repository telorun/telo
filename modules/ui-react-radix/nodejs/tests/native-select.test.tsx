// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { MultiSelectProps, SelectProps } from "../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { prepareWindow } from "../../../ui-react/nodejs/src/contract/interpreter.js";
import { MultiSelect, Select } from "../src/controls/select.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const semantics = { id: "status", invalid: false, required: false, disabled: false, loading: false, hasMore: false };
const options = [
  { key: "open", label: "Open" },
  { key: "done", label: "Done" },
];
const select = (open: boolean): SelectProps => ({
  ...semantics,
  part: "select",
  options,
  value: "open",
  placeholder: "Pick one",
  noneLabel: "None",
  open,
  onOpenChange() {},
  onChange() {},
});
const multiSelect = (open: boolean): MultiSelectProps => ({
  ...semantics,
  part: "select",
  options,
  value: ["open"],
  placeholder: "Pick any",
  open,
  onOpenChange() {},
  onChange() {},
});

/** Taken out of the page by an attribute or a style of its own or of a container. */
function removed(element: Element): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || at.hasAttribute("inert")) return true;
    const style = getComputedStyle(at);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}

/** Drawn where a person can see it: on the page, and not clipped to nothing. */
function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  const clipped = /^rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)$/.test(style.clip) || style.clipPath === "inset(50%)";
  const shrunk = style.overflow === "hidden" && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1;
  return !removed(element) && !clipped && !shrunk;
}

const tabbable = (element: HTMLSelectElement) => element.tabIndex >= 0 && !element.disabled && !removed(element);

/** Every native list on the page a person could reach by Tab or see. */
const reachable = () => [...document.querySelectorAll("select")].filter((element) => tabbable(element) || visible(element)).map((element) => element.outerHTML);

describe("a choice drawn inside a form", () => {
  it.each([
    ["Select", false],
    ["Select", true],
    ["MultiSelect", false],
    ["MultiSelect", true],
  ] as const)("draws no native list a person can tab to or see: %s, open %s", async (name, open) => {
    prepareWindow(window);
    const form = document.body.appendChild(document.createElement("form"));
    root = createRoot(form);
    await act(async () => root!.render(name === "Select" ? createElement(Select, select(open)) : createElement(MultiSelect, multiSelect(open))));
    expect(reachable()).toEqual([]);
  });
});
