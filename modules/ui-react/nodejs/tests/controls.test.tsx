// @vitest-environment happy-dom
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import contract from "../src/contract/controls.json" with { type: "json" };
import vectors from "../src/contract/vectors.json" with { type: "json" };
import { runVector, withElements, type ControlVectors, type ElementSpec, type VectorHost } from "../src/contract/interpreter.js";
import { BUILT_IN_CONTROLS } from "../src/browser/controls/index.js";

/** An element the interpreter describes, as React draws it. */
const node = (spec: ElementSpec): ReactNode => createElement(spec.element, spec.attributes, spec.text, ...(spec.children ?? []).map(node));

const children = (value: unknown): ReactNode =>
  Array.isArray(value) ? createElement(Fragment, null, ...(value as ElementSpec[]).map(node)) : node(value as ElementSpec);

/** Draws a control with React into the interpreter's container, as the renderer would. */
const reactHost =
  (Control: ComponentType<any>) =>
  (container: HTMLElement): VectorHost => {
    const root = createRoot(container);
    return {
      render: ({ children: given, ...props }) =>
        root.render(createElement(Control, { ...(withElements(props, node) as object), ...(given === undefined ? {} : { children: children(given) }) })),
      unmount: () => root.unmount(),
    };
  };

const sets = vectors as Record<string, ControlVectors>;

describe("the controls contract", () => {
  it("has a built-in and vectors for every control of the generation", () => {
    const names = Object.keys(contract.controls).sort();
    expect(Object.keys(BUILT_IN_CONTROLS).sort()).toEqual(names);
    expect(Object.keys(sets).sort()).toEqual(names);
  });
});

describe.each(Object.entries(sets))("the built-in %s", (name, set) => {
  it.each(set.vectors.map((vector) => [vector.name, vector] as const))("%s", async (_, vector) => {
    const Control = BUILT_IN_CONTROLS[name as keyof typeof BUILT_IN_CONTROLS] as ComponentType<any>;
    expect(await runVector({ window, control: name, base: set.props, vector, host: reactHost(Control) })).toEqual([]);
  });
});
