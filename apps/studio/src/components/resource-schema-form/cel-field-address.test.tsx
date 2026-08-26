import { makeTaggedSentinel } from "@telorun/templating";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldPointer } from "../../lib/json-pointer";
import { pointerToConcretePath } from "../../lib/concrete-path";
import { ResourceSchemaForm } from "./index";

// Monaco does not run under jsdom. The editor is swapped for a textarea that
// reports the address it was handed — which is the thing worth asserting: the
// scope a completion offers is resolved for that address, so a wrong one offers
// names from another field.
vi.mock("./cel-expression-editor", () => ({
  CelExpressionEditor: ({
    value,
    target,
  }: {
    value: string;
    target: { resource: { kind: string; name: string }; path: string };
  }) => (
    <textarea
      data-testid="cel-editor"
      data-path={target.path}
      data-resource={`${target.resource.kind}/${target.resource.name}`}
      value={value}
      readOnly
    />
  ),
}));

afterEach(cleanup);

const schema = {
  type: "object",
  properties: {
    routes: {
      type: "array",
      "x-telo-context": { type: "object" },
      items: {
        type: "object",
        properties: { when: { title: "When", type: "boolean" } },
      },
    },
    plain: { title: "Plain", type: "string", "x-telo-eval": "runtime" },
  },
};

const target = { resource: { kind: "Http.Api", name: "routes" }, pointer: "/mounts/0/mount" };

describe("the address a CEL field is completed for", () => {
  it("composes the form's scope with the field's own path", () => {
    render(
      <ResourceSchemaForm
        schema={schema}
        values={{ routes: [{ when: makeTaggedSentinel("cel", "req.") }] }}
        onChange={() => undefined}
        celTarget={target}
      />,
    );
    const editor = screen.getByTestId("cel-editor");
    expect(editor).toHaveAttribute("data-path", "mounts[0].mount.routes[0].when");
    expect(editor).toHaveAttribute("data-resource", "Http.Api/routes");
  });

  it("edits an expression as plain text when the host cannot say where it sits", () => {
    // No address, no scope — offering candidates would be guessing.
    render(
      <ResourceSchemaForm
        schema={schema}
        values={{ plain: makeTaggedSentinel("cel", "x") }}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByTestId("cel-editor")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("x")).toBeInTheDocument();
  });

  it("keeps the plain input for tags a CEL scope says nothing about", () => {
    render(
      <ResourceSchemaForm
        schema={schema}
        values={{ plain: makeTaggedSentinel("literal", "Hello ${{ x }}") }}
        onChange={() => undefined}
        celTarget={target}
      />,
    );
    expect(screen.queryByTestId("cel-editor")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Hello ${{ x }}")).toBeInTheDocument();
  });
});

describe("the address grammar", () => {
  it("joins a form scope and a field path into one pointer", () => {
    expect(fieldPointer("/mounts/0/mount", "routes.0.when")).toBe("/mounts/0/mount/routes/0/when");
    expect(fieldPointer("", "port")).toBe("/port");
    expect(fieldPointer("/steps/1", "")).toBe("/steps/1");
  });

  it("converts a pointer to the spelling the analyzer addresses a site by", () => {
    expect(pointerToConcretePath("/routes/0/returns/1/when")).toBe("routes[0].returns[1].when");
    expect(pointerToConcretePath("")).toBe("");
    expect(pointerToConcretePath("/port")).toBe("port");
  });
});
