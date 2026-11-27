// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import controls from "../../../ui-react/nodejs/src/contract/controls.json" with { type: "json" };
import vectors from "../../../ui-react/nodejs/src/contract/vectors.json" with { type: "json" };
import { prepareWindow, runVector, withElements, type ControlVectors, type ElementSpec, type VectorHost } from "../../../ui-react/nodejs/src/contract/interpreter.js";
import type { ToastItem } from "../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { Dialog, Drawer, Popover } from "../src/controls/overlays.js";
import { Select } from "../src/controls/select.js";
import { Toaster } from "../src/controls/toaster.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Radix set's toaster beside the primitives' stack: a layer outside it,
 * which Escape, a press and the focus inside it never reach, and which a modal
 * primitive neither hides nor makes unpressable, its trap letting the focus in
 * only through F8.
 */
const node = (spec: ElementSpec): ReactNode => createElement(spec.element, spec.attributes, spec.text, ...(spec.children ?? []).map(node));

const vectorHost =
  (container: HTMLElement): VectorHost => {
    const drawn = createRoot(container);
    return {
      render: (props) => drawn.render(createElement(Toaster, withElements(props, node) as any)),
      unmount: () => drawn.unmount(),
    };
  };

describe("the Radix set's toaster meets the contract's vectors", () => {
  expect(Object.keys(controls.controls)).toContain("Toaster");
  const set = (vectors as Record<string, ControlVectors>).Toaster;
  it.each(set.vectors.map((vector) => [vector.name, vector] as const))("%s", async (_, vector) => {
    expect(await runVector({ window, control: "Toaster", base: set.props, vector, host: vectorHost })).toEqual([]);
  });
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};

interface Page {
  reported: unknown[][];
  pressed: string[];
  blurred: number;
  draw(layer?: ReactNode): Promise<void>;
}

/** The page's own button, then the toaster holding one toast, and whatever layer is open over them. */
async function page(): Promise<Page> {
  prepareWindow(window);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const state: Page = {
    reported: [],
    pressed: [],
    blurred: 0,
    draw: async (layer) => {
      await act(async () =>
        root!.render(
          createElement(
            "div",
            null,
            createElement("button", { id: "page" }, "Page"),
            createElement(Toaster, {
              items: [toast(() => state.pressed.push("undo"))],
              side: "bottom",
              align: "end",
              label: "Notifications",
              dismissLabel: "Dismiss",
              onDismiss: (...args: unknown[]) => state.reported.push(["onDismiss", ...args]),
              onPauseChange: () => {},
            }),
            layer,
          ),
        ),
      );
      await settle();
    },
  };
  await state.draw();
  return state;
}

const toast = (undo: () => void): ToastItem => ({
  key: "archived",
  tone: "success",
  children: [
    createElement("p", { key: "text", "data-telo-part": "toast-text" }, "Apollo archived."),
    createElement("div", { key: "actions", "data-telo-part": "toast-actions" }, createElement("button", { id: "undo", onClick: undo }, "Undo")),
  ],
});

const surfaceChildren = (state: Page) => [
  createElement("h2", { key: "title", id: "title" }, "Edit"),
  createElement("input", { key: "field", id: "field", onBlur: () => state.blurred++ }),
  createElement("button", { key: "save", id: "save" }, "Save"),
];

const intent = (state: Page, name: string) => (...args: unknown[]) => state.reported.push([name, ...args]);

function modalDialog(state: Page) {
  return createElement(
    Dialog as ComponentType<any>,
    { open: true, modal: true, labelledBy: "title", attributes: { "data-surface": "dialog", "data-modal": "true" }, onOpenChange: intent(state, "dialog") },
    surfaceChildren(state),
  );
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const toaster = () => document.querySelector('[data-telo-part="toaster"]') as HTMLElement;

async function key(target: Element, name: string, shift = false): Promise<boolean> {
  let kept = true;
  await act(async () => {
    kept = target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true }));
  });
  await settle();
  return kept;
}

/** A pointer press as a browser makes it: down, the focus to what it landed on, up, click. */
async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.focus();
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    element.click();
  });
  await settle();
}

async function focus(element: HTMLElement) {
  await act(async () => element.focus());
  await settle();
}

const tabbable = () =>
  [...document.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")].filter(
    (element) => element.tabIndex >= 0 && !element.closest("[inert]"),
  );

/** Tab as a browser moves it where nothing kept it: to the next element in the page's order. */
async function tab(shift: boolean) {
  const at = document.activeElement as HTMLElement;
  if (!(await key(at, "Tab", shift))) return;
  const order = tabbable();
  const next = order[(order.indexOf(at) + (shift ? -1 : 1) + order.length) % order.length];
  await focus(next);
}

