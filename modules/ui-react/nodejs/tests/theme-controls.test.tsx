// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "./harness.js";
import { formNode } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const SET = "/_telo/ui/assets/set/controls.js";

/** A page holding a form, which draws a select, beside a text drawn by no control. */
const show = (load: (url: string) => Promise<Record<string, unknown>>, stylesheets: Record<string, string> = {}, exports = ["Select"]) =>
  render({
    path: "/",
    loadModule: load,
    controls: { stylesheets, sets: [{ module: SET, exports }] },
    pages: { "/": { title: "Themed", children: [formNode(), { type: "text", text: "Still drawn" }] } },
  });

const codes = (r: Rendered) => r.parts("error-code").map((code) => code.textContent);

describe("a theme's control set", () => {
  it("draws the controls it implements, and the built-ins everywhere else", async () => {
    const Select = ({ part, id }: { part: string; id: string }) => createElement("button", { "data-telo-part": part, id, "data-theme": "select" });
    rendered = await show(async (url) => (url === SET ? { Select } : {}));
    expect(rendered.part("select").getAttribute("data-theme")).toBe("select");
    expect(rendered.part("input").hasAttribute("data-theme")).toBe(false);
    expect(codes(rendered)).toEqual([]);
  });

  it("draws ERR_UI_THEME_CONTROL_LOAD_FAILED where a control of a set that did not load is drawn", async () => {
    rendered = await show(async () => {
      throw new Error("offline");
    });
    expect(codes(rendered)).toEqual(["ERR_UI_THEME_CONTROL_LOAD_FAILED"]);
    expect(rendered.part("error-message").textContent).toBe(`The theme's control 'Select' could not be loaded from '${SET}': offline`);
    // The node drawing it is the error; every other node is drawn.
    expect([rendered.parts("form"), rendered.part("text").textContent]).toEqual([[], "Still drawn"]);
  });

  it("fails nothing that does not draw a control of a set that did not load", async () => {
    rendered = await show(
      async () => {
        throw new Error("offline");
      },
      {},
      ["TimeInput", "Dialog"],
    );
    expect([codes(rendered), rendered.parts("form").length]).toEqual([[], 1]);
  });

  it("draws ERR_UI_THEME_CONTROL_LOAD_FAILED where a control its set names but does not export is drawn", async () => {
    rendered = await show(async () => ({}));
    expect(codes(rendered)).toEqual(["ERR_UI_THEME_CONTROL_LOAD_FAILED"]);
    expect(rendered.part("error-message").textContent).toBe(`The theme's control 'Select' could not be loaded: '${SET}' exports no control of that name.`);
  });

  it("draws ERR_UI_THEME_CONTROL_FAILED in the node drawing a control that throws", async () => {
    const Select = () => {
      throw new Error("broken");
    };
    rendered = await show(async () => ({ Select }));
    expect(codes(rendered)).toEqual(["ERR_UI_THEME_CONTROL_FAILED"]);
    expect(rendered.part("error-message").textContent).toBe("The theme's control 'Select' failed: broken");
    expect(rendered.part("text").textContent).toBe("Still drawn");
  });

  it("is drawn with the mechanics stylesheet of each built-in the document names", async () => {
    rendered = await show(async () => ({}), { Checkbox: "/_telo/ui/assets/mm/checkbox.css" });
    const links = [...document.head.querySelectorAll("link[data-telo-stylesheet]")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/_telo/ui/assets/aa/base.css", "/_telo/ui/assets/mm/checkbox.css"]);
  });
});
