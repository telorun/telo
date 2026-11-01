import type { ResourceContext } from "@telorun/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import * as placements from "../src/filter-placement.js";
import * as navigation from "../src/navigation.js";
import { DateRangeFieldController, InputFieldController } from "../src/field-controllers.js";
import * as FiltersController from "../src/filters-controller.js";
import * as CollectionOptionsController from "../src/option-source.js";
import * as surfaces from "../src/surface-controllers.js";
import * as CollectionPresentationController from "../src/collection-presentation.js";
import * as ListingController from "../src/listing-controller.js";
import * as TableLayoutController from "../src/table-layout.js";
import { BoardLayoutController, CalendarLayoutController, CardLayoutController, TimelineLayoutController } from "../src/listing-layouts.js";

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

const facts = (filters: Schema[] = [], model: Schema = { type: "object", properties: {} }) => ({
  model,
  key: "id",
  query: { filters, sort: [], facets: [] },
  relations: {},
});
const source = (basePath: string, collection: Schema = facts()) => ({ basePath, collection: () => collection });
const presentation = (basePath: string, collection: Schema = facts()) => ({
  presentation: () => ({ basePath, collection, relations: {} }),
});

describe("a default the manifest declares", () => {
  it.each(["Dialog", "Drawer", "Popover", "InlineSurface", "Panel"] as const)("is what %s provides for a member left out", async (kind) => {
    const { type, ...members } = await provided(surfaces[`${kind}Controller`]);
    expect(members).toEqual(defaultsOf(declared(kind)));
  });

  it.each(["AbovePlacement", "CollapsiblePlacement"] as const)("is what %s provides for a member left out", async (kind) => {
    const { type, ...members } = await provided(placements[`${kind}Controller`]);
    expect(members).toEqual(defaultsOf(declared(kind)));
  });

  it("is what AsidePlacement provides for a member left out, its compact a collapsible placement with its defaults", async () => {
    const { type, compact, ...members } = await provided(placements.AsidePlacementController);
    expect(members).toEqual(defaultsOf(declared("AsidePlacement")));
    expect(compact).toEqual(await provided(placements.CollapsiblePlacementController));
  });

  it("is what a filter bar carries for a policy member, a field member and a state member left out", async () => {
    const bar = (policy?: Schema) =>
      provided(FiltersController, {
        presentation: presentation(
          "/api/todos",
          facts([{ property: "text", operator: "contains" }], { type: "object", properties: { text: { type: "string" } } }),
        ),
        fields: [{ property: "text", operator: "contains", pinned: undefined, control: undefined, values: undefined, default: undefined }],
        content: { type: "text", text: "Todos" },
        policy,
      });
    const policy = defaultsOf(declared("FilterPolicy"));
    // Members holding nothing, as a template forwards absent ones.
    for (const written of [undefined, { show: undefined, placement: undefined, controls: undefined, apply: undefined, summary: undefined, state: undefined }]) {
      const { node } = await bar(written);
      expect({ show: node.show, controls: node.controls, apply: node.apply, summary: node.summary }).toEqual(policy);
      const { type, ...placement } = node.placement;
      expect([type, placement]).toEqual(["above", defaultsOf(declared("AbovePlacement"))]);
      expect(node.state).toEqual({ address: false, store: { type: "memory" }, fields: ["text"] });
      const { pinned, control, values } = node.fields[0];
      expect({ pinned, control, values }).toEqual(defaultsOf(declared("Filters").properties.fields.items));
    }
    const store = { provide: async () => ({ type: "local" }) };
    const { node } = await bar({ state: { key: "todos", address: undefined, store } });
    expect({ address: node.state.address }).toEqual(defaultsOf(declared("StateRecord")));
  });

  it("is what a field kind answers for a member left out", async () => {
    const answer = async (controller: { create: (...args: any[]) => Promise<any> }, config: Schema, property: Schema) =>
      (await (await controller.create(resource(config), ctx)).invoke({ model: { type: "object", properties: { at: property } } })).spec;
    const input = await answer(InputFieldController, { property: "at", control: undefined }, { type: "string" });
    expect({ control: input.control }).toEqual(defaultsOf(declared("InputField")));
    const range = await answer(
      DateRangeFieldController,
      { property: "at", presets: [], weekStart: undefined },
      { type: "object", properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
    );
    expect({ weekStart: range.weekStart }).toEqual(defaultsOf(declared("DateRangeField")));
  });

  it("is what an option source sends for a page size left out", async () => {
    const spec = await provided(CollectionOptionsController, {
      model: { type: "object", properties: { id: { type: "string" } } },
      value: { root: "row", path: ["id"] },
      label: { root: "row", path: ["id"] },
      source: source("/api/people", facts([{ property: "id", operator: "in" }])),
      pageSize: undefined,
    });
    expect({ pageSize: spec.pageSize }).toEqual(defaultsOf(declared("CollectionOptions")));
  });

  it("is what a presentation's relation sends for a page size left out", async () => {
    const authors = facts([{ property: "id", operator: "in" }]);
    const posts = { ...facts(), relations: { authorId: {} } };
    const instance = await CollectionPresentationController.create(
      resource({
        source: source("/api/posts", posts),
        relations: { authorId: { source: source("/api/authors", authors), label: { root: "row", path: ["name"] }, pageSize: undefined } },
      }),
      ctx,
    );
    const { relations } = (instance as unknown as { presentation(): Schema }).presentation();
    expect({ pageSize: relations.authorId.pageSize }).toEqual(defaultsOf(declared("Relations").additionalProperties));
  });

  it("is what a listing carries for a member left out", async () => {
    const { node } = await provided(ListingController, {
      presentation: presentation("/api/todos"),
      model: { type: "object", properties: {} },
      pageSize: undefined,
      paging: undefined,
      delete: undefined,
    });
    const { pageSize, paging, delete: remove } = defaultsOf(declared("Listing"));
    expect({ pageSize: node.pageSize, paging: node.paging, delete: node.delete }).toEqual({ pageSize, paging, delete: remove });
  });

  it("is a table layout's with nothing listed, for a listing that names no layout", async () => {
    const model = { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } };
    const listing = (layout?: unknown) => provided(ListingController, { presentation: presentation("/api/todos"), model, layout });
    const table = await TableLayoutController.create(resource({ columns: undefined }), ctx);
    expect(JSON.stringify((await listing()).node)).toBe(JSON.stringify((await listing(table)).node));
  });

  it("is what a layout spec carries for a member left out", async () => {
    const model = {
      type: "object",
      properties: { id: { type: "string" }, status: { enum: ["open", "done"] }, on: { type: "string", format: "date" } },
    };
    const collection = facts(
      [
        { property: "status", operator: "eq" },
        { property: "on", operator: "gte" },
        { property: "on", operator: "lte" },
      ],
      model,
    );
    const spec = async (controller: { create: (...args: any[]) => Promise<any> }, config: Schema) =>
      (await (await controller.create(resource(config), ctx)).invoke({ model, collection, relations: {} })).spec;
    const cards = await spec(CardLayoutController, { size: undefined });
    const calendar = await spec(CalendarLayoutController, { span: { start: "on", end: undefined }, period: undefined });
    const timeline = await spec(TimelineLayoutController, { span: { start: "on" }, groups: undefined, scale: undefined });
    const board = await spec(BoardLayoutController, { groups: { property: "status", values: undefined } });
    expect({ size: cards.size }).toEqual(defaultsOf(declared("CardLayout")));
    expect({ period: calendar.period }).toEqual(defaultsOf(declared("CalendarLayout")));
    expect({ scale: timeline.scale }).toEqual(defaultsOf(declared("TimelineLayout")));
    expect({ values: board.reads.groups.values }).toEqual(defaultsOf(declared("Grouping")));
  });

  it("is what a listing's opener carries when it names only its form", async () => {
    const form = { provide: async () => ({ node: { type: "form" }, assets: [] }) };
    const { node } = await provided(ListingController, {
      model: { type: "object", properties: {} },
      presentation: presentation("/api/todos"),
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

  it("is what a navigation placement provides for a member left out: an overlay drawer from the start edge, under the header", async () => {
    const overlay = await provided(navigation.OverlayNavigationController);
    const { type, ...drawer } = overlay.surface;
    expect([overlay.type, type]).toEqual(["overlay", "drawer"]);
    expect(drawer).toEqual({ ...defaultsOf(declared("Drawer")), side: "start" });
    expect(await provided(navigation.HeaderNavigationController)).toEqual({ type: "header", compact: overlay });
  });

  it("is what a sidebar provides for a member left out: no rail, memory, and a drawer from its own side", async () => {
    const { type, compact, store, ...members } = await provided(navigation.SidebarNavigationController, { side: "end" });
    expect([type, store]).toEqual(["sidebar", { type: "memory" }]);
    const { rail: railDefaults, ...defaults } = defaultsOf(declared("SidebarNavigation"));
    expect(members).toEqual({ ...defaults, side: "end" });
    expect(compact).toEqual({ type: "overlay", surface: { ...(await provided(surfaces.DrawerController)), side: "end" } });
    const { rail } = await provided(navigation.SidebarNavigationController, { rail: { collapsed: undefined } });
    expect(rail).toEqual(railDefaults);
  });

  it("is what a tab bar provides for a member left out: a drawer from the bottom edge", async () => {
    const { type, surface, ...members } = await provided(navigation.TabBarNavigationController);
    expect(type).toBe("tab-bar");
    expect(members).toEqual(defaultsOf(declared("TabBarNavigation")));
    expect(surface).toEqual({ ...(await provided(surfaces.DrawerController)), side: "bottom" });
  });

  it("is what an application's navigation is when it declares none: each page in order, in the header", async () => {
    const page = (path: string) => ({ snapshot: () => ({ path, title: { text: path }, query: {} }), invoke: async () => ({}), assets: () => [] });
    const noIcon = async (): Promise<string> => {
      throw new Error("no entry names an icon");
    };
    const prepared = await navigation.preparedNavigation(undefined, [page("/"), page("/b")] as never, ctx, "the app", noIcon);
    expect(navigation.deliveredNavigation(prepared.items)).toEqual([
      { type: "page", key: "entry", path: "/", text: { text: "/" } },
      { type: "page", key: "b", path: "/b", text: { text: "/b" } },
    ]);
    expect(prepared.placement).toEqual(await provided(navigation.HeaderNavigationController));
  });
});
