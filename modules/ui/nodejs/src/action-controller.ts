import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import {
  enterableFields,
  headerOf,
  isEnterable,
  itemsOf,
  labelOf,
  modelSchema,
  modelShape,
  presentation,
  schemaAt,
  type JsonSchema,
  type Shape,
} from "./model-schema.js";
import { isChain, type Binding } from "./row-binding.js";

/** A list drawn from the answer. A member holding nothing is one left out. */
interface ListConfig {
  heading?: string;
  rows: Binding;
  columns: { header?: string; value: Binding }[];
}

type ActionResource = RuntimeResource & {
  inputModel: unknown;
  outputModel?: unknown;
  source: { path: string };
  label: string;
  fields?: { property: string }[];
  lists?: ListConfig[];
};

/** What whoever runs an action without its form needs of it. */
export interface Operation {
  path: string;
  label: string;
  /** The input model. */
  schema: JsonSchema;
  drawsLists: boolean;
}

export interface ActionInstance {
  operation(): Operation;
}

export function isAction(candidate: unknown): candidate is ActionInstance {
  return typeof (candidate as ActionInstance | null)?.operation === "function";
}

/** The fields an action shows — the ones listed, or every property a control
 *  can enter — which between them enter every property the model requires. */
export function actionFields(
  schema: JsonSchema,
  listed: { property: string }[] | undefined,
  owner: string,
): { property: string; label: string }[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const fields = listed
    ? listed.map(({ property }, index) => {
        if (!Object.hasOwn(properties, property)) {
          throw new RuntimeError(
            "ERR_UI_ACTION_FIELD_UNKNOWN_PROPERTY",
            `${owner}: 'fields[${index}]' lists a field for a property the input model does not declare ('${property}'). Use a property of 'inputModel', or add this one to it.`,
          );
        }
        if (!isEnterable(properties[property])) {
          throw new RuntimeError(
            "ERR_UI_ACTION_FIELD_UNSUPPORTED",
            `${owner}: 'fields[${index}]' lists a field for a property no control can enter ('${property}'). A field enters a string, a number, a boolean, one of an 'enum', or a list of those: remove this field, or give the operation a property of such a type.`,
          );
        }
        return { property, label: labelOf(property, properties[property]) };
      })
    : enterableFields(schema);
  const missing = ((Array.isArray(schema.required) ? schema.required : []) as string[]).filter(
    (required) => !fields.some((field) => field.property === required),
  );
  if (missing.length > 0) {
    throw new RuntimeError(
      "ERR_UI_ACTION_REQUIRED_INPUT_NOT_ENTERED",
      `${owner}: leaves a property the input model requires with no field (${missing.map((name) => `'${name}'`).join(", ")}), so the operation could never be sent a valid record. List a field for every required property, or leave 'fields' out where each one is a scalar or a list of scalars.`,
    );
  }
  return fields;
}

class Action implements ResourceInstance, ActionInstance {
  private readonly owner: string;

  constructor(
    private readonly resource: ActionResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `Ui.Action '${resource.metadata.name}'`;
  }

  operation(): Operation {
    return {
      path: this.resource.source.path,
      label: this.resource.label,
      schema: modelSchema(this.resource.inputModel, this.ctx, this.owner, "inputModel"),
      drawsLists: (this.resource.lists ?? []).length > 0,
    };
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const { path, label, schema } = this.operation();
    const reader = { ctx: this.ctx, owner: this.owner };
    const answer =
      resource.outputModel == null
        ? undefined
        : modelShape(modelSchema(resource.outputModel, this.ctx, this.owner, "outputModel"), reader, "outputModel");
    const lists = (resource.lists ?? []).map((list) => {
      const rowsAt = isChain(list.rows) ? ["outputModel", ...list.rows.path].join(".") : "";
      const rows = isChain(list.rows) && answer ? schemaAt(answer, list.rows.path, reader, "outputModel") : undefined;
      const row = rows && itemsOf(rows, reader, rowsAt);
      const shapeAt = (value: { root: string; path: string[] }): Shape | undefined => {
        if (value.root === "row") return row && schemaAt(row, value.path, reader, `${rowsAt}.items`);
        return answer && schemaAt(answer, value.path, reader, "outputModel");
      };
      return {
        ...(list.heading != null ? { heading: list.heading } : {}),
        rows: list.rows,
        columns: list.columns.map(({ header, value }) => {
          if (!isChain(value)) return { header: header ?? "", value };
          const target = shapeAt(value);
          const last = value.path[value.path.length - 1];
          const present = presentation(target);
          return {
            header: header ?? (last === undefined ? "" : headerOf(last, target)),
            value,
            ...(present ? { present } : {}),
          };
        }),
      };
    });
    const node: SpecNode = {
      type: "action",
      schema,
      path,
      label,
      fields: actionFields(schema, resource.fields ?? undefined, this.owner),
      lists,
    };
    return { node, assets: [] };
  }
}

export async function create(resource: ActionResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Action(resource, ctx);
}
