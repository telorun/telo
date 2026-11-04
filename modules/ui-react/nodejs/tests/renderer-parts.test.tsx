// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../src/browser/app.js";
import controls from "../src/contract/controls.json" with { type: "json" };
import { runScene, type Scene, type SceneHost } from "../src/contract/interpreter.js";
import contract from "../src/contract/parts.json" with { type: "json" };
import data from "../src/contract/scenes.json" with { type: "json" };
import { uiTexts } from "./ui-texts.js";

// The markdown renderer is a chunk fetched on first use; transforming it is slower than a scene waits.
await import("../src/browser/markdown/markdown-view.js");

const listed = Object.values(contract.parts).flat();
const scenes = data.scenes as unknown as Scene[];
const texts = data.texts as unknown as Record<string, unknown>;

/** The renderer, mounted as a page mounts it. */
const renderer: SceneHost = (root, loadModule) => {
  const rendered = mount(root, { loadModule });
  return () => rendered.unmount();
};

/** The parts a built-in control may carry each documented state on. */
function controlStates(): { attribute: string; values: string[]; parts: string[] }[] {
  return Object.values(controls.controls).flatMap((control) =>
    control.states.map((state) => ({
      attribute: state.attribute,
      values: state.values,
      parts: state.on.flatMap((on) =>
        on === "$root" ? control.roots : on.startsWith("$") ? ((control as { namedParts?: Record<string, string[]> }).namedParts?.[on.slice(1)] ?? []) : [on],
      ),
    })),
  );
}

describe("the styling contract", () => {
  it("is drawn by scenes written with ui's own texts as ui declares them", () => {
    expect(texts).toEqual(uiTexts());
  });

  // One test per scene, so each is bounded on its own rather than all of them by one timeout.
  describe("is emitted whole by the scenes, and nothing outside it is", () => {
    const seen = new Set<string>();
    const qualified = contract.reserved.flatMap((entry) => (entry.state === undefined ? [] : [entry.state]));
    /** Each part seen carrying the state of a qualified reservation, as `<part> <attribute>=<value>`. */
    const carrying = new Set<string>();
    const collect = () => {
      for (const element of document.querySelectorAll("[data-telo-part]")) {
        const part = element.getAttribute("data-telo-part") as string;
        seen.add(part);
        for (const { attribute, value } of qualified) if (element.getAttribute(attribute) === value) carrying.add(`${part} ${attribute}=${value}`);
      }
    };
    for (const scene of scenes) {
      it(`scene '${scene.name}'`, async () => {
        expect(await runScene({ window, scene, texts, mount: renderer, afterStep: collect })).toEqual([]);
      });
    }
    it("every part listed, and only those", () => {
      expect([...seen].filter((part) => !listed.includes(part))).toEqual([]);
      expect(listed.filter((part) => !seen.has(part))).toEqual([]);
    });
    it("every part a state-qualified reservation reaches, carrying that state", () => {
      const states = contract.states as Record<string, { values: string[]; on: string[] }>;
      const reached = contract.reserved.flatMap(({ part, state }) =>
        state === undefined ? [] : (part === undefined ? states[state.attribute].on : [part]).map((each) => `${each} ${state.attribute}=${state.value}`),
      );
      expect([...new Set(reached)].filter((key) => !carrying.has(key))).toEqual([]);
    });
  });

  it("lists exactly the states the renderer and its built-in controls set", async () => {
    const scene = scenes.find((each) => each.compact === true) as Scene;
    const own = contract.states as Record<string, { values: string[]; on: string[] }>;
    const governed = [...new Set([...Object.keys(own), ...controls.stateAttributes])];
    const ofControls = controlStates();
    const problems: string[] = [];
    let carried = new Set<string>();
    const judge = () => {
      carried = new Set();
      for (const attribute of governed) {
        for (const carrier of document.querySelectorAll(`[${attribute}]`)) {
          // A closing copy of a layer is no element of the page.
          if (carrier.closest("body > [inert]:not([data-telo-layer]):not([data-telo-mount])")) continue;
          const part = carrier.getAttribute("data-telo-part") as string;
          const value = carrier.getAttribute(attribute) as string;
          const drawn = own[attribute];
          if (drawn?.on.includes(part) && drawn.values.includes(value)) {
            carried.add(attribute);
            continue;
          }
          // Where a floating list was placed is the control's to report, and no contract term.
          if ((attribute === "data-side" || attribute === "data-align") && !drawn?.on.includes(part)) continue;
          const documented =
            (attribute === "data-state" && contract.partStates.some((entry) => entry.on.includes(part) && entry.values.includes(value))) ||
            ofControls.some((state) => state.attribute === attribute && state.parts.includes(part) && state.values.includes(value));
          if (!documented) problems.push(`${attribute}=${JSON.stringify(value)} on '${part}'`);
        }
      }
    };
    expect(await runScene({ window, scene, texts, mount: renderer, afterStep: (step) => step === scene.steps.length - 1 && judge() })).toEqual([]);
    expect(problems).toEqual([]);
    expect(Object.keys(own).filter((attribute) => !carried.has(attribute))).toEqual([]);
  });
});
