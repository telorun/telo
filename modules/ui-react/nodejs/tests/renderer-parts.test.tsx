// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import contract from "../src/contract/parts.json" with { type: "json" };
import { loadFixtureComponents, render, type Rendered } from "./harness.js";
import { component, filtersNode, tableNode, todos } from "./spec-nodes.js";

const listed = Object.values(contract.parts).flat();
let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const emitted = () => new Set([...document.querySelectorAll("[data-telo-part]")].map((element) => element.getAttribute("data-telo-part") as string));

describe("the styling contract", () => {
  it("is emitted whole, and nothing outside it is", async () => {
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos, "/api/empty": [] },
      pages: {
        "/": {
          title: "Everything",
          children: [
            { type: "stack", style: ["strong"], children: [{ type: "text", text: "Heading", style: "heading" }, { type: "badge", text: "New" }] },
            { type: "columns", children: [{ type: "box", children: [{ type: "link", text: "Docs", href: "/docs" }] }, { type: "image", src: "/logo.png", alt: "" }] },
            { type: "svg", markup: "<svg xmlns='http://www.w3.org/2000/svg'/>", alt: "Chart" },
            filtersNode(tableNode()),
            tableNode({ basePath: "/api/empty" }),
            component("Counter", { step: { value: 1 } }),
            { type: "error", code: "ERR_EXAMPLE", message: "An error node." },
          ],
        },
      },
    });
    const seen = emitted();
    // Open each dialog, and refuse a submission, to reach the parts they hold.
    await rendered.click(rendered.part("table-create"));
    for (const part of emitted()) seen.add(part);
    await rendered.click(rendered.part("submit"));
    for (const part of emitted()) seen.add(part);
    rendered.answer("/api/todos", () => new Response(JSON.stringify({ details: [{ location: "body", path: "elsewhere", message: "is refused" }] }), { status: 400 }));
    await rendered.enter(rendered.part("input"), "Long enough");
    await rendered.click(rendered.part("submit"));
    for (const part of emitted()) seen.add(part);
    await rendered.open(rendered.part("select"));
    for (const part of emitted()) seen.add(part);
    await rendered.escape();
    await rendered.click(rendered.part("dialog-close"));
    // The confirmation has parts of its own, and a focused icon button its tooltip.
    await rendered.click(rendered.part("row-delete"));
    for (const part of emitted()) seen.add(part);
    await rendered.click(rendered.part("cancel"));
    await rendered.focus(rendered.part("row-edit"));
    for (const part of emitted()) seen.add(part);
    // A table whose first page has not arrived shows the loading part.
    rendered.unmount();
    rendered = await render({
      path: "/",
      pages: { "/": { title: "Slow", children: [tableNode()] } },
      answers: { "/api/todos": () => new Promise<Response>(() => {}) },
    });
    for (const part of emitted()) seen.add(part);
    expect([...seen].filter((part) => !listed.includes(part))).toEqual([]);
    expect(listed.filter((part) => !seen.has(part))).toEqual([]);
  });

  it("lists exactly the states the renderer sets", async () => {
    rendered = await render({
      path: "/",
      loadModule: loadFixtureComponents,
      collections: { "/api/todos": todos },
      pages: { "/": { title: "States", children: [filtersNode(tableNode()), component("Counter", { step: { value: 1 } })] }, "/other": { title: "Other", children: [] } },
    });
    await rendered.click(rendered.parts("table-sort")[0]);
    await rendered.click(rendered.part("table-create"));
    await rendered.click(rendered.part("submit"));
    await rendered.open(rendered.part("select"));
    for (const [attribute, { values, on }] of Object.entries(contract.states)) {
      const carriers = [...document.querySelectorAll(`[${attribute}]`)].filter((carrier) => on.includes(carrier.getAttribute("data-telo-part") as string));
      expect(carriers.length, attribute).toBeGreaterThan(0);
      for (const carrier of carriers) expect(values, attribute).toContain(carrier.getAttribute(attribute));
    }
    // Every other carrier is a primitive's, with the primitive's own values.
    const stated = [...document.querySelectorAll("[data-state]")].filter((carrier) => !contract.states["data-state"].on.includes(carrier.getAttribute("data-telo-part") as string));
    expect(stated.length).toBeGreaterThan(0);
    for (const carrier of stated) {
      const part = carrier.getAttribute("data-telo-part");
      const primitive = contract.primitiveStates.find((entry) => entry.on.includes(part as string));
      expect(primitive, `data-state on '${part}'`).toBeDefined();
      expect(primitive?.values).toContain(carrier.getAttribute("data-state"));
    }
    for (const attribute of ["data-invalid", "data-sorted", "data-current"] as const) {
      for (const carrier of document.querySelectorAll(`[${attribute}]`)) expect(contract.states[attribute].on, attribute).toContain(carrier.getAttribute("data-telo-part"));
    }
  });
});
