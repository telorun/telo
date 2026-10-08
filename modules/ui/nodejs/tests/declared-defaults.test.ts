import type { ResourceContext } from "@telorun/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import * as placements from "../src/filter-placement.js";
import * as FiltersController from "../src/filters-controller.js";
import * as surfaces from "../src/surface-controllers.js";
import * as TableController from "../src/table-controller.js";

type Schema = Record<string, any>;

const docs: Schema[] = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" }).map(
  (doc) => doc.toJS(),
);
const declared = (name: string): Schema => {
  const found = docs.find((doc) => doc.metadata?.name === name);
  if (!found) throw new Error(`the manifest declares no '${name}'`);
  return found.schema;
};

/** Every `default:` a schema declares, at the member that declares it. */
function defaultsOf(schema: Schema): Schema {
  const defaults: Schema = {};
  for (const [name, property] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
    if ("default" in property) defaults[name] = property.default;
    else if (property.properties && Object.keys(defaultsOf(property)).length > 0) defaults[name] = defaultsOf(property);
  }
  return defaults;
}

const ctx = { resolveRef: (value: unknown) => value, lookupSchema: () => undefined } as unknown as ResourceContext;
const resource = (config: Schema = {}) => ({ kind: "Ui.Fixture", metadata: { name: "fixture" }, ...config }) as never;
const provided = async (controller: { create: (...args: any[]) => Promise<any> }, config?: Schema): Promise<Schema> =>
  (await controller.create(resource(config), ctx)).provide();

describe("a default the manifest declares", () => {
  it.each(["Dialog", "Drawer", "Popover", "InlineSurface", "Panel"] as const)("is what %s provides for a member left out", async (kind) => {
    const { type, ...members } = await provided(surfaces[`${kind}Controller`]);
    expect(members).toEqual(defaultsOf(declared(kind)));
  });

  it.each(["AbovePlacement", "AsidePlacement", "CollapsiblePlacement"] as const)("is what %s provides for a member left out", async (kind) => {
    const { type, ...members } = await provided(placements[`${kind}Controller`]);
    expect(members).toEqual(defaultsOf(declared(kind)));
  });

  it("is what a filter bar carries for a policy member, a field member and a state member left out", async () => {
    const bar = (policy?: Schema) =>
      provided(FiltersController, {
        model: { type: "object", properties: { text: { type: "string" } } },
        collection: { query: { filters: [{ property: "text", operator: "contains" }], sort: [] } },
        fields: [{ property: "text", operator: "contains", pinned: undefined, control: undefined, default: undefined }],
        content: { type: "text", text: "Todos" },
        policy,
      });
    const { state, ...policy } = defaultsOf(declared("FilterPolicy"));
    // Members holding nothing, as a template forwards absent ones.
    for (const written of [undefined, { show: undefined, placement: undefined, controls: undefined, apply: undefined, summary: undefined, state: undefined }]) {
      const { node } = await bar(written);
      expect({ show: node.show, controls: node.controls, apply: node.apply, summary: node.summary }).toEqual(policy);
      const { type, ...placement } = node.placement;
      expect([type, placement]).toEqual(["above", defaultsOf(declared("AbovePlacement"))]);
      expect(node.state).toEqual({ address: false, store: { type: "memory" } });
      const { pinned, control } = node.fields[0];
      expect({ pinned, control }).toEqual(defaultsOf(declared("Filters").properties.fields.items));
    }
    const store = { provide: async () => ({ type: "local" }) };
    const { node } = await bar({ state: { key: "todos", address: undefined, store } });
    expect({ address: node.state.address }).toEqual(state);
  });

  it("is what a table's opener carries when it names only its form", async () => {
    const form = { provide: async () => ({ node: { type: "form" }, assets: [] }) };
    const { node } = await provided(TableController, {
      model: { type: "object", properties: {} },
      collection: { query: { filters: [], sort: [] } },
      source: { basePath: "/api/todos" },
      create: { form, surface: undefined, afterSubmit: undefined, unsaved: undefined },
      edit: { form },
    });
    const { type, ...dialog } = node.create.surface;
    expect(type).toBe("dialog");
    expect(dialog).toEqual(defaultsOf(declared("Dialog")));
    expect(node.edit.surface).toEqual(node.create.surface);
    expect([node.create.afterSubmit, node.edit.afterSubmit]).toEqual([declared("AfterCreate").default, declared("AfterEdit").default]);
    expect([node.create.unsaved, node.edit.unsaved]).toEqual([declared("UnsavedInput").default, declared("UnsavedInput").default]);
  });
});