describe("the Radix set's toaster outside the stack", () => {
  it("leaves Escape in a modal dialog to the dialog, which closes while the toast stays", async () => {
    const state = await page();
    await state.draw(modalDialog(state));
    await focus(byId("field"));
    await key(byId("field"), "Escape");
    expect(state.reported).toEqual([["dialog", false, "escape"]]);
  });

  it("takes the focus out of a modal dialog's trap on F8, dismisses only the focused toast on Escape and gives the focus back to the field F8 left, which blurred", async () => {
    const state = await page();
    await state.draw(modalDialog(state));
    await focus(byId("field"));
    await key(byId("field"), "F8");
    expect([document.activeElement === toaster(), state.blurred]).toEqual([true, 1]);
    await key(toaster(), "Tab");
    expect(document.activeElement).toBe(byId("undo"));
    await key(byId("undo"), "Escape");
    expect(state.reported).toEqual([["onDismiss", "archived", "escape"]]);
    expect(document.activeElement).toBe(byId("field"));
  });

  it("keeps Tab and a press from moving the focus into it under a modal dialog, the press still running its call", async () => {
    const state = await page();
    await state.draw(modalDialog(state));
    await focus(byId("field"));
    await tab(true);
    await tab(true);
    await tab(true);
    expect(document.querySelector('[data-telo-part="surface"]')!.contains(document.activeElement)).toBe(true);
    await focus(byId("field"));
    await press(byId("undo"));
    expect([document.activeElement === byId("field"), state.pressed, state.reported]).toEqual([true, ["undo"], []]);
  });

  it.each([
    [
      "a non-modal drawer",
      (state: Page) =>
        createElement(
          Drawer as ComponentType<any>,
          { open: true, modal: false, side: "end", labelledBy: "title", attributes: { "data-surface": "drawer" }, onOpenChange: intent(state, "drawer") },
          surfaceChildren(state),
        ),
    ],
    [
      "a popover",
      (state: Page) =>
        createElement(
          Popover as ComponentType<any>,
          { open: true, anchor: byId("page"), side: "bottom", attributes: { "data-surface": "popover" }, onOpenChange: intent(state, "popover") },
          surfaceChildren(state),
        ),
    ],
    [
      "an open select list",
      (state: Page) =>
        createElement(Select as ComponentType<any>, {
          id: "choice",
          label: "Status",
          part: "select",
          options: [{ key: "open", label: "Open" }],
          value: "",
          placeholder: "Choose",
          noneLabel: "None",
          open: true,
          loading: false,
          hasMore: false,
          invalid: false,
          required: false,
          disabled: false,
          onOpenChange: intent(state, "select"),
          onChange: intent(state, "select"),
        }),
    ],
  ])("closes no layer when its button is pressed or focused with %s open", async (_, layer) => {
    const state = await page();
    await state.draw(layer(state));
    await press(byId("undo"));
    await focus(byId("undo"));
    expect([state.pressed, state.reported]).toEqual([["undo"], []]);
  });

  it("is neither hidden nor made unpressable by a modal dialog opened while a toast is up", async () => {
    const state = await page();
    await state.draw(modalDialog(state));
    const blocked: string[] = [];
    // The primitive turns presses off on `<body>`; the toasts turn them back on.
    for (let at: Element | null = toaster(); at; at = at.parentElement) {
      if (at.hasAttribute("inert") || at.getAttribute("aria-hidden") === "true") blocked.push(at.tagName.toLowerCase());
    }
    for (const element of document.querySelectorAll('[data-telo-part="toast"]')) if (element.closest('[aria-hidden="true"], [inert]')) blocked.push("toast");
    for (const element of document.querySelectorAll('[data-telo-part="toast"], [data-telo-part="toast"] *')) {
      if (getComputedStyle(element).pointerEvents === "none" && element.closest("button") === null) blocked.push(element.tagName.toLowerCase());
    }
    expect(blocked).toEqual([]);
    for (const button of document.querySelectorAll('[data-telo-part="toast"] button')) expect(getComputedStyle(button).pointerEvents).not.toBe("none");
    await press(byId("undo"));
    expect(state.pressed).toEqual(["undo"]);
  });
});

describe("the Radix set's toaster's swipe", () => {
  const swipe = async (toast: HTMLElement, moves: number[]) => {
    const translated: string[] = [];
    await act(async () => {
      toast.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
      for (const clientX of moves) {
        toast.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX }));
        translated.push(toast.style.translate);
      }
      toast.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: moves.at(-1) }));
    });
    return translated;
  };

  it("moves a toast with the pointer and dismisses it with close once dragged far enough", async () => {
    const state = await page();
    const toast = document.querySelector<HTMLElement>('[data-telo-part="toast"]')!;
    expect(await swipe(toast, [20])).toEqual(["20px 0"]);
    expect(state.reported).toEqual([]);
    expect(await swipe(toast, [30, 80])).toEqual(["30px 0", "80px 0"]);
    expect(state.reported).toEqual([["onDismiss", "archived", "close"]]);
  });

  it("moves nothing where the person prefers reduced motion, and still dismisses", async () => {
    const held = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const state = await page();
      const toast = document.querySelector<HTMLElement>('[data-telo-part="toast"]')!;
      expect(await swipe(toast, [30, 80])).toEqual(["", ""]);
      expect(state.reported).toEqual([["onDismiss", "archived", "close"]]);
    } finally {
      window.matchMedia = held;
    }
  });
});
