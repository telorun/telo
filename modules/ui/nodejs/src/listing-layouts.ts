import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { isComponentExport } from "./component-export-controller.js";
import { mergeAssets, type AssetFile, type SpecNode } from "./composite.js";
import { layoutProblems, type GroupingConfig, type ReadKeys, type SpanConfig } from "./layout-fit.js";
import type { LayoutInputs, LayoutInstance } from "./listing-layout.js";
import { modelShape, propertiesOf } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import { readPlan } from "./read-plan.js";
import { NOTHING } from "./request-failure.js";
import type { Binding } from "./row-binding.js";
import { pendingRowAction, providedRowActions, type RowActionConfig } from "./row-actions.js";

/** What a layout draws, `reads` aside, and the files a browser loads for it. */
interface Drawn {
  spec: SpecNode;
  assets: AssetFile[][];
}

type Draw<R> = (resource: R, inputs: LayoutInputs, ctx: ResourceContext, owner: string) => Promise<Drawn>;

/**
 * A layout kind's controller: called by a listing, it answers why it cannot
 * draw that listing's records — the twins of its `UI_LAYOUT_*` referrer rules —
 * or the spec, its read plan with every default filled.
 */
function layoutController<R extends RuntimeResource>(kind: string, keysOf: (resource: R) => ReadKeys, draw: Draw<R>) {
  return {
    async create(resource: R, ctx: ResourceContext): Promise<ResourceInstance & LayoutInstance> {
      const owner = `Ui.${kind} '${resource.metadata.name}'`;
      return {
        async invoke(inputs: LayoutInputs) {
          const keys = keysOf(resource);
          const problems = layoutProblems(keys, inputs);
          if (problems.length > 0) return { problems, assets: [] };
          const reads = readPlan(keys, inputs, { ctx, owner });
          const { spec, assets } = await draw(resource, inputs, ctx, owner);
          return { problems: [], spec: { ...spec, reads }, assets: mergeAssets(...assets) };
        },
      };
    },
  };
}

/** The node drawn per record, over `row`: the one written, else the record's
 *  values, one per model property but the collection's key. */
async function recordContent(written: AuthoredNode | null | undefined, inputs: LayoutInputs, ctx: ResourceContext, owner: string) {
  const tree: AuthoredNode = written ?? {
    type: "stack",
    children: propertiesOf(inputs.model)
      .filter(([name]) => name !== inputs.collection.key)
      .map(([name]): AuthoredNode => ({ type: "value", value: { root: "row", path: [name] } })),
  };
  const row = modelShape(inputs.model, { ctx, owner }, "model");
  const resolved = await resolveNode(tree, ctx, `${owner} content`, { row });
  return { node: resolved?.node ?? NOTHING, assets: resolved?.assets ?? [] };
}

/** A move as a renderer receives it, its action provided; nothing when none is declared. */
async function recordMove(move: RowActionConfig | null | undefined, ctx: ResourceContext, owner: string) {
  if (move == null) return { assets: [] as AssetFile[][] };
  const { rowActions, assets } = await providedRowActions([pendingRowAction(move, ctx, owner, "move")]);
  return { move: rowActions[0], assets };
}

type ContentResource = RuntimeResource & { content?: AuthoredNode | null };
type MovingResource = ContentResource & { move?: RowActionConfig | null };

/** `content` and `move`, as every layout drawing records with them carries them. */
async function drawnRecords(type: string, resource: MovingResource, inputs: LayoutInputs, ctx: ResourceContext, owner: string, own: Record<string, unknown> = {}): Promise<Drawn> {
  const content = await recordContent(resource.content, inputs, ctx, owner);
  const { move, assets } = await recordMove(resource.move, ctx, owner);
  return { spec: { type, ...own, content: content.node, ...(move ? { move } : {}) }, assets: [content.assets, ...assets] };
}

export const ListLayoutController = layoutController<ContentResource>("ListLayout", () => ({}), (resource, inputs, ctx, owner) =>
  drawnRecords("list", resource, inputs, ctx, owner),
);

export const CardLayoutController = layoutController<ContentResource & { size?: "small" | "medium" | "large" | null }>(
  "CardLayout",
  () => ({}),
  (resource, inputs, ctx, owner) => drawnRecords("cards", resource, inputs, ctx, owner, { size: resource.size ?? "medium" }),
);

export const BoardLayoutController = layoutController<MovingResource & { groups: GroupingConfig }>(
  "BoardLayout",
  (resource) => ({ groups: resource.groups }),
  (resource, inputs, ctx, owner) => drawnRecords("board", resource, inputs, ctx, owner),
);

export const CalendarLayoutController = layoutController<MovingResource & { span: SpanConfig; period?: "month" | "week" | "day" | null }>(
  "CalendarLayout",
  (resource) => ({ span: resource.span }),
  (resource, inputs, ctx, owner) => drawnRecords("calendar", resource, inputs, ctx, owner, { period: resource.period ?? "month" }),
);

export const TimelineLayoutController = layoutController<
  MovingResource & { span: SpanConfig; groups?: GroupingConfig | null; scale?: "day" | "week" | "month" | "quarter" | null }
>(
  "TimelineLayout",
  (resource) => ({ span: resource.span, groups: resource.groups }),
  (resource, inputs, ctx, owner) => drawnRecords("timeline", resource, inputs, ctx, owner, { scale: resource.scale ?? "month" }),
);

export const TreeLayoutController = layoutController<MovingResource & { parent: string }>(
  "TreeLayout",
  (resource) => ({ parent: resource.parent }),
  (resource, inputs, ctx, owner) => drawnRecords("tree", resource, inputs, ctx, owner),
);

type ComponentLayoutResource = RuntimeResource &
  ReadKeys & { component: unknown; props?: Record<string, Binding> | null; move?: RowActionConfig | null };

export const ComponentLayoutController = layoutController<ComponentLayoutResource>(
  "ComponentLayout",
  (resource) => ({ groups: resource.groups, span: resource.span, parent: resource.parent }),
  async (resource, inputs, ctx, owner) => {
    const { assets, ...exported } = await ctx
      .resolveRef(resource.component, isComponentExport, () => `'component' of ${owner}`, "Ui.ComponentExport")
      .provide();
    const moved = await recordMove(resource.move, ctx, owner);
    return {
      spec: { type: "component", ...exported, props: resource.props ?? {}, ...(moved.move ? { move: moved.move } : {}) },
      assets: [assets, ...moved.assets],
    };
  },
);
