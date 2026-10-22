// @vitest-environment happy-dom
import { createElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "../src/browser/app.js";
import controls from "../src/contract/controls.json" with { type: "json" };
import { runScene, type Scene, type SceneHost } from "../src/contract/interpreter.js";
import data from "../src/contract/scenes.json" with { type: "json" };

/** A control drawn as one element marked with its name, carrying the part the renderer gave it. */
const stub =
  (name: string) =>
  (props: { part?: string; parts?: { root: string }; children?: ReactNode }): ReactElement => {
    const fixed = (controls.controls as Record<string, { roots: string[] }>)[name].roots[0];
    const part = props.part ?? props.parts?.root ?? fixed;
    // An anchored control draws the renderer's element it is given; an overlay holds the renderer's content.
    if (name === "Menu" || name === "Tooltip") return createElement("span", { "data-stub": name }, props.children);
    return createElement("span", { "data-stub": name, "data-telo-part": part }, props.children);
  };

const STUBS = "/_telo/ui/assets/stubs/controls.js";
const names = Object.keys(controls.controls);
const stubs = Object.fromEntries(names.map((name) => [name, stub(name)]));

/** Parts the renderer draws itself as well as a control: a field's label, an in-flow surface. */
const SHARED = new Set(["label", "surface"]);
const controlParts = new Set(
  Object.values(controls.controls)
    .flatMap((control) => [...control.roots, ...control.subParts, ...Object.values((control as { namedParts?: Record<string, string[]> }).namedParts ?? {}).flat()])
    .filter((part) => !SHARED.has(part)),
);

const renderer: SceneHost = (root, loadModule) => {
  const rendered = mount(root, { loadModule });
  return () => rendered.unmount();
};

describe("a theme implementing every control", () => {
  it("is what draws every part a control owns, in every scene", async () => {
    const drawn = new Set<string>();
    const strays: string[] = [];
    const look = () => {
      for (const element of document.querySelectorAll("[data-telo-part]")) {
        const part = element.getAttribute("data-telo-part") as string;
        if (controlParts.has(part) && !element.hasAttribute("data-stub")) strays.push(part);
      }
      for (const element of document.querySelectorAll("[data-stub]")) drawn.add(element.getAttribute("data-stub") as string);
    };
    for (const scene of data.scenes as unknown as Scene[]) {
      const problems = await runScene({
        window,
        scene,
        words: data.words,
        mount: renderer,
        controls: { stylesheets: {}, sets: [{ module: STUBS, exports: names }] },
        load: (url) => (url === STUBS ? Promise.resolve(stubs) : undefined),
        steps: false,
        afterStep: look,
      });
      expect(problems, scene.name).toEqual([]);
    }
    expect(strays).toEqual([]);
    expect([...drawn].sort()).toEqual(
      // What the scenes draw before anything is done on them: forms open at their address, no question asked yet.
      [
        "Checkbox", "DateInput", "DateRangeInput", "Dialog", "Drawer", "Icon", "Menu", "MultiSelect", "NumberInput", "OptionGroup", "Select",
        "Slider", "Switch", "TagsInput", "TextArea", "TextInput", "Tooltip",
      ].sort(),
    );
  });
});
