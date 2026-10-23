// @vitest-environment happy-dom
import { act, createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import contract from "../src/contract/controls.json" with { type: "json" };
import vectors from "../src/contract/vectors.json" with { type: "json" };
import type { ControlVectors, ElementSpec } from "../src/contract/interpreter.js";
import { prepareWindow } from "../src/contract/interpreter.js";
import { BUILT_IN_CONTROLS } from "../src/browser/controls/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The built-in layer controls toward a layer they did not draw — a custom
 * component's, another library's — opened above them: they leave it the focus,
 * report nothing for what happens inside it, cancel and stop none of its
 * events, and make none of it unreachable. This is the built-ins' behaviour,
 * not a term of the controls contract.
 */
const layerControls = Object.entries(contract.controls as Record<string, { layer?: true }>)
  .filter(([, control]) => control.layer === true)
  .map(([name]) => name);

const node = (spec: ElementSpec): ReactNode => createElement(spec.element, spec.attributes, spec.text, ...(spec.children ?? []).map(node));
const children = (value: unknown): ReactNode =>
  Array.isArray(value) ? createElement(Fragment, null, ...(value as ElementSpec[]).map(node)) : node(value as ElementSpec);

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

/** Draw a control open, as its vectors draw it, and record what it reports;
 *  it settles only once the caller lets a turn pass. */
function draw(name: string): unknown[][] {
  prepareWindow(window);
  const opener = document.createElement("button");
  opener.textContent = "Opener";
  const container = document.createElement("div");
  document.body.append(opener, container);
  opener.focus();
  const { props } = (vectors as Record<string, ControlVectors>)[name];
  const intents: unknown[][] = [];
  // A navigation is open with its one top-level group's panel: `open` is the set of open groups.
  const given: Record<string, unknown> = { ...props, open: name === "Navigation" ? ["docs"] : true };
  if (name === "Popover") given.anchor = opener;
  for (const intent of ["onOpenChange", "onChange", "onEndReached"]) given[intent] = (...args: unknown[]) => intents.push([intent, ...args]);
  if (given.children !== undefined) given.children = children(given.children);
  const Control = BUILT_IN_CONTROLS[name as keyof typeof BUILT_IN_CONTROLS] as ComponentType<any>;
  root = createRoot(container);
  act(() => root!.render(createElement(Control, given)));
  return intents;
}

async function drawOpen(name: string): Promise<unknown[][]> {
  const intents = draw(name);
  await settle();
  return intents;
}

/** A layer opened by someone else at the end of `<body>`, holding one button that takes the focus. */
function placeForeignLayer(): HTMLButtonElement {
  const layer = document.createElement("div");
  layer.setAttribute("data-telo-layer", "");
  const button = document.createElement("button");
  button.textContent = "Foreign";
  layer.append(button);
  document.body.append(layer);
  act(() => button.focus());
  return button;
}

async function openForeignLayer(): Promise<HTMLButtonElement> {
  const button = placeForeignLayer();
  await settle();
  return button;
}

/** Dispatch an event inside the foreign layer, answering whether it reached the window uncancelled. */
async function neutral(target: Element, event: Event): Promise<boolean> {
  let seen: Event | undefined;
  const watch = (arrived: Event) => (seen = arrived);
  window.addEventListener(event.type, watch);
  let kept = false;
  await act(async () => {
    kept = target.dispatchEvent(event);
  });
  window.removeEventListener(event.type, watch);
  await settle();
  return kept && seen === event && !event.defaultPrevented;
}

const unreachable = (element: Element) =>
  element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true" || getComputedStyle(element).pointerEvents === "none";

describe.each(layerControls)("the built-in %s beneath a layer it did not draw", (name) => {
  it("leaves it the focus, reports nothing for what happens in it, and cancels none of its events", async () => {
    const intents = await drawOpen(name);
    expect(intents).toEqual([]);
    const foreign = await openForeignLayer();
    expect(document.activeElement).toBe(foreign);
    const events = [
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      new FocusEvent("focusin", { bubbles: true }),
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 }),
    ];
    const held: string[] = [];
    for (const event of events) if (!(await neutral(foreign, event))) held.push(event.type === "keydown" ? (event as KeyboardEvent).key : event.type);
    expect(held).toEqual([]);
    expect(document.activeElement).toBe(foreign);
    expect(intents).toEqual([]);
  });

  it("leaves it the focus it took before the built-in layer settled", async () => {
    const intents = draw(name);
    const foreign = placeForeignLayer();
    await settle();
    expect([document.activeElement === foreign, intents]).toEqual([true, []]);
  });

  it("makes none of it unreachable", async () => {
    await drawOpen(name);
    const foreign = await openForeignLayer();
    const blocked: string[] = [];
    for (let at: Element | null = foreign; at; at = at.parentElement) if (unreachable(at)) blocked.push(at.tagName.toLowerCase());
    expect(blocked).toEqual([]);
  });
});
