import { makeTaggedSentinel } from "@telorun/templating";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleViewData, Selection } from "../model";
import { DetailPanel } from "./DetailPanel";

/**
 * A resource declared INLINE at a ref slot has no name, so every surface that
 * keys on one misses it: the slot rendered as an empty picker over an authored
 * declaration. It is addressed by WHERE it is written instead — the host plus a
 * pointer — which is the shape a selection already has.
 */

const serverSchema = {
  type: "object",
  properties: {
    mounts: {
      title: "Mounts",
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { title: "Path", type: "string" },
          mount: {
            title: "Mount",
            "x-telo-ref": { kind: "Telo.Mount", use: "dependency" },
          },
        },
      },
    },
  },
};

const crudSchema = {
  type: "object",
  properties: {
    plural: { title: "Plural", type: "string" },
    singular: { title: "Singular", type: "string" },
  },
};

const inlineMount = {
  kind: "Crud.Resource",
  plural: "todos",
  singular: "todo",
  model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
};

// Shaped like an `Http.Api` route's `returns:`: the annotation that makes each
// entry's `when` an expression sits on the ARRAY, an ancestor of the row a
// selection lands on.
const returnEntrySchema = {
  type: "object",
  properties: {
    status: { title: "Status", type: "integer" },
    when: { title: "When", type: "boolean" },
  },
};

const apiSchema = {
  type: "object",
  properties: {
    routes: {
      title: "Routes",
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { title: "Path", type: "string" },
          returns: {
            title: "Returns",
            type: "array",
            "x-telo-context": { type: "object", properties: { result: { type: "object" } } },
            items: returnEntrySchema,
          },
        },
      },
    },
  },
};

const withReturns = { kind: "Http.Api", name: "routes" };

const viewData = {
  manifest: {
    kind: "Application",
    metadata: { name: "app" },
    resources: [
      {
        kind: "Http.Server",
        name: "api",
        fields: { mounts: [{ path: "/api/todos", mount: inlineMount }] },
        sourceFile: "/t.yaml",
      },
      {
        kind: "Http.Api",
        name: "routes",
        fields: { routes: [{ path: "/todos", returns: [{ status: 200, when: true }] }] },
        sourceFile: "/t.yaml",
      },
      // The same slot the other way round: a reference to a named resource, and
      // the resource it names.
      {
        kind: "Http.Server",
        name: "gateway",
        fields: {
          mounts: [
            { path: "/api/todos", mount: makeTaggedSentinel("ref", "todos") },
            { path: "/unfilled" },
          ],
        },
        sourceFile: "/t.yaml",
      },
      {
        kind: "Crud.Resource",
        name: "todos",
        fields: { plural: "todos", singular: "todo" },
        sourceFile: "/t.yaml",
      },
    ],
    targets: [],
    imports: [],
  },
  kinds: new Map([
    ["Http.Server", { fullKind: "Http.Server", schema: serverSchema, capability: "Telo.Service" }],
    ["Crud.Resource", { fullKind: "Crud.Resource", schema: crudSchema, capability: "Telo.Mount" }],
    ["Http.Api", { fullKind: "Http.Api", schema: apiSchema, capability: "Telo.Mount" }],
  ]),
  importedConfig: new Map(),
  sourceFiles: [],
} as unknown as ModuleViewData;

const host = { kind: "Http.Server", name: "api" };

function panel(
  selection: Selection | null,
  onSelect = vi.fn(),
  onInlineReference = vi.fn(),
) {
  render(
    <DetailPanel
      selectedResource={selection?.resource ?? host}
      canvasResource={null}
      selection={selection}
      viewData={viewData}
      registry={null}
      readOnly={false}
      onSourceEdit={() => undefined}
      onExtractInline={() => undefined}
      onInlineReference={onInlineReference}
      onUpdateResource={() => undefined}
      onSelectResource={() => undefined}
      onSelect={onSelect}
      onCreateAndLink={() => undefined}
    />,
  );
  return { onSelect, onInlineReference };
}

const mountItem: Selection = {
  resource: host,
  pointer: "/mounts/0",
  schema: serverSchema.properties.mounts.items,
};

const inlineSelection: Selection = {
  resource: host,
  pointer: "/mounts/0/mount",
  schema: serverSchema.properties.mounts.items.properties.mount,
};

afterEach(() => {
  cleanup();
});

describe("DetailPanel inline resources", () => {
  it("names the inline declaration in the slot instead of an empty picker", () => {
    panel(mountItem);
    expect(screen.getByTitle("Open this inline resource")).toHaveTextContent("Crud.Resource");
  });

  it("selects the inline resource by its own path", () => {
    const { onSelect } = panel(mountItem);
    fireEvent.click(screen.getByTitle("Open this inline resource"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ resource: host, pointer: "/mounts/0/mount" }),
    );
  });

  it("renders the inline resource against its OWN kind's schema", () => {
    // The selection carries the SLOT's schema — a ref annotation, off which no
    // form can be drawn. The panel resolves the kind named in the value.
    panel(inlineSelection);
    expect(screen.getByDisplayValue("todos")).toBeInTheDocument();
    expect(screen.getByDisplayValue("todo")).toBeInTheDocument();
  });

  it("shows the inline kind as what is being edited", () => {
    panel(inlineSelection);
    expect(screen.getByText("Crud.Resource")).toBeInTheDocument();
    expect(screen.getByText("api • /mounts/0/mount")).toBeInTheDocument();
  });

  it("offers the tag picker for a predicate whose region is on an ancestor", () => {
    // The panel renders the ROW, so `routes[].returns`'s `x-telo-context` — the
    // annotation that makes `when` an expression — is nowhere in the rendered
    // subtree. Without replaying the walk down the pointer the field is a bare
    // checkbox with no way to write the CEL it exists to hold.
    panel({
      resource: withReturns,
      pointer: "/routes/0/returns/0",
      schema: returnEntrySchema,
    });
    expect(screen.getAllByTitle("How this value is written").length).toBeGreaterThan(0);
  });

  it("names the extraction in the header only while the declaration is selected", () => {
    panel(inlineSelection);
    expect(screen.getByText("Extract")).toBeInTheDocument();
    cleanup();
    panel(mountItem);
    expect(screen.queryByText("Extract")).not.toBeInTheDocument();
  });

  it("offers the extraction at the slot, without opening the declaration", () => {
    // The move is a property of the SLOT, so the parent's own form is enough to
    // make it — reaching it from inside the declaration costs a navigation.
    panel(mountItem);
    fireEvent.click(screen.getByTitle("Extract to its own resource and reference it here"));
    expect(screen.getByText("Extract Crud.Resource to a resource")).toBeInTheDocument();
  });

  it("offers inlining at a slot holding a reference", () => {
    const { onInlineReference } = panel({
      resource: { kind: "Http.Server", name: "gateway" },
      pointer: "/mounts/0",
      schema: serverSchema.properties.mounts.items,
    });
    fireEvent.click(screen.getByTitle("Inline that resource's declaration into this slot"));
    expect(onInlineReference).toHaveBeenCalledWith(
      { kind: "Http.Server", name: "gateway" },
      "/mounts/0/mount",
    );
  });

  it("offers neither move at an empty slot", () => {
    panel({
      resource: { kind: "Http.Server", name: "gateway" },
      pointer: "/mounts/1",
      schema: serverSchema.properties.mounts.items,
    });
    expect(
      screen.queryByTitle("Inline that resource's declaration into this slot"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("Extract to its own resource and reference it here"),
    ).not.toBeInTheDocument();
  });
});
