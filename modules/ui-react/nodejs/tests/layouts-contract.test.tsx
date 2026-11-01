// @vitest-environment happy-dom
import { createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { BUILT_IN_LAYOUTS } from "../src/browser/layouts/contract-layout.js";
import * as layoutsModule from "../src/browser/layouts/contract-layout.js";
import { WordsContext } from "../src/browser/texts.js";
import { runLayoutVector, withElements, type ControlVectors, type ElementSpec, type VectorHost } from "../src/contract/interpreter.js";
import vectors from "../src/contract/layout-vectors.json" with { type: "json" };
import contract from "../src/contract/layouts.json" with { type: "json" };
import { englishWords } from "./words.js";

/** An element the interpreter describes, as React draws it. */
const node = (spec: ElementSpec): ReactNode => createElement(spec.element, spec.attributes, spec.text, ...(spec.children ?? []).map(node));

/** Draws a built-in layout into the interpreter's container, inside the renderer's words as the listing draws it. */
const reactHost =
  (Layout: ComponentType<any>) =>
  (container: HTMLElement): VectorHost => {
    const root = createRoot(container);
    return {
      render: (props) => root.render(createElement(WordsContext.Provider, { value: englishWords }, createElement(Layout, withElements(props, node) as object))),
      unmount: () => root.unmount(),
    };
  };

const sets = vectors as unknown as Record<string, ControlVectors>;

describe("the layouts contract", () => {
  it("has a built-in and vectors for every layout of the generation, each exported under its name", () => {
    const names = Object.keys(contract.layouts).sort();
    expect(Object.keys(BUILT_IN_LAYOUTS).sort()).toEqual(names);
    expect(Object.keys(sets).sort()).toEqual(names);
    expect(Object.entries(contract.layouts).map(([type, layout]) => BUILT_IN_LAYOUTS[type].name)).toEqual(Object.values(contract.layouts).map((layout) => layout.export));
    expect(typeof layoutsModule.ContractLayout).toBe("function");
  });
});

describe.each(Object.entries(sets))("the built-in %s layout", (name, set) => {
  it.each(set.vectors.map((vector) => [vector.name, vector] as const))("%s", async (_, vector) => {
    expect(await runLayoutVector({ window, layout: name, base: set.props, vector, host: reactHost(BUILT_IN_LAYOUTS[name]) })).toEqual([]);
  });
});
