import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModuleViewData, Selection } from "../model";
import { DetailPanel } from "./DetailPanel";

/**
 * The panel shows the SELECTION. With nothing selected it peeks at the resource
 * instead — which is worth having while the peek is at something else, and is
 * pure duplication once the peek and the canvas beside it are the same
 * resource. Drilling in selects what it focuses, so that was the ordinary case:
 * the boot list rendered a second time beside the boot list.
 */

const loopSchema = {
  type: "object",
  properties: {
    condition: { title: "Condition", type: "boolean" },
    steps: { title: "Steps", "x-telo-topology-role": "steps", type: "array" },
  },
};

const viewData = {
  manifest: {
    kind: "Application",
    metadata: { name: "app" },
    resources: [
      { kind: "Run.Loop", name: "poll", fields: { condition: true }, sourceFile: "/t.yaml" },
      { kind: "Sql.Query", name: "lookup", fields: {}, sourceFile: "/t.yaml" },
    ],
    targets: [],
    imports: [],
  },
  kinds: new Map([
    ["Run.Loop", { fullKind: "Run.Loop", schema: loopSchema, capability: "Telo.Runnable" }],
    ["Sql.Query", { fullKind: "Sql.Query", schema: { type: "object", properties: {} }, capability: "Telo.Invocable" }],
  ]),
  importedConfig: new Map(),
  sourceFiles: [],
} as unknown as ModuleViewData;

const loop = { kind: "Run.Loop", name: "poll" };

function panel(props: {
  selectedResource: { kind: string; name: string } | null;
  canvasResource: { kind: string; name: string } | null;
  selection?: Selection | null;
}) {
  return render(
    <DetailPanel
      selectedResource={props.selectedResource}
      canvasResource={props.canvasResource}
      selection={props.selection ?? null}
      viewData={viewData}
      registry={null}
      readOnly={false}
      onSourceEdit={() => undefined}
      onExtractInline={() => undefined}
      onInlineReference={() => undefined}
      onUpdateResource={() => undefined}
      onSelectResource={() => undefined}
      onSelect={() => undefined}
      onCreateAndLink={() => undefined}
    />,
  );
}

describe("detail panel vs the canvas beside it", () => {
  it("renders nothing when the canvas is already this resource and nothing is selected", () => {
    const { container } = panel({ selectedResource: loop, canvasResource: loop });
    expect(container).toBeEmptyDOMElement();
  });

  it("still peeks when the selected resource is NOT the one on the canvas", () => {
    // A leaf clicked from a list, a mount clicked under its server: the panel is
    // the only thing showing it, so the peek is the whole point.
    const { container } = panel({
      selectedResource: { kind: "Sql.Query", name: "lookup" },
      canvasResource: loop,
    });
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText("lookup")).toBeTruthy();
  });

  it("still peeks when no canvas resolved at all", () => {
    const { container } = panel({ selectedResource: loop, canvasResource: null });
    expect(container).not.toBeEmptyDOMElement();
  });

  it("opens once a property IS selected, canvas or not", () => {
    // What the property rail emits: scoped to the resource root, one property.
    const { container } = panel({
      selectedResource: loop,
      canvasResource: loop,
      selection: {
        resource: loop,
        pointer: "",
        schema: { type: "object", properties: { condition: loopSchema.properties.condition } },
      },
    });
    expect(container).not.toBeEmptyDOMElement();
    // The form for that one property — the label appears more than once (field
    // label plus its control's), so presence is what is asserted, not a count.
    expect(screen.getAllByText("Condition").length).toBeGreaterThan(0);
  });

  it("opens for a pointer-scoped selection too — a step, a binding entry", () => {
    const { container } = panel({
      selectedResource: loop,
      canvasResource: loop,
      selection: {
        resource: loop,
        pointer: "/steps/0",
        schema: { type: "object", properties: {} },
      },
    });
    expect(container).not.toBeEmptyDOMElement();
  });

  it("ignores a selection belonging to another resource", () => {
    // Stale selection after the canvas moved on: it is not this resource's, so
    // it cannot keep the panel open over a canvas already showing everything.
    const { container } = panel({
      selectedResource: loop,
      canvasResource: loop,
      selection: {
        resource: { kind: "Sql.Query", name: "lookup" },
        pointer: "",
        schema: { type: "object", properties: { a: {} } },
      },
    });
    expect(container).toBeEmptyDOMElement();
  });
});
